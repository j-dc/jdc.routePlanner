import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { balanceRoutes, completeRoutes, createOldGroups, routeCost, serviceTime, splitTrips } from './balance.mjs';

let requestBody = '';
for await (const chunk of process.stdin) requestBody += chunk;
const request = JSON.parse(requestBody);
const { version, driverCount, matrixSha256: expectedHash, inputSha256, capacity, reloadSeconds,
  maxDifferenceMinutes, serviceSeconds: serviceSecondsPerVisit, packageCounts: deliveryCounts, routeLabels } = request;
const maxDifferenceSeconds = maxDifferenceMinutes * 60;
const outputDirectory = process.env.ROUTE_OUTPUT_DIR || '/output';
const apiUrl = process.env.ROUTE_API_URL || 'http://routeplanner-api:8080/';
const suffix = version === 'legacy' ? '' : `-${version}`;
const matrixPath = join(outputDirectory, `matrix${suffix}.json`);
const routePath = join(outputDirectory, `routes${suffix}.json`);
const hash = data => createHash('sha256').update(data).digest('hex').toUpperCase();

function fail(message) { throw new Error(message); }

async function calculate() {
  const matrixBytes = await readFile(matrixPath);
  if (hash(matrixBytes) !== expectedHash) fail('De matrix is gewijzigd. Bereken de routes opnieuw.');
  const input = JSON.parse(matrixBytes);
  const locations = input.metadata?.locations;
  const car = input.matrices?.car;
  if (!Array.isArray(locations) || locations.length < 2 || locations[0].csvRecordNumber !== null ||
      locations.slice(1).some(location => !Number.isSafeInteger(location.csvRecordNumber) || location.csvRecordNumber < 2) ||
      new Set(locations.slice(1).map(location => location.csvRecordNumber)).size !== locations.length - 1 ||
      locations.length - 1 < driverCount || deliveryCounts.length !== locations.length - 1)
    fail('De matrix bevat geen geldige startlocatie of onvoldoende leveringen.');
  const packageCounts = [0, ...deliveryCounts];
  for (const matrix of [car?.durations, car?.distances, car?.costs]) {
    if (!Array.isArray(matrix) || matrix.length !== locations.length ||
        matrix.some(row => !Array.isArray(row) || row.length !== locations.length ||
          row.some(value => !Number.isInteger(value) || value < 0 || value > 4294967295)))
      fail('De matrix heeft ongeldige afmetingen of waarden.');
  }
  if (car.costs.some((row, i) => row.some((value, j) => value !== car.distances[i][j])))
    fail('De matrixkosten komen niet overeen met de afstanden.');
  const locationIds = [0];
  const representatives = new Map();
  for (let index = 1; index < locations.length; index++) {
    const { latitude, longitude } = locations[index];
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180)
      fail('De matrix bevat ongeldige leverlocaties.');
    const key = `${latitude},${longitude}`;
    const representative = representatives.get(key);
    if (representative === undefined) {
      representatives.set(key, index);
      locationIds[index] = index;
    } else {
      for (const matrix of [car.durations, car.distances, car.costs]) {
        if (matrix[index].some((value, target) => value !== matrix[representative][target]) ||
            matrix.some(row => row[index] !== row[representative]))
          fail('De matrix bevat verschillende kosten voor dezelfde locatie.');
      }
      locationIds[index] = representative;
    }
  }
  function solveTrips(indices, vehicleCount) {
    let remaining = indices;
    const trips = [];
    while (remaining.length) {
      const problem = {
        matrices: { car },
        jobs: remaining.map(index => ({
          id: index, location_index: locationIds[index], setup: serviceSecondsPerVisit,
          delivery: [packageCounts[index]]
        })),
        vehicles: Array.from({ length: vehicleCount }, (_, index) => ({
          id: index + 1, profile: 'car', start_index: 0, end_index: 0, capacity: [capacity]
        }))
      };
      const solver = spawnSync('vroom', ['-t', '2', '-x', '4'], {
        input: JSON.stringify(problem), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000
      });
      if (solver.error || solver.status !== 0) fail('VROOM kon de routes niet berekenen.');
      const solution = JSON.parse(solver.stdout);
      if (solution.code !== 0 || !Array.isArray(solution.routes) || !Array.isArray(solution.unassigned) ||
          solution.routes.length > vehicleCount)
        fail('VROOM kon niet alle leveringen toewijzen.');
      const wave = solution.routes.map(route => {
        if (!Array.isArray(route.steps)) fail('VROOM gaf een ongeldige route terug.');
        return route.steps.filter(step => step.type === 'job').map(step => step.id);
      });
      const assigned = wave.flat();
      const unassigned = solution.unassigned.map(item => item.id);
      const expected = new Set(remaining);
      const all = [...assigned, ...unassigned];
      if (wave.some(trip => trip.length === 0 || trip.reduce((sum, index) => sum + packageCounts[index], 0) > capacity) ||
          assigned.length === 0 || all.length !== remaining.length || new Set(all).size !== remaining.length ||
          all.some(index => !Number.isInteger(index) || !expected.has(index)))
        fail('VROOM gaf een onvolledige of ongeldige toewijzing terug.');
      if (wave.some((trip, index) => solution.routes[index].duration !== routeCost(trip, car.durations) ||
          solution.routes[index].setup !== serviceTime(trip, locationIds, serviceSecondsPerVisit)))
        fail('VROOM gaf ongeldige reistijd of levertijd terug; controleer de matrix en de ingestelde levertijd.');
      trips.push(...wave);
      remaining = unassigned;
    }
    return trips;
  }
  let trips = solveTrips(locations.slice(1).map((_, index) => index + 1), driverCount);
  trips = completeRoutes(trips, driverCount, car.durations, locationIds, serviceSecondsPerVisit);
  trips.sort((a, b) => (routeCost(b, car.durations) + serviceTime(b, locationIds, serviceSecondsPerVisit)) -
    (routeCost(a, car.durations) + serviceTime(a, locationIds, serviceSecondsPerVisit)));
  const routes = Array.from({ length: driverCount }, () => []);
  const initialTimes = Array(driverCount).fill(0);
  for (const trip of trips) {
    const driver = initialTimes.indexOf(Math.min(...initialTimes));
    if (routes[driver].length) {
      routes[driver].push(0);
      initialTimes[driver] += reloadSeconds;
    }
    routes[driver].push(...trip);
    initialTimes[driver] += routeCost(trip, car.durations) + serviceTime(trip, locationIds, serviceSecondsPerVisit);
  }
  const balanced = balanceRoutes(routes, car.durations, car.distances, locationIds, serviceSecondsPerVisit,
    packageCounts, capacity, reloadSeconds, maxDifferenceSeconds);
  const balancedIndices = balanced.routes.flat().filter(index => index !== 0);
  if (balanced.routes.length !== driverCount || balanced.routes.some(route => route.length === 0) ||
      balancedIndices.length !== locations.length - 1 || new Set(balancedIndices).size !== locations.length - 1 ||
      balancedIndices.some(index => !Number.isInteger(index) || index < 1 || index >= locations.length) ||
      balanced.routes.some((route, index) => splitTrips(route).some(trip => trip.length === 0 ||
          trip.reduce((sum, item) => sum + packageCounts[item], 0) > capacity) ||
        routeCost(route, car.durations) + serviceTime(route, locationIds, serviceSecondsPerVisit) +
          (splitTrips(route).length - 1) * reloadSeconds !== balanced.durations[index] ||
        routeCost(route, car.distances) !== balanced.distances[index]))
    fail('De routeberekening gaf een ongeldige verdeling of routekosten terug.');
  const difference = Math.max(...balanced.durations) - Math.min(...balanced.durations);
  if (difference > maxDifferenceSeconds)
    fail(`De berekening vond geen volledige verdeling met maximaal ${maxDifferenceMinutes} minuten verschil in totale duur (gevonden: ${Math.ceil(difference / 60)} minuten).`);
  const oldRoutes = createOldGroups(routeLabels, locations);
  const solvedOldRoutes = oldRoutes && Array.from(oldRoutes.groups, ([driver, indices]) => {
    const trips = solveTrips(indices, 1);
    return [driver, trips.flatMap((trip, index) => index ? [0, ...trip] : trip)];
  });
  const matrixStatus = await fetch(new URL(`api/versions/${version}/matrix-calculation`, apiUrl), { signal: AbortSignal.timeout(15000) });
  const settingsResponse = await fetch(new URL(`api/versions/${version}/settings`, apiUrl), { signal: AbortSignal.timeout(15000) });
  if (!matrixStatus.ok || !settingsResponse.ok) fail('De actuele matrix of instellingen konden niet worden gecontroleerd.');
  const status = await matrixStatus.json();
  const settings = await settingsResponse.json();
  const configuredService = settings.settings?.serviceSeconds;
  const currentServiceSeconds = configuredService === undefined ? 60 :
    typeof configuredService === 'string' && /^[0-9]+$/.test(configuredService) ? Number(configuredService) : NaN;
  const settingNumber = (key, fallback) => settings.settings?.[key] === undefined ? fallback :
    typeof settings.settings[key] === 'string' && /^[0-9]+$/.test(settings.settings[key]) ? Number(settings.settings[key]) : NaN;
  if (status.state !== 'completed' || !/^[0-9]+$/.test(settings.settings?.nmbDrivers || '') ||
      Number(settings.settings.nmbDrivers) !== driverCount || currentServiceSeconds !== serviceSecondsPerVisit ||
      settingNumber('Capacity', 60) !== capacity || settingNumber('reloadSeconds', 10) !== reloadSeconds ||
      settingNumber('maxDifferenceMinutes', 30) !== maxDifferenceMinutes ||
      hash(await readFile(matrixPath)) !== expectedHash)
    fail('De matrix of de instellingen zijn gewijzigd tijdens de berekening.');
  function summarizeRoute(route, driver) {
    const outputTrips = splitTrips(route).map(trip => ({
      packageCount: trip.reduce((sum, item) => sum + packageCounts[item], 0),
      durationSeconds: routeCost(trip, car.durations),
      distanceMeters: routeCost(trip, car.distances),
      stops: trip.map((matrixIndex, stopIndex) => ({
        matrixIndex, csvRecordNumber: locations[matrixIndex].csvRecordNumber,
        packageCount: packageCounts[matrixIndex],
        serviceSeconds: stopIndex === 0 || locationIds[trip[stopIndex - 1]] !== locationIds[matrixIndex]
          ? serviceSecondsPerVisit : 0
      }))
    }));
    const durationSeconds = routeCost(route, car.durations);
    const serviceDurationSeconds = serviceTime(route, locationIds, serviceSecondsPerVisit);
    const reloadDurationSeconds = (outputTrips.length - 1) * reloadSeconds;
    return {
      driver, durationSeconds, serviceDurationSeconds, reloadDurationSeconds,
      totalDurationSeconds: durationSeconds + serviceDurationSeconds + reloadDurationSeconds,
      distanceMeters: routeCost(route, car.distances),
      trips: outputTrips, stops: outputTrips.flatMap(trip => trip.stops)
    };
  }
  const oldSummaries = solvedOldRoutes && solvedOldRoutes.map(([driver, route]) => summarizeRoute(route, driver));
  const output = {
    metadata: {
      version, matrixSha256: expectedHash, inputSha256, driverCount, capacity, reloadSeconds,
      maxAllowedDifferenceSeconds: maxDifferenceSeconds, actualDifferenceSeconds: difference,
      serviceTimeModel: 'per-location-visit-v1', serviceSecondsPerVisit,
      optimization: 'vroom-capacity-multitrip-v1',
      startAndEndIndex: 0
    },
    routes: balanced.routes.map((route, index) => summarizeRoute(route, index + 1)),
    totalDistanceMeters: balanced.distances.reduce((sum, distance) => sum + distance, 0),
    ...(oldSummaries && {
      oldRoutePlan: {
        metadata: { actualDifferenceSeconds: Math.max(...oldSummaries.map(route => route.totalDurationSeconds)) -
          Math.min(...oldSummaries.map(route => route.totalDurationSeconds)) },
        routes: oldSummaries,
        totalDistanceMeters: oldSummaries.reduce((sum, route) => sum + route.distanceMeters, 0),
        unassignedRecords: oldRoutes.unassignedRecords
      }
    })
  };
  const temporary = `${routePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(output), { flag: 'wx' });
    await rename(temporary, routePath);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

try {
  await calculate();
  process.stdout.write(JSON.stringify({ state: 'completed' }));
} catch (error) {
  const message = error instanceof Error && !error.message.includes('\n') &&
    /^(De |VROOM |Onvoldoende )/.test(error.message)
    ? error.message : 'De routeberekening is mislukt. Controleer de matrix en de containerlogs.';
  console.error(`Routeberekening mislukt (${error?.name || 'Error'}).`);
  process.stdout.write(JSON.stringify({ state: 'failed', message }));
  process.exitCode = 1;
}
