import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getRouteGeometry } from '/app/geometry.mjs';

function encodeShape(points) {
  let previous = [0, 0], result = '';
  for (const point of points) {
    for (let axis = 0; axis < 2; axis++) {
      const current = Math.round(point[axis] * 1e6);
      const delta = current - previous[axis];
      previous[axis] = current;
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 32) { result += String.fromCharCode(((value & 31) | 32) + 63); value >>= 5; }
      result += String.fromCharCode(value + 63);
    }
  }
  return result;
}

test('geometry follows each depot trip and rejects failed or changed inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'route-geometry-'));
  const locations = [
    { csvRecordNumber: null, latitude: 50, longitude: 3 },
    { csvRecordNumber: 2, latitude: 50.01, longitude: 3.01 },
    { csvRecordNumber: 3, latitude: 50.02, longitude: 3.02 },
    { csvRecordNumber: 4, latitude: 50.02, longitude: 3.02 }
  ];
  const matrix = JSON.stringify({ metadata: { locations } });
  const routes = JSON.stringify({
    metadata: { version: 'legacy', driverCount: 1, matrixSha256: createHash('sha256').update(matrix).digest('hex').toUpperCase() },
    routes: [{ driver: 1, trips: [
      { stops: [{ matrixIndex: 1, csvRecordNumber: 2 }] },
      { stops: [{ matrixIndex: 2, csvRecordNumber: 3 }, { matrixIndex: 3, csvRecordNumber: 4 }] }
    ] }]
  });
  await writeFile(join(directory, 'matrix.json'), matrix);
  await writeFile(join(directory, 'routes.json'), routes);
  const calls = [];
  let fail = false, change = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    calls.push(data);
    if (fail) { response.writeHead(503); return response.end(); }
    if (change) await writeFile(join(directory, 'routes.json'), `${routes} `);
    const points = data.locations.map(location => [location.lat, location.lon]);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ trip: { status: 0, legs: [{ shape: encodeShape(points) }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const result = await getRouteGeometry('legacy', directory, url);
    assert.deepEqual(result.features[0].properties, { driver: 1, records: [2, 3, 4] });
    assert.deepEqual(result.features[0].geometry.coordinates, [
      [[3, 50], [3.01, 50.01]], [[3.01, 50.01], [3, 50]],
      [[3, 50], [3.02, 50.02]], [[3.02, 50.02], [3, 50]]
    ]);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.costing === 'auto' && call.costing_options.auto.shortest === true));
    fail = true;
    await assert.rejects(getRouteGeometry('legacy', directory, url), /Valhalla/);
    fail = false;
    change = true;
    await assert.rejects(getRouteGeometry('legacy', directory, url), /gewijzigd/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
