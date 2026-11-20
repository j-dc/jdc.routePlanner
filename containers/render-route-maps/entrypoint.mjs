import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const outputRoot = '/output';
const api = 'http://routing-api.localtest.me';
const site = 'http://routing.localtest.me';
const version = (await readFile('/jobs/route-map-version', 'utf8')).trim();
if (!/^(legacy|\d{8}T\d{13}Z)$/.test(version)) throw new Error('Ongeldige planningsversie.');
process.umask(0o077);
const directory = join(outputRoot, version);
const staging = join(directory, `.route-maps-staging-${randomUUID()}`);
const output = join(directory, 'route-maps');
const backup = join(directory, `.route-maps-old-${randomUUID()}`);
const digest = value => createHash('sha256').update(value).digest('hex');

async function snapshot() {
  const response = await fetch(`${api}/api/versions/${version}/driver-pdf-data`, { signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error('Actuele routegegevens zijn niet beschikbaar.');
  return Buffer.from(await response.arrayBuffer());
}

await mkdir(staging, { recursive: false, mode: 0o700 });
let browser;
let phase = 'routegegevens ophalen';
try {
  const initial = await snapshot();
  const data = JSON.parse(initial);
  if (data.version !== version || !Array.isArray(data.routes) || !data.routes.length ||
      data.routes.some(route => !Number.isSafeInteger(route.driver) || route.driver < 1) ||
      new Set(data.routes.map(route => route.driver)).size !== data.routes.length)
    throw new Error('Ongeldige routegegevens.');

  phase = 'browser starten';
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  let tileFailed = false;
  const isTile = url => {
    const host = new URL(url).hostname;
    return host === 'tile.openstreetmap.org' || host.endsWith('.tile.openstreetmap.org');
  };
  page.on('requestfailed', request => {
    if (isTile(request.url()) && request.failure()?.errorText !== 'net::ERR_ABORTED') tileFailed = true;
  });
  page.on('response', response => {
    if (isTile(response.url()) && !response.ok()) tileFailed = true;
  });
  phase = 'website en kaart openen';
  await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('#version-select').selectOption(version, { timeout: 60000 });
  await page.getByRole('button', { name: 'Bekijk leverlocaties' }).click({ timeout: 60000 });
  const group = page.getByRole('group', { name: 'Routes op de kaart' });
  await group.waitFor({ timeout: 600000 });
  await page.waitForFunction(() => {
    const state = document.querySelector('.map')?.getAttribute('data-geometry-state');
    return state === 'ready' || state === 'error';
  }, null, { timeout: 600000 });
  if (await page.locator('.map').getAttribute('data-geometry-state') !== 'ready')
    throw new Error('Lokale contouren konden niet worden geladen.');
  const buttons = group.locator('button[data-driver]');
  const actualDrivers = (await buttons.evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-driver')))))
    .sort((a, b) => a - b);
  const expectedDrivers = data.routes.map(route => route.driver).sort((a, b) => a - b);
  if (JSON.stringify(actualDrivers) !== JSON.stringify(expectedDrivers)) throw new Error('De routes op de kaart komen niet overeen met de planning.');
  const maps = {};
  for (const driver of expectedDrivers) {
    phase = `kaart voor chauffeur ${driver} renderen`;
    tileFailed = false;
    const button = group.locator(`button[data-driver="${driver}"]`);
    await button.click();
    await page.locator('.map[data-render-state="ready"]').waitFor({ timeout: 120000 });
    if (await button.getAttribute('aria-pressed') !== 'true' || tileFailed)
      throw new Error('De routekaart of achtergrondtegels konden niet volledig worden weergegeven.');
    const attributionButton = page.locator('.map .ol-attribution button');
    if (await attributionButton.getAttribute('aria-expanded') === 'false') await attributionButton.click();
    if (!(await page.locator('.map .ol-attribution').innerText()).includes('OpenStreetMap'))
      throw new Error('De OpenStreetMap-attributie ontbreekt.');
    const image = await page.locator('.map').screenshot({ path: join(staging, `chauffeur-${driver}.png`), timeout: 60000 });
    maps[driver] = digest(image);
    console.log(`Routekaart voor chauffeur ${driver} gerenderd.`);
  }
  phase = 'planning controleren';
  if (digest(initial) !== digest(await snapshot())) throw new Error('De planning is gewijzigd tijdens het renderen.');
  await writeFile(join(staging, 'manifest.json'), JSON.stringify({ snapshotSha256: digest(initial), maps }), { mode: 0o600 });
  await browser.close();
  browser = undefined;
  phase = 'routekaarten publiceren';
  let hasBackup = false;
  try {
    try { await rename(output, backup); hasBackup = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(staging, output); }
    catch (error) {
      if (hasBackup) await rename(backup, output);
      throw error;
    }
    if (hasBackup) await rm(backup, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log('Routekaarten voltooid.');
} catch (error) {
  console.error(`Routekaarten konden niet worden gerenderd bij ${phase} (${error.name}).`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await rm(staging, { recursive: true, force: true });
}
