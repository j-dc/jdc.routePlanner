import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => createHash('sha256').update(value).digest('hex').toUpperCase();

test('API and VROOM worker produce complete routes from an actual saved matrix', async () => {
  const matrixService = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/matrix/status/')) return response.end(JSON.stringify({ state: 'completed' }));
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => matrixService.listen(18181, '127.0.0.1', resolve));
  const worker = spawn(process.execPath, ['/app/server.mjs'], {
    stdio: 'ignore', env: { ...process.env, ROUTE_OUTPUT_DIR: '/source', ROUTE_API_URL: 'http://127.0.0.1:8080/' }
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch('http://127.0.0.1:8083/health')).ok) break; } catch {}
      if (worker.exitCode !== null || attempt === 99) throw new Error('VROOM worker did not start');
      await wait(100);
    }
    const api = 'http://127.0.0.1:8080/api/versions';
    const header = 'rit;naam;straat;nr.;postcode;gemeente;aantal;bellen;Opmerking;opmerking;klas';
    const csv = `${header}\n${Array.from({ length: 6 }, (_, index) =>
      `1;Test;Teststraat;${index + 1};8500;Teststad;2;;;;`).join('\n')}`;
    const upload = await fetch(api, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv });
    assert.equal(upload.status, 201);
    const { id: version } = await upload.json();
    const url = `${api}/${version}`;
    const report = {
      createdAtUtc: '2026-01-01T00:00:00Z', inputSha256: digest(csv), totalRecords: 6,
      results: Array.from({ length: 6 }, (_, index) => {
        const latitude = 50 + index / 100, longitude = 3;
        return { csvRecordNumber: index + 2, status: 'valid', latitude, longitude,
          candidates: [{ candidateId: `test-${index}`, geometryIsValid: true, latitude, longitude }] };
      })
    };
    await writeFile(`/source/address-check-${version}.json`, JSON.stringify(report));
    const review = await (await fetch(`${url}/review`)).json();
    const put = (path, body) => fetch(`${url}/${path}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal((await put('start-location', { label: 'Test', latitude: 50, longitude: 3 })).status, 200);
    assert.equal((await put('settings/nmbDrivers', { value: '2' })).status, 200);
    assert.equal((await put('settings/serviceSeconds', { value: '90' })).status, 200);
    assert.equal((await put('settings/Capacity', { value: '3' })).status, 200);
    assert.equal((await put('settings/reloadSeconds', { value: '10' })).status, 200);
    assert.equal((await put('settings/maxDifferenceMinutes', { value: '20' })).status, 200);
    const locations = [{ csvRecordNumber: null, latitude: 50, longitude: 3 }, ...review.records.map(record => ({
      csvRecordNumber: record.csvRecordNumber, latitude: record.latitude, longitude: record.longitude
    }))];
    const costs = locations.map((_, i) => locations.map((_, j) => Math.abs(i - j) * 100));
    const matrix = {
      metadata: { version, reviewFingerprint: review.sourceFingerprint, reviewUpdatedAtUtc: review.updatedAtUtc,
        locationFingerprint: digest(JSON.stringify(locations)), locations },
      matrices: { car: { costs, distances: costs, durations: costs } }
    };
    await writeFile(`/source/matrix-${version}.json`, JSON.stringify(matrix));
    assert.equal((await (await fetch(`${url}/matrix-calculation`)).json()).state, 'completed');
    assert.equal((await put('settings/Capacity', { value: '1' })).status, 200);
    const oversized = await fetch(`${url}/route-calculation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(oversized.status, 409);
    assert.match((await oversized.json()).detail, /CSV-record 2.*capaciteit/);
    assert.equal((await put('settings/Capacity', { value: '3' })).status, 200);
    assert.equal((await fetch(`${url}/route-calculation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })).status, 202);
    let status;
    for (let attempt = 0; attempt < 300; attempt++) {
      status = await (await fetch(`${url}/route-calculation`)).json();
      if (status.state !== 'running') break;
      await wait(100);
    }
    assert.equal(status.state, 'completed', status.message);
    const result = await (await fetch(`${url}/routes`)).json();
    assert.equal(result.routes.length, 2);
    assert.ok(result.routes.every(route => route.stops.length > 0));
    assert.ok(result.routes.every(route => route.totalDurationSeconds === route.durationSeconds + route.serviceDurationSeconds + route.reloadDurationSeconds));
    assert.ok(result.routes.some(route => route.trips.length > 1));
    assert.ok(result.routes.every(route => route.trips.every(trip => trip.packageCount <= 3)));
    assert.ok(result.routes.every(route => route.reloadDurationSeconds === (route.trips.length - 1) * 10));
    assert.equal(result.metadata.serviceSecondsPerVisit, 90);
    assert.equal(result.routes.flatMap(route => route.stops).reduce((sum, stop) => sum + stop.serviceSeconds, 0), 540);
    assert.deepEqual(result.routes.flatMap(route => route.stops.map(stop => stop.csvRecordNumber)).sort((a, b) => a - b),
      [2, 3, 4, 5, 6, 7]);
    assert.equal(result.metadata.maxAllowedDifferenceSeconds, 1200);
    assert.ok(result.metadata.actualDifferenceSeconds <= 1200);
    assert.equal((await put('settings/maxDifferenceMinutes', { value: '21' })).status, 200);
    assert.equal((await (await fetch(`${url}/route-calculation`)).json()).state, 'stale');
    assert.equal((await put('settings/maxDifferenceMinutes', { value: '20' })).status, 200);
    assert.equal((await put('settings/serviceSeconds', { value: '120' })).status, 200);
    assert.equal((await (await fetch(`${url}/route-calculation`)).json()).state, 'stale');
    assert.equal((await fetch(`${url}/routes`)).status, 409);
    for (const invalid of ['', '0', '-1', '1.5', 'onbekend']) {
      const badCsv = `${header}\n1;Test;Teststraat;1;8500;Teststad;${invalid};;;;`;
      const badUpload = await fetch(api, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: badCsv });
      assert.equal(badUpload.status, 201);
      const { id: badVersion } = await badUpload.json();
      await writeFile(`/source/address-check-${badVersion}.json`, JSON.stringify({
        ...report, inputSha256: digest(badCsv), totalRecords: 1, results: [report.results[0]]
      }));
      const badUrl = `${api}/${badVersion}`;
      const badPut = (path, body) => fetch(`${badUrl}/${path}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal((await badPut('start-location', { label: 'Test', latitude: 50, longitude: 3 })).status, 200);
      assert.equal((await badPut('settings/nmbDrivers', { value: '1' })).status, 200);
      const invalidResponse = await fetch(`${badUrl}/route-calculation`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      assert.equal(invalidResponse.status, 409);
      assert.match((await invalidResponse.json()).detail, /CSV-record 2.*aantal pakketten/);
    }
    assert.equal((await put('settings/serviceSeconds', { value: '90' })).status, 200);
    assert.equal((await (await fetch(`${url}/route-calculation`)).json()).state, 'completed');
    assert.equal((await put('settings/nmbDrivers', { value: '3' })).status, 200);
    assert.equal((await (await fetch(`${url}/route-calculation`)).json()).state, 'stale');
    assert.equal((await fetch(`${url}/routes`)).status, 409);
  } finally {
    worker.kill();
    await new Promise(resolve => worker.once('exit', resolve));
    matrixService.closeAllConnections();
    await new Promise(resolve => matrixService.close(resolve));
  }
});
