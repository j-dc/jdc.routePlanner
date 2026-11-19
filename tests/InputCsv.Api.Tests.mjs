import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const baseUrl = 'http://127.0.0.1:8080';
const header = 'rit;naam;straat;nr.;postcode;gemeente;aantal;bellen;Opmerking;opmerking;klas';
const csv = `${header}\r\n1;Test;"Straat; deel";12;8500;Teststad;;;;;`;
let firstVersion;
let secondVersion;
let brokerState = 'idle';
let photonReady = true;
let startCount = 0;
let geometryState = 'idle';
let geometryStartCount = 0;
const services = createServer((request, response) => {
  if (request.url === '/photon') {
    response.writeHead(photonReady ? 200 : 503);
    return response.end();
  }
  response.setHeader('content-type', 'application/json');
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

test('reviews remain isolated and reject reports for different input', async () => {
  const report = {
    createdAtUtc: '2026-01-01T00:00:00Z',
    inputSha256: createHash('sha256').update(csv).digest('hex'),
    totalRecords: 1,
    results: [{ csvRecordNumber: 2, status: 'needs_review', candidates: [] }],
  };
  await writeFile(`/source/address-check-${firstVersion}.json`, JSON.stringify(report));
  await writeFile(`/source/address-check-${secondVersion}.json`, JSON.stringify(report));
  assert.equal((await fetch(`${baseUrl}/api/versions/${firstVersion}/review`)).status, 200);
  const updated = await fetch(`${baseUrl}/api/versions/${firstVersion}/review/2`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'unresolved', notes: 'Test' }),
  });
  assert.equal(updated.status, 200);
  const other = await (await fetch(`${baseUrl}/api/versions/${secondVersion}/review`)).json();
  assert.equal(other.records[0].decision, 'pending');
  report.inputSha256 = 'BAD';
  await writeFile(`/source/address-check-${firstVersion}.json`, JSON.stringify(report));
  const response = await fetch(`${baseUrl}/api/versions/${firstVersion}/review`);
  assert.equal(response.status, 409);
  assert.equal((await fetch(`${baseUrl}/api/versions/not-a-version/review`)).status, 404);
});

test('matrix calculation placeholder rejects unknown versions and reports it is not implemented', async () => {
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${baseUrl}/api/versions/invalid/matrix-calculation`, request)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/versions/20000101T0000000000000Z/matrix-calculation`, request)).status, 404);
  const response = await fetch(`${baseUrl}/api/versions/${firstVersion}/matrix-calculation`, request);
  assert.equal(response.status, 501);
  assert.equal((await response.json()).detail, 'Matrixberekening is nog niet beschikbaar.');
});

test('route calculation placeholder rejects unknown versions and reports it is not implemented', async () => {
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${baseUrl}/api/versions/invalid/route-calculation`, request)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/versions/20000101T0000000000000Z/route-calculation`, request)).status, 404);
  const response = await fetch(`${baseUrl}/api/versions/${firstVersion}/route-calculation`, request);
  assert.equal(response.status, 501);
  assert.equal((await response.json()).detail, 'Routeberekening is nog niet beschikbaar.');
});

test('GeoJSON is available only for its current report', async () => {
  const url = `${baseUrl}/api/versions/${secondVersion}/osm-geometry`;
  assert.equal((await fetch(url)).status, 404);
  const reportBytes = await readFile(`/source/address-check-${secondVersion}.json`);
  const geometry = { type: 'FeatureCollection', features: [], metadata: {
    sourceReportSha256: createHash('sha256').update(reportBytes).digest('hex'),
  } };
  await writeFile(`/source/osm-geometry-${secondVersion}.geojson`, JSON.stringify(geometry));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/geo\+json/);
  assert.deepEqual(await response.json(), geometry);
  geometry.metadata.sourceReportSha256 = 'BAD';
  await writeFile(`/source/osm-geometry-${secondVersion}.geojson`, JSON.stringify(geometry));
  assert.equal((await fetch(url)).status, 409);
  await writeFile(`/source/osm-geometry-${secondVersion}.geojson`, '[]');
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