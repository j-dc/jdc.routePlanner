import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
const records = [2, 3].map((number, index) => ({
  csvRecordNumber: number, address: { street: 'Teststraat', houseNumber: String(number), postcode: '1000', municipality: 'Test' },
  decision: 'accepted', selectedCandidateId: null, latitude: 50.9 + index * 0.01, longitude: 3.3 + index * 0.01,
  candidates: [], geocodingStatus: 'matched', geocodingReason: '', notes: ''
}));
const snapshot = { version: 'legacy', routes: [{ driver: 1 }, { driver: 2 }], locations: [], deliveries: [] };
let snapshotReads = 0;
let changeSnapshot = false;
const responses = {
  '/api/versions': ['legacy'],
  '/api/versions/legacy/address-check': { state: 'completed' },
  '/api/versions/legacy/review': { totalRecords: 2, pendingCount: 0, acceptedCount: 2, unresolvedCount: 0, readyForNextStep: true, records },
  '/api/versions/legacy/settings': { startLocation: null, settings: { nmbDrivers: '2' } },
  '/api/versions/legacy/matrix-calculation': { state: 'completed' },
  '/api/versions/legacy/route-calculation': { state: 'completed' },
  '/api/versions/legacy/driver-pdfs': { state: 'idle' },
  '/api/versions/legacy/route-maps': { state: 'idle' },
  '/api/versions/legacy/osm-geometry/status': { state: 'completed' },
  '/api/versions/legacy/osm-geometry': { type: 'FeatureCollection', features: [] },
  '/api/versions/legacy/routes': { metadata: { actualDifferenceSeconds: 0 }, totalDistanceMeters: 1000, routes: [] },
  '/api/versions/legacy/route-geometry': { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { driver: 1, records: [2] }, geometry: { type: 'MultiLineString', coordinates: [[[3.3, 50.9], [3.31, 50.91]]] } },
    { type: 'Feature', properties: { driver: 2, records: [3] }, geometry: { type: 'MultiLineString', coordinates: [[[3.3, 50.9], [3.32, 50.92]]] } }
  ] }
};
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.headers.host === 'routing-api.localtest.me') {
    response.setHeader('access-control-allow-origin', 'http://routing.localtest.me');
    response.setHeader('content-type', 'application/json');
    if (path === '/api/versions/legacy/driver-pdf-data') {
      snapshotReads++;
      return response.end(JSON.stringify(changeSnapshot && snapshotReads > 1 ? { ...snapshot, changed: true } : snapshot));
    }
    if (!(path in responses)) response.writeHead(404);
    return response.end(JSON.stringify(responses[path] ?? {}));
  }
  if (path === '/test-tile.png') {
    response.writeHead(200, { 'content-type': 'image/png' });
    return response.end(tile);
  }
  try {
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (file.includes('..')) throw new Error('Invalid path');
    let data = await readFile(join('/frontend', file));
    if (file === 'index.html') {
      const stub = `<script>const d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{get:d.get,set(value){d.set.call(this,value.startsWith('https://tile.openstreetmap.org/')?'/test-tile.png':value)}});</script>`;
      data = Buffer.from(data.toString().replace('<head>', `<head>${stub}`));
    }
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

async function runWorker() {
  const child = spawn(process.execPath, ['/app/entrypoint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

test('browser job publishes one map per driver and preserves previous output if the plan changes', async () => {
  await mkdir('/output/legacy', { recursive: true });
  await writeFile('/jobs/route-map-version', 'legacy');
  await new Promise(resolve => server.listen(80, '0.0.0.0', resolve));
  try {
    const first = await runWorker();
    assert.equal(first.code, 0, first.output);
    assert.deepEqual((await readdir('/output/legacy/route-maps')).sort(), ['chauffeur-1.png', 'chauffeur-2.png', 'manifest.json']);
    const original = await readFile('/output/legacy/route-maps/chauffeur-1.png');
    const manifest = JSON.parse(await readFile('/output/legacy/route-maps/manifest.json', 'utf8'));
    const hash = data => createHash('sha256').update(data).digest('hex');
    assert.equal(manifest.snapshotSha256, hash(JSON.stringify(snapshot)));
    assert.equal(manifest.maps['1'], hash(original));
    assert.equal(manifest.maps['2'], hash(await readFile('/output/legacy/route-maps/chauffeur-2.png')));
    assert.equal(original.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.notDeepEqual(original, await readFile('/output/legacy/route-maps/chauffeur-2.png'));
    snapshotReads = 0;
    changeSnapshot = true;
    const stale = await runWorker();
    assert.equal(stale.code, 1, stale.output);
    assert.deepEqual(await readFile('/output/legacy/route-maps/chauffeur-1.png'), original);
    assert.deepEqual(await readdir('/output/legacy'), ['route-maps']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
