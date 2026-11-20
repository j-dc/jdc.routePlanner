import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('matrix worker batches, preserves indices, rejects failures and detects interruptions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-test-'));
  const locations = Array.from({ length: 22 }, (_, index) => ({
    csvRecordNumber: index === 0 ? null : index + 1,
    latitude: 50 + (index === 2 ? 1 : index) / 100,
    longitude: 3
  }));
  const updatedAt = '2026-01-01T00:00:00Z';
  const review = {
    sourceFingerprint: 'synthetic', updatedAtUtc: updatedAt, totalRecords: 21,
    records: locations.slice(1).map(location => ({ ...location, decision: 'accepted' }))
  };
  const settings = { startLocation: { label: 'Test', latitude: 50, longitude: 3 }, settings: {} };
  const request = { version: 'legacy', reviewFingerprint: 'synthetic', reviewUpdatedAtUtc: updatedAt, locations };
  let blocked = true;
  let release;
  let entered;
  let enteredPromise = new Promise(resolve => { entered = resolve; });
  let invalid = false;
  let ready = true;
  const batches = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') {
      if (!ready) res.writeHead(503);
      return res.end('{}');
    }
    if (req.url === '/api/versions/legacy/review') return res.end(JSON.stringify(review));
    if (req.url === '/api/versions/legacy/settings') return res.end(JSON.stringify(settings));
    if (req.url !== '/sources_to_targets') { res.writeHead(404); return res.end(); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    batches.push(data);
    if (blocked) {
      blocked = false;
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    const rows = data.sources.map((_, i) => data.targets.map((_, j) => ({
      from_index: i, to_index: j, time: invalid ? null : 12.6 + i, distance: 0.123 + j
    })));
    res.end(JSON.stringify({ sources_to_targets: rows }));
  });
  await new Promise(resolve => server.listen(18181, '127.0.0.1', resolve));
  let worker;
  const base = 'http://127.0.0.1:8082';
  async function startWorker() {
    worker = spawn('dotnet', ['RoutePlanner.Api.dll', '--matrix-worker'], {
      cwd: '/app', stdio: 'ignore',
      env: { ...process.env, Matrix__OutputDirectory: directory,
        Matrix__ValhallaUrl: 'http://127.0.0.1:18181/', Matrix__ApiUrl: 'http://127.0.0.1:18181/' }
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      if (worker.exitCode !== null) throw new Error('Matrix worker exited during startup');
      await wait(100);
    }
    throw new Error('Matrix worker did not become ready');
  }
  async function state(version = 'legacy') {
    const response = await fetch(`${base}/status/${version}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function start(input = request) {
    return fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  }
  async function until(expected) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await state();
      if (current.state === expected) return current;
      await wait(100);
    }
    throw new Error(`Matrix status did not become ${expected}`);
  }
  try {
    await startWorker();
    assert.equal((await state()).state, 'idle');
    ready = false;
    assert.equal((await start()).status, 503);
    ready = true;
    assert.equal((await start({ ...request, locations: [locations[1], locations[1]] })).status, 400);
    assert.equal((await start({ ...request, locations: locations.slice(1) })).status, 400);
    assert.equal((await start({ ...request, locations: [locations[1], locations[0]] })).status, 400);
    assert.equal((await start({ ...request, locations: [locations[0], locations[0], locations[1]] })).status, 400);
    assert.deepEqual(batches, []);
    assert.equal((await start()).status, 202);
    await enteredPromise;
    assert.equal((await state()).state, 'running');
    assert.equal((await state('20000101T0000000000000Z')).state, 'busy');
    assert.equal((await start()).status, 409);
    release();
    await until('completed');
    const output = JSON.parse(await readFile(join(directory, 'legacy', 'matrix.json'), 'utf8'));
    assert.deepEqual(output.metadata.locations, locations);
    assert.equal(output.matrices.car.distances.length, 22);
    assert.ok(output.matrices.car.distances.every(row => row.length === 22));
    assert.ok(output.matrices.car.durations.every(row => row.every(Number.isInteger)));
    assert.deepEqual(output.matrices.car.distances[1], output.matrices.car.distances[2]);
    assert.deepEqual(output.matrices.car.durations[1], output.matrices.car.durations[2]);
    assert.deepEqual(output.matrices.car.distances.map(row => row[1]), output.matrices.car.distances.map(row => row[2]));
    assert.deepEqual(output.matrices.car.durations.map(row => row[1]), output.matrices.car.durations.map(row => row[2]));
    assert.deepEqual(output.matrices.car.costs, output.matrices.car.distances);
    assert.equal(batches.length, 4);
    assert.ok(batches.every(batch => [batch.sources, batch.targets].every(locations =>
      new Set(locations.map(location => JSON.stringify([location.lat, location.lon]))).size === locations.length)));
    assert.ok(batches.every(batch => batch.sources.length <= 20 && batch.targets.length <= 20 &&
      batch.costing === 'auto' && batch.costing_options.auto.shortest === true));
    invalid = true;
    assert.equal((await start()).status, 202);
    assert.match((await until('failed')).message, /onbereikbare/);
    invalid = false;
    blocked = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start()).status, 202);
    await enteredPromise;
    settings.startLocation.latitude = 51;
    release();
    assert.match((await until('failed')).message, /gewijzigd/);
    settings.startLocation.latitude = 50;
    blocked = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start()).status, 202);
    await enteredPromise;
    worker.kill('SIGKILL');
    await new Promise(resolve => worker.once('exit', resolve));
    release();
    await startWorker();
    assert.match((await state()).message, /onderbroken/);
    assert.equal((await state()).state, 'failed');
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill();
      await new Promise(resolve => worker.once('exit', resolve));
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
