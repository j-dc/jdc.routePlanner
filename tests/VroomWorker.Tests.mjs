import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { balanceRoutes, completeRoutes, createOldGroups, routeCost, serviceTime, splitTrips } from '/app/balance.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('old routes keep each RIT together and report missing RIT', () => {
  const locations = [null, 5, 2, 4, 3, 6].map(csvRecordNumber => ({ csvRecordNumber }));
  assert.equal(createOldGroups(['', '', '', '', ''], locations), null);
  const result = createOldGroups(['A', 'A', 'B', 'A', ''], locations);
  assert.deepEqual([...result.groups], [['A', [2, 4, 1]], ['B', [3]]]);
  assert.deepEqual(result.unassignedRecords, [6]);
});

test('balancing preserves deliveries and improves driving-time spread', () => {
  const weights = [0, 100, 100, 100, 100, 100];
  const durations = weights.map((a, i) => weights.map((b, j) => i === j ? 0 : a + b));
  const initial = [[1, 2, 3, 4], [5]];
  const locationIds = [0, 1, 2, 3, 4, 5];
  const result = balanceRoutes(initial, durations, durations, locationIds, 60, [0, 1, 1, 1, 1, 1], 60, 10, 3600);
  assert.deepEqual(result.routes.flat().sort(), [1, 2, 3, 4, 5]);
  assert.ok(result.routes.every(route => route.length > 0));
  assert.equal(Math.max(...result.durations) - Math.min(...result.durations), 260);
  assert.deepEqual(result.durations, result.routes.map(route => routeCost(route, durations) + serviceTime(route, locationIds, 60)));
  const split = completeRoutes([[1, 2, 3, 4, 5]], 3, durations, locationIds, 60);
  assert.equal(split.length, 3);
  assert.ok(split.every(route => route.length > 0));
  assert.deepEqual(split.flat().sort(), [1, 2, 3, 4, 5]);
});

test('service is charged per consecutive location visit and affects balancing', () => {
  const ids = [0, 1, 1, 3, 4];
  assert.equal(serviceTime([1, 2], ids, 90), 90);
  assert.equal(serviceTime([1, 3, 2], ids, 90), 270);
  const zero = Array.from({ length: 5 }, () => Array(5).fill(0));
  const result = balanceRoutes([[1, 2, 3], [4]], zero, zero, ids, 90, [0, 1, 1, 1, 1], 60, 10, 3600);
  assert.deepEqual(result.durations, [180, 180]);
  assert.deepEqual(result.routes.flat().sort(), [1, 2, 3, 4]);
});

