import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex').toUpperCase();

function decodeShape(shape) {
  if (typeof shape !== 'string' || !shape.length) throw new Error('Ongeldige routegeometrie.');
  const coordinates = [];
  let index = 0, latitude = 0, longitude = 0;
  while (index < shape.length) {
    const values = [];
    for (let axis = 0; axis < 2; axis++) {
      let value = 0, shift = 0, part;
      do {
        if (index >= shape.length || shift > 30) throw new Error('Ongeldige routegeometrie.');
        part = shape.charCodeAt(index++) - 63;
        if (part < 0 || part > 63) throw new Error('Ongeldige routegeometrie.');
        value |= (part & 31) << shift;
        shift += 5;
      } while (part >= 32);
      values.push((value & 1) ? ~(value >> 1) : value >> 1);
    }
    latitude += values[0];
    longitude += values[1];
    if (Math.abs(latitude) > 90000000 || Math.abs(longitude) > 180000000) throw new Error('Ongeldige routegeometrie.');
    coordinates.push([longitude / 1e6, latitude / 1e6]);
  }
  if (coordinates.length < 2) throw new Error('Ongeldige routegeometrie.');
  return coordinates;
}

export async function getRouteGeometry(version, outputDirectory, valhallaUrl, signal) {
  const versionDirectory = join(outputDirectory, version);
  const routePath = join(versionDirectory, 'routes.json');
  const matrixPath = join(versionDirectory, 'matrix.json');
  const routeBytes = await readFile(routePath);
  const matrixBytes = await readFile(matrixPath);
  const routes = JSON.parse(routeBytes);
  const matrix = JSON.parse(matrixBytes);
  const locations = matrix.metadata?.locations;
  if (routes.metadata?.version !== version || routes.metadata?.matrixSha256 !== digest(matrixBytes) ||
      !Array.isArray(locations) || locations.length < 2 || locations[0].csvRecordNumber !== null ||
      !Array.isArray(routes.routes) || routes.routes.length !== routes.metadata.driverCount)
    throw new Error('Ongeldige route-invoer.');
  const seen = new Set(), drivers = new Set(), requests = [], features = [];
  for (const route of routes.routes) {
    if (!Number.isSafeInteger(route.driver) || route.driver < 1 || drivers.has(route.driver) ||
        !Array.isArray(route.trips) || route.trips.length === 0) throw new Error('Ongeldige route-invoer.');
    drivers.add(route.driver);
    const lines = [], records = [];
    for (const trip of route.trips) {
      if (!Array.isArray(trip.stops) || trip.stops.length === 0) throw new Error('Ongeldige route-invoer.');
      const indices = [0];
      for (const stop of trip.stops) {
        const index = stop.matrixIndex;
        if (!Number.isSafeInteger(index) || index < 1 || index >= locations.length || seen.has(index) ||
            locations[index].csvRecordNumber !== stop.csvRecordNumber) throw new Error('Ongeldige route-invoer.');
        seen.add(index);
        records.push(stop.csvRecordNumber);
        indices.push(index);
      }
      indices.push(0);
      for (let i = 1; i < indices.length; i++) {
        const from = locations[indices[i - 1]], to = locations[indices[i]];
        for (const point of [from, to])
          if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
              !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180)
            throw new Error('Ongeldige route-invoer.');
        if (from.latitude === to.latitude && from.longitude === to.longitude) continue;
        const lineIndex = lines.length;
        lines.push(null);
        requests.push(async () => {
          const response = await fetch(new URL('route', valhallaUrl), {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal,
            body: JSON.stringify({
              locations: [{ lat: from.latitude, lon: from.longitude }, { lat: to.latitude, lon: to.longitude }],
              costing: 'auto', costing_options: { auto: { shortest: true } }, units: 'kilometers'
            })
          });
          if (!response.ok) throw new Error('Valhalla kon een route niet berekenen.');
          const result = await response.json();
          if (result.trip?.status !== 0 || !Array.isArray(result.trip.legs) || result.trip.legs.length !== 1)
            throw new Error('Valhalla gaf een ongeldige route terug.');
          lines[lineIndex] = decodeShape(result.trip.legs[0].shape);
        });
      }
    }
    features.push({ type: 'Feature', properties: { driver: route.driver, records },
      geometry: { type: 'MultiLineString', coordinates: lines } });
  }
  if (seen.size !== locations.length - 1) throw new Error('Ongeldige route-invoer.');
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (next < requests.length) await requests[next++]();
  }));
  if (digest(await readFile(routePath)) !== digest(routeBytes) ||
      digest(await readFile(matrixPath)) !== digest(matrixBytes))
    throw new Error('De routes of matrix zijn gewijzigd.');
  return { type: 'FeatureCollection', features };
}
