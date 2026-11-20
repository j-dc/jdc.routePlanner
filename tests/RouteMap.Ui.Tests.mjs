import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { chromium } from '/app/node_modules/playwright-core/index.mjs';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (file.includes('..')) throw new Error('Invalid path');
    const data = await readFile(join('/frontend', file));
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

test('route controls filter lines and locations, retain clustering, and restore all routes', async () => {
  await new Promise(resolve => server.listen(18090, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const records = [2, 3, 4].map((number, index) => ({
      csvRecordNumber: number, address: { street: 'Teststraat', houseNumber: String(number), postcode: '1000', municipality: 'Test' },
      decision: 'accepted', selectedCandidateId: null, latitude: 50.9 + index * 0.01, longitude: 3.3 + index * 0.01,
      candidates: [], geocodingStatus: 'matched', geocodingReason: '', notes: ''
    }));
    const responses = {
      '/api/versions': ['legacy'],
      '/api/versions/legacy/address-check': { state: 'completed' },
      '/api/versions/legacy/review': { totalRecords: 3, pendingCount: 0, acceptedCount: 3, unresolvedCount: 0, readyForNextStep: true, records },
      '/api/versions/legacy/settings': { startLocation: null, settings: { nmbDrivers: '2' } },
      '/api/versions/legacy/matrix-calculation': { state: 'completed' },
      '/api/versions/legacy/route-calculation': { state: 'completed' },
      '/api/versions/legacy/driver-pdfs': { state: 'idle' },
      '/api/versions/legacy/route-maps': { state: 'idle' },
      '/api/versions/legacy/osm-geometry/status': { state: 'completed' },
      '/api/versions/legacy/osm-geometry': { type: 'FeatureCollection', features: [] },
      '/api/versions/legacy/routes': { metadata: { actualDifferenceSeconds: 0 }, totalDistanceMeters: 1000, routes: [] },
      '/api/versions/legacy/route-geometry': { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { driver: 1, records: [2, 3] }, geometry: { type: 'MultiLineString', coordinates: [[[3.3, 50.9], [3.31, 50.91]]] } },
        { type: 'Feature', properties: { driver: 2, records: [4] }, geometry: { type: 'MultiLineString', coordinates: [[[3.3, 50.9], [3.32, 50.92]]] } }
      ] }
    };
    await page.route('http://routing-api.localtest.me/**', route => {
      const body = responses[new URL(route.request().url()).pathname];
      return route.fulfill({ status: body ? 200 : 404, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
    });
    const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
    await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body: tile }));
    await page.goto('http://127.0.0.1:18090/');
    await page.locator('#version-select').selectOption('legacy');
    await page.getByRole('button', { name: 'Bekijk leverlocaties' }).click();
    const group = page.getByRole('group', { name: 'Routes op de kaart' });
    await group.waitFor();
    const map = page.locator('.map');
    const count = page.locator('.location-count');
    assert.equal(await count.textContent(), '3 op kaart');
    await group.getByRole('button', { name: 'Chauffeur 1' }).click();
    await page.locator('.map[data-render-state="ready"]').waitFor({ timeout: 30000 });
    assert.equal(await count.textContent(), '2 op kaart');
    assert.equal(await group.getByRole('button', { name: 'Chauffeur 1' }).getAttribute('aria-pressed'), 'true');
    const routeColors = await map.locator('canvas').evaluateAll(canvases => canvases.map(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0, yellow = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 126 && pixels[i + 1] === 178 && pixels[i + 2] === 109 && pixels[i + 3] > 0) green++;
        if (pixels[i] === 234 && pixels[i + 1] === 184 && pixels[i + 2] === 57 && pixels[i + 3] > 0) yellow++;
      }
      return { green, yellow };
    }));
    assert.ok(routeColors.some(color => color.green > 0));
    assert.ok(routeColors.every(color => color.yellow === 0));
    await page.locator('.map-options summary').click();
    await page.getByLabel('Leveradressen clusteren').check();
    await group.getByRole('button', { name: 'Chauffeur 2' }).click();
    await page.locator('.map[data-render-state="ready"]').waitFor({ timeout: 30000 });
    assert.equal(await count.textContent(), '1 op kaart');
    await group.getByRole('button', { name: 'Alle routes' }).click();
    await page.locator('.map[data-render-state="ready"]').waitFor({ timeout: 30000 });
    assert.equal(await count.textContent(), '3 op kaart');
    assert.equal(await group.getByRole('button', { name: 'Alle routes' }).getAttribute('aria-pressed'), 'true');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