test('balancing improves a plateau with multiple longest and shortest routes', () => {
  const zero = Array.from({ length: 9 }, () => Array(9).fill(0));
  const ids = Array.from({ length: 9 }, (_, index) => index);
  const result = balanceRoutes([[1, 2, 3], [4, 5, 6], [7], [8]], zero, zero, ids, 60, [0, 1, 1, 1, 1, 1, 1, 1, 1], 60, 10, 3600);
  assert.deepEqual(result.durations, [120, 120, 120, 120]);
  assert.deepEqual(result.routes.flat().sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a zero time difference requires equal total durations', () => {
  const zero = Array.from({ length: 5 }, () => Array(5).fill(0));
  const ids = [0, 1, 2, 3, 4];
  const result = balanceRoutes([[1, 2, 3], [4]], zero, zero, ids, 60, [0, 1, 1, 1, 1], 60, 10, 0);
  assert.deepEqual(result.durations, [120, 120]);
});

test('balancing prefers shorter distance over closer durations within the limit', () => {
  const durations = [
    [0, 100, 100, 100],
    [100, 0, 100, 100],
    [100, 2000, 0, 100],
    [100, 100, 100, 0]
  ];
  const distances = [
    [0, 100, 100, 100],
    [100, 0, 1000, 100],
    [100, 1, 0, 100],
    [100, 100, 100, 0]
  ];
  const initial = [[1, 2], [3]];
  const ids = [0, 1, 2, 3];
  const initialDistance = initial.reduce((sum, route) => sum + routeCost(route, distances), 0);
  const initialTimes = initial.map(route => routeCost(route, durations) + serviceTime(route, ids, 60));
  const result = balanceRoutes(initial, durations, distances, ids, 60, [0, 1, 1, 1], 60, 10, 3600);
  assert.ok(result.distances.reduce((sum, distance) => sum + distance, 0) < initialDistance);
  assert.ok(Math.max(...result.durations) - Math.min(...result.durations) <= 3600);
  assert.ok(Math.max(...result.durations) - Math.min(...result.durations) >
    Math.max(...initialTimes) - Math.min(...initialTimes));
  assert.deepEqual(result.durations, result.routes.map(route => routeCost(route, durations) + serviceTime(route, ids, 60)));
  assert.deepEqual(result.routes.flat().sort(), [1, 2, 3]);
});

test('balancing keeps depot trips within capacity and includes reload time', () => {
  const costs = [
    [0, 40, 30, 20, 10, 5], [30, 0, 12, 14, 16, 18],
    [20, 18, 0, 20, 22, 24], [15, 16, 18, 0, 12, 14],
    [10, 12, 14, 16, 0, 12], [5, 6, 8, 10, 12, 0]
  ];
  const ids = [0, 1, 1, 3, 4, 5];
  const counts = [0, 2, 1, 2, 1, 2];
  const result = balanceRoutes([[1, 2, 0, 3], [4, 5]], costs, costs, ids, 45, counts, 3, 17, 3600);
  assert.deepEqual(result.routes.flat().filter(index => index !== 0).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  for (const [index, route] of result.routes.entries()) {
    const trips = splitTrips(route);
    assert.ok(trips.every(trip => trip.length && trip.reduce((sum, item) => sum + counts[item], 0) <= 3));
    assert.equal(result.durations[index], routeCost(route, costs) + serviceTime(route, ids, 45) + (trips.length - 1) * 17);
    assert.equal(result.distances[index], routeCost(route, costs));
  }
});

test('balancing can remove an unnecessary depot trip without exceeding capacity', () => {
  const costs = Array.from({ length: 4 }, (_, i) =>
    Array.from({ length: 4 }, (_, j) => i === j ? 0 : 100));
  const ids = [0, 1, 2, 3];
  const counts = [0, 2, 1, 1];
  const result = balanceRoutes([[1, 0, 2], [3]], costs, costs, ids, 60, counts, 3, 10, 3600);
  assert.equal(result.routes.flatMap(splitTrips).length, 2);
  assert.ok(result.routes.flatMap(splitTrips).every(trip => trip.reduce((sum, item) => sum + counts[item], 0) <= 3));
  assert.deepEqual(result.durations, result.routes.map(route =>
    routeCost(route, costs) + serviceTime(route, ids, 60) + (splitTrips(route).length - 1) * 10));
});

test('VROOM charges setup for a delivery at the depot and a later revisit', () => {
  const costs = [[0, 0, 10], [0, 0, 10], [10, 10, 0]];
  const problem = {
    matrices: { car: { durations: costs, distances: costs, costs } },
    jobs: [
      { id: 1, location_index: 1, setup: 60, time_windows: [[0, 0]] },
      { id: 2, location_index: 1, setup: 60, time_windows: [[60, 60]] },
      { id: 3, location_index: 2, setup: 60, time_windows: [[300, 300]] },
      { id: 4, location_index: 1, setup: 60, time_windows: [[600, 600]] }
    ],
    vehicles: [{ id: 1, profile: 'car', start_index: 0, end_index: 0 }]
  };
  const solver = spawnSync('vroom', ['-t', '2', '-x', '4'], {
    input: JSON.stringify(problem), encoding: 'utf8'
  });
  assert.equal(solver.status, 0, solver.stderr);
  const solution = JSON.parse(solver.stdout);
  assert.deepEqual(solution.unassigned, []);
  const steps = solution.routes[0].steps.filter(step => step.type === 'job');
  assert.deepEqual(steps.map(step => step.id), [1, 2, 3, 4]);
  assert.deepEqual(steps.map(step => step.setup), [60, 0, 60, 60]);
});

test('VROOM worker calculates complete round trips and rejects stale or unbalanced input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vroom-worker-test-'));
  let driverCount = 2;
  let serviceSeconds = 90;
  let capacity = 60;
  let reloadSeconds = 10;
  let maxDifferenceMinutes = 30;
  let block = false;
  let entered, release;
  let enteredPromise;
  const api = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/versions/legacy/matrix-calculation') {
      if (block) {
        block = false;
        entered();
        await new Promise(resolve => { release = resolve; });
      }
      return response.end(JSON.stringify({ state: 'completed' }));
    }
    if (request.url === '/api/versions/legacy/settings')
      return response.end(JSON.stringify({ settings: { nmbDrivers: String(driverCount), serviceSeconds: String(serviceSeconds),
        Capacity: String(capacity), reloadSeconds: String(reloadSeconds), maxDifferenceMinutes: String(maxDifferenceMinutes) } }));
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => api.listen(18182, '127.0.0.1', resolve));
  const server = spawn(process.execPath, ['/app/server.mjs'], {
    stdio: 'ignore', env: { ...process.env, ROUTE_OUTPUT_DIR: directory, ROUTE_API_URL: 'http://127.0.0.1:18182/' }
  });
  const base = 'http://127.0.0.1:8083';
  async function status() {
    const response = await fetch(`${base}/status/legacy`);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function until(expected) {
    for (let attempt = 0; attempt < 3000; attempt++) {
      const current = await status();
      if (current.state === expected) return current;
      if (current.state === 'failed' && expected !== 'failed') throw new Error(current.message || 'Route calculation failed');
      await wait(100);
    }
    throw new Error(`Route status did not become ${expected}`);
  }
  async function start(matrix, requestedDrivers = 2, requestedService = serviceSeconds, counts = null, labels = null) {
    const data = JSON.stringify(matrix);
    await writeFile(join(directory, 'matrix.json'), data);
    return fetch(`${base}/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'legacy', driverCount: requestedDrivers, serviceSeconds: requestedService,
        capacity, reloadSeconds, maxDifferenceMinutes, packageCounts: counts ?? matrix.metadata.locations.slice(1).map(() => 1),
        routeLabels: labels ?? matrix.metadata.locations.slice(1).map(() => ''),
        inputSha256: 'A'.repeat(64),
        matrixSha256: createHash('sha256').update(data).digest('hex').toUpperCase() })
    });
  }
  const positions = [0, 0, 0, 3, 4, 5, 6];
  const locations = positions.map((position, index) => ({
    csvRecordNumber: index ? index + 1 : null, latitude: 50 + position / 100, longitude: 3
  }));
  const distances = positions.map(a => positions.map(b => Math.abs(a - b) * 100));
  const matrix = { metadata: { locations }, matrices: { car: { durations: distances, distances, costs: distances } } };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      if (server.exitCode !== null) throw new Error('Routeworker exited during startup');
      if (attempt === 99) throw new Error('Routeworker did not start');
      await wait(100);
    }
    assert.equal((await status()).state, 'idle');
    assert.equal((await start(matrix, 2, 0)).status, 400);
    block = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start(matrix)).status, 202);
    await enteredPromise;
    assert.equal((await status()).state, 'running');
    assert.equal((await fetch(`${base}/status/20000101T0000000000000Z`).then(response => response.json())).state, 'busy');
    assert.equal((await start(matrix)).status, 409);
    release();
    await until('completed');
    const output = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
    assert.equal(output.routes.length, 2);
    assert.ok(output.routes.every(route => route.stops.length > 0));
    assert.deepEqual(output.routes.flatMap(route => route.stops.map(stop => stop.csvRecordNumber)).sort((a, b) => a - b),
      [2, 3, 4, 5, 6, 7]);
    for (const route of output.routes) {
      const indices = route.stops.map(stop => stop.matrixIndex);
      assert.equal(route.durationSeconds, routeCost(indices, distances));
      assert.equal(route.distanceMeters, routeCost(indices, distances));
      const expectedService = indices.reduce((sum, index, stopIndex) =>
        sum + (stopIndex === 0 || positions[indices[stopIndex - 1]] !== positions[index] ? 90 : 0), 0);
      assert.equal(route.serviceDurationSeconds, expectedService);
      assert.equal(route.totalDurationSeconds, route.durationSeconds + expectedService);
      assert.equal(route.stops.reduce((sum, stop) => sum + stop.serviceSeconds, 0), expectedService);
    }
    assert.equal(output.metadata.serviceTimeModel, 'per-location-visit-v1');
    assert.equal(output.metadata.serviceSecondsPerVisit, 90);
    assert.equal(output.metadata.optimization, 'vroom-capacity-multitrip-v1');
    assert.equal(output.metadata.actualDifferenceSeconds,
      Math.max(...output.routes.map(route => route.totalDurationSeconds)) - Math.min(...output.routes.map(route => route.totalDurationSeconds)));
    assert.equal(output.metadata.maxAllowedDifferenceSeconds, 1800);
    assert.ok(output.metadata.actualDifferenceSeconds <= 1800);
    assert.equal(output.oldRoutePlan, undefined);

    block = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start(matrix)).status, 202);
    await enteredPromise;
    driverCount = 3;
    release();
    assert.match((await until('failed')).message, /gewijzigd/);
    driverCount = 2;
    block = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start(matrix)).status, 202);
    await enteredPromise;
    maxDifferenceMinutes = 45;
    release();
    assert.match((await until('failed')).message, /gewijzigd/);
    maxDifferenceMinutes = 30;
    block = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start(matrix)).status, 202);
    await enteredPromise;
    serviceSeconds = 60;
    release();
    assert.match((await until('failed')).message, /gewijzigd/);
    driverCount = 1;
    serviceSeconds = 2147483647;
    assert.equal((await start(matrix, 1)).status, 202);
    assert.match((await until('failed')).message, /ongeldige reistijd of levertijd/);
    driverCount = 2;
    serviceSeconds = 60;
    capacity = 3;
    assert.equal((await start(matrix, 2, 60, [2, 2, 2, 2, 2, 2], ['A', 'A', 'B', 'A', '', 'B'])).status, 202);
    await until('completed');
    const multi = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
    assert.equal(multi.routes.reduce((sum, route) => sum + route.stops.length, 0), 6);
    assert.ok(multi.routes.some(route => route.trips.length > 1));
    for (const route of multi.routes) {
      assert.ok(route.trips.every(trip => trip.packageCount <= 3 && trip.packageCount === 2));
      assert.equal(route.reloadDurationSeconds, (route.trips.length - 1) * 10);
      assert.equal(route.durationSeconds, route.trips.reduce((sum, trip) => sum + trip.durationSeconds, 0));
      assert.equal(route.totalDurationSeconds, route.durationSeconds + route.serviceDurationSeconds + route.reloadDurationSeconds);
      assert.ok(route.trips.every(trip => trip.stops[0].serviceSeconds === 60));
    }
    const old = multi.oldRoutePlan;
    assert.deepEqual(old.unassignedRecords, [6]);
    assert.deepEqual(old.routes.map(route => route.driver), ['A', 'B']);
    assert.deepEqual(old.routes.map(route => route.stops.map(stop => stop.csvRecordNumber).sort((a, b) => a - b)),
      [[2, 3, 5], [4, 7]]);
    for (const route of old.routes) {
      assert.ok(route.trips.every(trip => trip.packageCount === 2));
      const indices = route.trips.flatMap((trip, index) =>
        [...(index ? [0] : []), ...trip.stops.map(stop => stop.matrixIndex)]);
      assert.equal(route.durationSeconds, routeCost(indices, distances));
      assert.equal(route.distanceMeters, routeCost(indices, distances));
      assert.equal(route.serviceDurationSeconds, serviceTime(indices, [0, 1, 1, 3, 4, 5, 6], 60));
      assert.equal(route.reloadDurationSeconds, (route.trips.length - 1) * 10);
      assert.equal(route.totalDurationSeconds, route.durationSeconds + route.serviceDurationSeconds + route.reloadDurationSeconds);
    }
    assert.equal(old.totalDistanceMeters, old.routes.reduce((sum, route) => sum + route.distanceMeters, 0));
    driverCount = 1;
    capacity = 60;
    const reorderCosts = [[0, 1, 100, 100], [100, 0, 100, 1],
      [1, 100, 0, 100], [100, 100, 1, 0]];
    const reorder = { metadata: { locations: locations.slice(0, 4).map((location, index) =>
      ({ ...location, latitude: 50 + index / 100 })) },
    matrices: { car: { durations: reorderCosts, distances: reorderCosts, costs: reorderCosts } } };
    assert.equal((await start(reorder, 1, 60, [1, 1, 1], ['X', 'X', 'X'])).status, 202);
    await until('completed');
    const reordered = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8')).oldRoutePlan.routes[0];
    assert.deepEqual(reordered.stops.map(stop => stop.csvRecordNumber), [2, 4, 3]);
    assert.equal(reordered.distanceMeters, 4);
    driverCount = 2;
    capacity = 3;
    block = true;
    enteredPromise = new Promise(resolve => { entered = resolve; });
    assert.equal((await start(matrix)).status, 202);
    await enteredPromise;
    reloadSeconds = 20;
    release();
    assert.match((await until('failed')).message, /gewijzigd/);
    capacity = 60;
    reloadSeconds = 10;
    const long = [[0, 100, 10000], [100, 0, 10000], [10000, 10000, 0]];
    const unbalanced = { metadata: { locations: locations.slice(0, 3).map((location, index) =>
      ({ ...location, latitude: 50 + index / 100 })) },
      matrices: { car: { durations: long, distances: long, costs: long } } };
    assert.equal((await start(unbalanced)).status, 202);
    assert.match((await until('failed')).message, /30 minuten/);
    maxDifferenceMinutes = 400;
    assert.equal((await start(unbalanced)).status, 202);
    await until('completed');
    const relaxed = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
    assert.equal(relaxed.metadata.maxAllowedDifferenceSeconds, 24000);
    assert.ok(relaxed.metadata.actualDifferenceSeconds > 1800 && relaxed.metadata.actualDifferenceSeconds <= 24000);
    maxDifferenceMinutes = 30;
    const invalidCost = long.map(row => [...row]);
    invalidCost[0][1]++;
    assert.equal((await start({ ...unbalanced, matrices: { car: { durations: long, distances: long, costs: invalidCost } } })).status, 202);
    assert.match((await until('failed')).message, /matrixkosten/);
    const missingStart = { ...unbalanced, metadata: { locations: [
      { csvRecordNumber: 2 }, ...locations.slice(1, 3)
    ] } };
    assert.equal((await start(missingStart)).status, 202);
    assert.match((await until('failed')).message, /startlocatie/);
    const thresholdLocations = Array.from({ length: 5 }, (_, index) => ({
      csvRecordNumber: index ? index + 1 : null, latitude: 50 + index / 100, longitude: 3
    }));
    const thresholdCosts = thresholdLocations.map((_, i) => thresholdLocations.map((_, j) =>
      i === j ? 0 : i === 1 || j === 1 ? 950 : 0));
    const threshold = { metadata: { locations: thresholdLocations },
      matrices: { car: { durations: thresholdCosts, distances: thresholdCosts, costs: thresholdCosts } } };
    assert.equal((await start(threshold)).status, 202);
    await until('completed');
    const thresholdResult = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
    assert.ok(Math.max(...thresholdResult.routes.map(route => route.durationSeconds)) -
      Math.min(...thresholdResult.routes.map(route => route.durationSeconds)) > 1800);
    assert.ok(thresholdResult.metadata.actualDifferenceSeconds <= 1800);
    driverCount = 10;
    capacity = 30;
    const manyLocations = Array.from({ length: 401 }, (_, index) => ({
      csvRecordNumber: index ? index + 1 : null, latitude: 50 + index / 1000, longitude: 3
    }));
    const manyCosts = manyLocations.map((_, i) => manyLocations.map((_, j) => Math.abs(i - j) * 10));
    const many = { metadata: { locations: manyLocations },
      matrices: { car: { durations: manyCosts, distances: manyCosts, costs: manyCosts } } };
    assert.equal((await start(many, 10, 60, Array(400).fill(2))).status, 202);
    await until('completed');
    const largeResult = JSON.parse(await readFile(join(directory, 'routes.json'), 'utf8'));
    assert.equal(largeResult.routes.length, 10);
    assert.equal(new Set(largeResult.routes.flatMap(route => route.stops.map(stop => stop.csvRecordNumber))).size, 400);
    assert.ok(largeResult.routes.every(route => route.stops.length > 0));
    assert.ok(largeResult.routes.flatMap(route => route.trips).length >= 27);
    assert.ok(largeResult.routes.every(route => route.trips.every(trip => trip.packageCount <= 30)));
    assert.ok(largeResult.metadata.actualDifferenceSeconds <= 1800);
    await writeFile(join(directory, 'routes-status.json'), JSON.stringify({ state: 'running' }));
    assert.match((await status()).message, /onderbroken/);
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
