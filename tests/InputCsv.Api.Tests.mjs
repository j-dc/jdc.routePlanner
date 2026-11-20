import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const baseUrl = 'http://127.0.0.1:8080';
const header = 'rit;naam;straat;nr.;postcode;gemeente;aantal;bellen;Opmerking;opmerking;klas';
const csv = `${header}\r\n1;Test;"Straat; deel";12;8500;Teststad;1;ja;Eerste notitie;Tweede notitie;`;
let firstVersion;
let secondVersion;
let brokerState = 'idle';
let photonReady = true;
let startCount = 0;
let geometryState = 'idle';
let geometryStartCount = 0;
let matrixState = 'idle';
let matrixInput;
let routeState = 'idle';
let routeInput;
let geometryAvailable = true;
let pdfVersion;
let routeMapState = 'idle';
let routeMapVersion;
async function writeVersionFile(version, name, data) {
  const directory = `/source/${version}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}`, data);
}
const readVersionFile = (version, name) => readFile(`/source/${version}/${name}`);
const services = createServer(async (request, response) => {
  if (request.url === '/photon') {
    response.writeHead(photonReady ? 200 : 503);
    return response.end();
  }
  response.setHeader('content-type', 'application/json');
  if (request.url.startsWith('/matrix/status/')) return response.end(JSON.stringify({ state: matrixState }));
  if (request.url === '/matrix/start') {
    if (matrixState === 'running') {
      response.writeHead(409);
      return response.end('{}');
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    matrixInput = JSON.parse(body);
    matrixState = 'running';
    response.writeHead(202);
    return response.end(JSON.stringify({ state: matrixState }));
  }
  if (request.url.startsWith('/route/status/')) return response.end(JSON.stringify({ state: routeState }));
  if (request.url.startsWith('/route/geometry/')) {
    if (!geometryAvailable) { response.writeHead(503); return response.end('{}'); }
    return response.end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
  }
  if (request.url === '/route/start') {
    if (routeState === 'running') {
      response.writeHead(409);
      return response.end('{}');
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    routeInput = JSON.parse(body);
    routeState = 'running';
    response.writeHead(202);
    return response.end(JSON.stringify({ state: routeState }));
  }
  if (request.url.startsWith('/pdf/status/')) return response.end(JSON.stringify({ state: 'idle' }));
  if (request.url === '/pdf/start') {
    if (!request.headers['content-length']) {
      response.writeHead(411);
      return response.end(JSON.stringify({ message: 'Content-Length required' }));
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    pdfVersion = JSON.parse(body).version;
    response.writeHead(202);
    return response.end(JSON.stringify({ state: 'running' }));
  }
  if (request.url.startsWith('/geometry/status/')) return response.end(JSON.stringify({ state: geometryState }));
  if (request.url.startsWith('/geometry/start/')) {
    if (geometryState === 'running') {
      response.writeHead(409);
      return response.end('{}');
    }
    geometryStartCount++;
    geometryState = 'running';
    response.writeHead(202);
    return response.end(JSON.stringify({ state: geometryState }));
  }
  if (request.url.startsWith('/route-maps/status/')) return response.end(JSON.stringify({ state: routeMapState }));
  if (request.url.startsWith('/route-maps/start/')) {
    if (routeMapState === 'running') {
      response.writeHead(409);
      return response.end('{}');
    }
    routeMapVersion = request.url.slice('/route-maps/start/'.length);
    routeMapState = 'running';
    response.writeHead(202);
    return response.end(JSON.stringify({ state: routeMapState }));
  }
  if (request.url.startsWith('/status/')) return response.end(JSON.stringify({ state: brokerState }));
  if (request.url.startsWith('/start/')) {
    if (brokerState === 'running') {
      response.writeHead(409);
      return response.end('{}');
    }
    startCount++;
    brokerState = 'running';
    response.writeHead(202);
    return response.end(JSON.stringify({ state: brokerState }));
  }
  response.writeHead(404);
  response.end();
});

before(async () => { await new Promise(resolve => services.listen(8181, '127.0.0.1', resolve)); });
after(async () => { await new Promise(resolve => services.close(resolve)); });

async function upload(body, type = 'text/csv') {
  return fetch(`${baseUrl}/api/versions`, { method: 'POST', headers: { 'content-type': type }, body });
}

test('CSV upload creates distinct timestamped versions and rejects invalid input', async () => {
  const first = await upload(csv);
  assert.equal(first.status, 201);
  firstVersion = (await first.json()).id;
  assert.match(firstVersion, /^\d{8}T\d{13}Z$/);
  assert.equal(first.headers.get('location'), `/api/versions/${firstVersion}`);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/versions/${firstVersion}`)).json(), { id: firstVersion });
  assert.equal(await readFile(`/input/ritten-${firstVersion}.csv`, 'utf8'), csv);
  const second = await upload(csv);
  secondVersion = (await second.json()).id;
  assert.notEqual(firstVersion, secondVersion);
  await writeFile('/input/ritten.csv', csv);
  await writeFile('/input/ritten-invalid.csv', csv);
  const versions = await (await fetch(`${baseUrl}/api/versions`)).json();
  assert.ok(versions.includes('legacy'));
  assert.ok(!versions.includes('invalid'));
  assert.deepEqual((await (await fetch(`${baseUrl}/api/versions`)).json()).slice(0, 2), [secondVersion, firstVersion]);
  assert.equal((await upload('wrong;header\nfoo;bar')).status, 400);
  assert.equal((await upload(`${header}\n1;Test;Street`)).status, 400);
  assert.equal((await upload(`${header}\n1;Test;Street;;8500;Teststad;;;;;`)).status, 400);
  assert.equal((await upload(csv, 'application/json')).status, 415);
  assert.equal(await readFile(`/input/ritten-${firstVersion}.csv`, 'utf8'), csv);
});

test('settings and start location can be saved before any output exists', async () => {
  const headers = { 'content-type': 'application/json' };
  for (const first of ['setting', 'location']) {
    const version = (await (await upload(csv)).json()).id;
    const root = `${baseUrl}/api/versions/${version}`;
    const setting = () => fetch(`${root}/settings/nmbDrivers`, {
      method: 'PUT', headers, body: JSON.stringify({ value: '2' })
    });
    const location = () => fetch(`${root}/start-location`, {
      method: 'PUT', headers, body: JSON.stringify({ label: 'Depot', latitude: 50, longitude: 3 })
    });
    const operations = first === 'setting' ? [setting, location] : [location, setting];
    for (const operation of operations) assert.equal((await operation()).status, 200);
    const saved = await (await fetch(`${root}/settings`)).json();
    assert.equal(saved.settings.nmbDrivers, '2');
    assert.equal(saved.startLocation.label, 'Depot');
    assert.equal(saved.startLocation.latitude, 50);
    assert.equal(saved.startLocation.longitude, 3);
    assert.equal(JSON.parse(await readVersionFile(version, 'settings.json')).Settings.nmbDrivers, '2');
  }
});

test('reviews remain isolated and reject reports for different input', async () => {
  const report = {
    createdAtUtc: '2026-01-01T00:00:00Z',
    inputSha256: createHash('sha256').update(csv).digest('hex'),
    totalRecords: 1,
    results: [{ csvRecordNumber: 2, status: 'needs_review', candidates: [] }],
  };
  await writeVersionFile(firstVersion, 'address-check.json', JSON.stringify(report));
  await writeVersionFile(secondVersion, 'address-check.json', JSON.stringify(report));
  assert.equal((await fetch(`${baseUrl}/api/versions/${firstVersion}/review`)).status, 200);
  const updated = await fetch(`${baseUrl}/api/versions/${firstVersion}/review/2`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'unresolved', notes: 'Test' }),
  });
  assert.equal(updated.status, 200);
  const other = await (await fetch(`${baseUrl}/api/versions/${secondVersion}/review`)).json();
  assert.equal(other.records[0].decision, 'pending');
  report.inputSha256 = 'BAD';
  await writeVersionFile(firstVersion, 'address-check.json', JSON.stringify(report));
  const response = await fetch(`${baseUrl}/api/versions/${firstVersion}/review`);
  assert.equal(response.status, 409);
  assert.equal((await fetch(`${baseUrl}/api/versions/not-a-version/review`)).status, 404);
});

test('matrix calculation rejects unknown versions and incomplete or stale reviews', async () => {
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${baseUrl}/api/versions/invalid/matrix-calculation`, request)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/versions/20000101T0000000000000Z/matrix-calculation`, request)).status, 404);
  const response = await fetch(`${baseUrl}/api/versions/${firstVersion}/matrix-calculation`, request);
  assert.equal(response.status, 409);
  assert.equal((await fetch(`${baseUrl}/api/versions/${secondVersion}/matrix-calculation`, request)).status, 409);
});

test('matrix endpoints start a validated snapshot and flag outdated output', async () => {
  const version = (await (await upload(csv)).json()).id;
  const report = {
    createdAtUtc: '2026-01-01T00:00:00Z',
    inputSha256: createHash('sha256').update(csv).digest('hex'),
    totalRecords: 1,
    results: [{ csvRecordNumber: 2, status: 'valid', latitude: 50, longitude: 3,
      candidates: [{ candidateId: 'test', geometryIsValid: true, latitude: 50, longitude: 3 }] }]
  };
  await writeVersionFile(version, 'address-check.json', JSON.stringify(report));
  const url = `${baseUrl}/api/versions/${version}/matrix-calculation`;
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await (await fetch(url)).json()).state, 'idle');
  const missingStart = await fetch(url, post);
  assert.equal(missingStart.status, 409);
  assert.match((await missingStart.json()).detail, /startlocatie/i);
  assert.equal(matrixInput, undefined);
  const review = await (await fetch(`${baseUrl}/api/versions/${version}/review`)).json();
  const oldLocations = [{ csvRecordNumber: 2, latitude: 50, longitude: 3 }];
  const fingerprint = createHash('sha256').update(JSON.stringify(oldLocations)).digest('hex').toUpperCase();
  matrixState = 'completed';
  await writeVersionFile(version, 'matrix.json', JSON.stringify({ metadata: {
    version, reviewFingerprint: review.sourceFingerprint, reviewUpdatedAtUtc: review.updatedAtUtc,
    locationFingerprint: fingerprint, locations: oldLocations
  } }));
  assert.equal((await (await fetch(url)).json()).state, 'stale');
  const routeUrl = `${baseUrl}/api/versions/${version}/route-calculation`;
  assert.equal((await fetch(routeUrl, post)).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/versions/${version}/start-location`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Test', latitude: 50, longitude: 3 })
  })).status, 200);
  assert.equal((await (await fetch(url)).json()).state, 'stale');
  assert.equal((await fetch(url, post)).status, 202);
  const locations = [{ csvRecordNumber: null, latitude: 50, longitude: 3 }, ...oldLocations];
  assert.deepEqual(matrixInput.locations, locations);
  assert.equal((await (await fetch(url)).json()).state, 'running');
  assert.equal((await fetch(url, post)).status, 409);
  matrixState = 'completed';
  const newFingerprint = createHash('sha256').update(JSON.stringify(locations)).digest('hex').toUpperCase();
  const matrix = JSON.stringify({ metadata: {
    version, reviewFingerprint: matrixInput.reviewFingerprint, reviewUpdatedAtUtc: matrixInput.reviewUpdatedAtUtc,
    locationFingerprint: newFingerprint, locations
  } });
  await writeVersionFile(version, 'matrix.json', matrix);
  assert.equal((await (await fetch(url)).json()).state, 'completed');
  assert.equal((await fetch(routeUrl, post)).status, 409);
  const driverUrl = `${baseUrl}/api/versions/${version}/settings/nmbDrivers`;
  const setDrivers = value => fetch(driverUrl, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value })
  });
  assert.equal((await setDrivers('0')).status, 200);
  assert.equal((await fetch(routeUrl, post)).status, 409);
  assert.equal((await setDrivers('1.5')).status, 200);
  assert.equal((await fetch(routeUrl, post)).status, 409);
  assert.equal((await setDrivers('1')).status, 200);
  assert.equal((await fetch(routeUrl, post)).status, 202);
  assert.equal(routeInput.driverCount, 1);
  assert.equal(routeInput.serviceSeconds, 60);
  assert.equal(routeInput.capacity, 60);
  assert.equal(routeInput.reloadSeconds, 10);
  assert.equal(routeInput.maxDifferenceMinutes, 30);
  assert.deepEqual(routeInput.packageCounts, [1]);
  assert.deepEqual(routeInput.routeLabels, ['1']);
  assert.equal(routeInput.matrixSha256, createHash('sha256').update(matrix).digest('hex').toUpperCase());
  assert.equal((await (await fetch(routeUrl)).json()).state, 'running');
  assert.equal((await fetch(routeUrl, post)).status, 409);
  await writeVersionFile(version, 'routes.json', JSON.stringify({
    metadata: { version, driverCount: 1, matrixSha256: routeInput.matrixSha256 }, routes: []
  }));
  routeState = 'completed';
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  await writeVersionFile(version, 'routes.json', JSON.stringify({
    metadata: { version, driverCount: 1, matrixSha256: routeInput.matrixSha256,
      serviceTimeModel: 'per-location-visit-v1', serviceSecondsPerVisit: 60 }, routes: []
  }));
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  await writeVersionFile(version, 'routes.json', JSON.stringify({
    metadata: { version, driverCount: 1, matrixSha256: routeInput.matrixSha256,
      serviceTimeModel: 'per-location-visit-v1', serviceSecondsPerVisit: 60,
      optimization: 'vroom-capacity-multitrip-v1', inputSha256: routeInput.inputSha256,
      capacity: 60, reloadSeconds: 10, maxAllowedDifferenceSeconds: 1800 }, routes: []
  }));
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  await writeVersionFile(version, 'routes.json', JSON.stringify({
    metadata: { version, driverCount: 1, matrixSha256: routeInput.matrixSha256,
      serviceTimeModel: 'per-location-visit-v1', serviceSecondsPerVisit: 60,
      optimization: 'vroom-capacity-multitrip-v1', inputSha256: routeInput.inputSha256,
      capacity: 60, reloadSeconds: 10, maxAllowedDifferenceSeconds: 1800 }, routes: [], oldRoutePlan: {}
  }));
  assert.equal((await (await fetch(routeUrl)).json()).state, 'completed');
  assert.equal((await fetch(`${baseUrl}/api/versions/${version}/routes`)).status, 200);
  const pdfUrl = `${baseUrl}/api/versions/${version}/driver-pdfs`;
  const pdfDataUrl = `${baseUrl}/api/versions/${version}/driver-pdf-data`;
  const pdfResponse = await fetch(pdfDataUrl);
  assert.equal(pdfResponse.status, 200);
  const pdfData = await pdfResponse.json();
  assert.ok(!('osmGeometry' in pdfData));
  assert.deepEqual(pdfData.deliveries, [{ csvRecordNumber: 2, name: 'Test', street: 'Straat; deel',
    houseNumber: '12', postcode: '8500', municipality: 'Teststad', packageCount: 1,
    bellen: 'ja', remarkUpper: 'Eerste notitie', remarkLower: 'Tweede notitie' }]);
  assert.deepEqual(pdfData.locations, locations);
  assert.equal((await (await fetch(pdfUrl)).json()).state, 'idle');
  assert.equal((await fetch(pdfUrl, post)).status, 202);
  assert.equal(pdfVersion, version);
  assert.equal((await fetch(pdfUrl, { ...post, headers: { ...post.headers, origin: 'http://example.test' } })).status, 403);
  const routeMapsUrl = `${baseUrl}/api/versions/${version}/route-maps`;
  const mapStatusResponse = await fetch(routeMapsUrl);
  assert.equal(mapStatusResponse.status, 200, await mapStatusResponse.clone().text());
  assert.equal((await mapStatusResponse.json()).state, 'idle');
  assert.equal((await fetch(routeMapsUrl, { ...post, headers: { ...post.headers, origin: 'http://example.test' } })).status, 403);
  assert.equal((await fetch(routeMapsUrl, post)).status, 202);
  assert.equal(routeMapVersion, version);
  assert.equal((await (await fetch(routeMapsUrl)).json()).state, 'running');
  assert.equal((await fetch(routeMapsUrl, post)).status, 409);
  const geometryUrl = `${baseUrl}/api/versions/${version}/route-geometry`;
  assert.equal((await fetch(geometryUrl)).status, 200);
  geometryAvailable = false;
  assert.equal((await fetch(geometryUrl)).status, 503);
  geometryAvailable = true;
  const serviceUrl = `${baseUrl}/api/versions/${version}/settings/serviceSeconds`;
  const setService = value => fetch(serviceUrl, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value })
  });
  assert.equal((await setService('90')).status, 200);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  assert.equal((await fetch(`${baseUrl}/api/versions/${version}/routes`)).status, 409);
  assert.equal((await fetch(geometryUrl)).status, 409);
  assert.equal((await fetch(pdfDataUrl)).status, 409);
  assert.equal((await fetch(pdfUrl, post)).status, 409);
  assert.equal((await fetch(routeMapsUrl, post)).status, 409);
  for (const invalid of ['0', '-1', '1.5', '', '2147483648']) {
    assert.equal((await setService(invalid)).status, 200);
    assert.equal((await fetch(routeUrl, post)).status, 409);
  }
  assert.equal((await fetch(serviceUrl, { method: 'DELETE' })).status, 204);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'completed');
  const setSetting = (key, value) => fetch(`${baseUrl}/api/versions/${version}/settings/${key}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value })
  });
  assert.equal((await setSetting('Capacity', '2')).status, 200);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  assert.equal((await setSetting('Capacity', '0')).status, 200);
  assert.equal((await fetch(routeUrl, post)).status, 409);
  assert.equal((await setSetting('Capacity', '60')).status, 200);
  assert.equal((await setSetting('reloadSeconds', '20')).status, 200);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  assert.equal((await setSetting('reloadSeconds', '10')).status, 200);
  assert.equal((await setSetting('maxDifferenceMinutes', '45')).status, 200);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  for (const invalid of ['-1', '1.5', '', '2147483648']) {
    assert.equal((await setSetting('maxDifferenceMinutes', invalid)).status, 200);
    assert.equal((await fetch(routeUrl, post)).status, 409);
  }
  assert.equal((await setSetting('maxDifferenceMinutes', '0')).status, 200);
  assert.equal((await fetch(routeUrl, post)).status, 202);
  assert.equal(routeInput.maxDifferenceMinutes, 0);
  routeState = 'completed';
  assert.equal((await setSetting('maxDifferenceMinutes', '30')).status, 200);
  await writeVersionFile(version, 'matrix.json', `${matrix} `);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  await writeVersionFile(version, 'matrix.json', matrix);
  assert.equal((await setDrivers('2')).status, 200);
  assert.equal((await (await fetch(routeUrl)).json()).state, 'stale');
  assert.equal((await fetch(`${baseUrl}/api/versions/${version}/routes`)).status, 409);
  assert.equal((await fetch(routeUrl, post)).status, 409);
  matrixState = 'idle';
  routeState = 'idle';
});

test('route calculation rejects unknown versions and invalid inputs', async () => {
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${baseUrl}/api/versions/invalid/route-calculation`, request)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/versions/20000101T0000000000000Z/route-calculation`, request)).status, 404);
  const response = await fetch(`${baseUrl}/api/versions/${firstVersion}/route-calculation`, request);
  assert.equal(response.status, 409);
});

test('GeoJSON is available only for its current report', async () => {
  const url = `${baseUrl}/api/versions/${secondVersion}/osm-geometry`;
  assert.equal((await fetch(url)).status, 404);
  const reportBytes = await readVersionFile(secondVersion, 'address-check.json');
  const geometry = { type: 'FeatureCollection', features: [], metadata: {
    sourceReportSha256: createHash('sha256').update(reportBytes).digest('hex'),
  } };
  await writeVersionFile(secondVersion, 'osm-geometry.geojson', JSON.stringify(geometry));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/geo\+json/);
  assert.deepEqual(await response.json(), geometry);
  geometry.metadata.sourceReportSha256 = 'BAD';
  await writeVersionFile(secondVersion, 'osm-geometry.geojson', JSON.stringify(geometry));
  assert.equal((await fetch(url)).status, 409);
  await writeVersionFile(secondVersion, 'osm-geometry.geojson', '[]');
  assert.equal((await fetch(url)).status, 409);
});

test('address check requires a valid version and origin and checks service readiness', async () => {
  const checkUrl = `${baseUrl}/api/versions/${firstVersion}/address-check`;
  assert.equal((await (await fetch(checkUrl)).json()).state, 'idle');
  assert.equal((await fetch(`${baseUrl}/api/versions/invalid/address-check`)).status, 404);
  assert.equal((await fetch(checkUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 403);
  assert.equal((await fetch(checkUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example' }, body: '{}' })).status, 403);
  photonReady = false;
  assert.equal((await fetch(checkUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal(startCount, 0);
  photonReady = true;
  assert.equal((await fetch(checkUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://routing.localtest.me' }, body: '{}' })).status, 202);
  assert.equal((await (await fetch(checkUrl)).json()).state, 'running');
  assert.equal((await fetch(checkUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
  assert.equal(startCount, 1);
});

test('geometry refresh validates version and origin and reports its status', async () => {
  const url = `${baseUrl}/api/versions/${secondVersion}/osm-geometry`;
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await (await fetch(`${url}/status`)).json()).state, 'idle');
  assert.equal((await fetch(`${baseUrl}/api/versions/invalid/osm-geometry`, request)).status, 404);
  assert.equal((await fetch(url, { ...request, headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await fetch(url, { ...request, headers: { ...request.headers, origin: 'https://other.example' } })).status, 403);
  const withoutReport = (await (await upload(csv)).json()).id;
  assert.equal((await fetch(`${baseUrl}/api/versions/${withoutReport}/osm-geometry`, request)).status, 404);
  assert.equal((await fetch(url, request)).status, 202);
  assert.equal((await (await fetch(`${url}/status`)).json()).state, 'running');
  assert.equal((await fetch(url, request)).status, 409);
  assert.equal(geometryStartCount, 1);
});