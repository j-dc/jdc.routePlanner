import { createServer } from 'node:http';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { getRouteGeometry } from './geometry.mjs';

const outputDirectory = process.env.ROUTE_OUTPUT_DIR || '/output';
const valhallaUrl = process.env.ROUTE_VALHALLA_URL || 'http://valhalla:8002/';
let runningVersion = null;
const validVersion = version => /^(legacy|\d{8}T\d{13}Z)$/.test(version);
const pathFor = version => join(outputDirectory, version === 'legacy' ? 'routes-status.json' : `routes-status-${version}.json`);

async function writeStatus(version, status) {
  const path = pathFor(version), temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(status), { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function reply(response, code, value) {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return reply(response, 200, { state: 'ok' });
    if (request.method === 'GET' && request.url.startsWith('/geometry/')) {
      const version = request.url.slice('/geometry/'.length);
      if (!validVersion(version)) return reply(response, 404, {});
      const disconnected = new AbortController();
      response.on('close', () => disconnected.abort());
      try {
        const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(600000)]);
        const result = await getRouteGeometry(version, outputDirectory, valhallaUrl, signal);
        return reply(response, 200, result);
      } catch (error) {
        console.error(`Routegeometrie kon niet worden berekend (${error.name}).`);
        return reply(response, 503, { detail: 'Routegeometrie kon niet worden berekend. Controleer Valhalla en de routegegevens.' });
      }
    }
    if (request.method === 'GET' && request.url.startsWith('/status/')) {
      const version = request.url.slice('/status/'.length);
      if (!validVersion(version)) return reply(response, 404, {});
      if (runningVersion) return reply(response, 200, { state: runningVersion === version ? 'running' : 'busy' });
      let status;
      try { status = JSON.parse(await readFile(pathFor(version), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        status = { state: 'idle' };
      }
      return reply(response, 200, status.state === 'running'
        ? { state: 'failed', message: 'De routeberekening is onderbroken.' } : status);
    }
    if (request.method === 'POST' && request.url === '/start') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1048576) return reply(response, 413, { detail: 'De aanvraag is te groot.' });
      }
      let input;
      try { input = JSON.parse(body); } catch { return reply(response, 400, { detail: 'Ongeldige aanvraag.' }); }
      if (!input || !validVersion(input.version) || !Number.isSafeInteger(input.driverCount) || input.driverCount < 1 ||
          !Number.isInteger(input.serviceSeconds) || input.serviceSeconds < 1 || input.serviceSeconds > 2147483647 ||
          !Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 2147483647 ||
          !Number.isInteger(input.reloadSeconds) || input.reloadSeconds < 0 || input.reloadSeconds > 2147483647 ||
          !Number.isInteger(input.maxDifferenceMinutes) || input.maxDifferenceMinutes < 0 || input.maxDifferenceMinutes > 2147483647 ||
          !Array.isArray(input.packageCounts) || input.packageCounts.length < input.driverCount ||
          input.packageCounts.some(count => !Number.isInteger(count) || count < 1 || count > input.capacity) ||
          !/^[A-F0-9]{64}$/.test(input.inputSha256) || !/^[A-F0-9]{64}$/.test(input.matrixSha256))
        return reply(response, 400, { detail: 'Ongeldige invoer voor de routeberekening.' });
      if (runningVersion) return reply(response, 409, { detail: 'Er loopt al een routeberekening.' });
      runningVersion = input.version;
      try {
        await writeStatus(input.version, { state: 'running' });
        const child = spawn(process.execPath, ['/app/calculate.mjs'],
          { stdio: ['pipe', 'pipe', 'inherit'] });
        let output = '';
        child.stdin.on('error', error => console.error(`Route-invoer kon niet worden verzonden (${error.name}).`));
        child.stdin.end(JSON.stringify(input));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', error => console.error(`Routeproces kon niet starten (${error.name}).`));
        child.on('close', async () => {
          let status;
          try {
            status = JSON.parse(output);
            if (!['completed', 'failed'].includes(status.state)) throw new Error('Invalid status');
          } catch {
            status = { state: 'failed', message: 'De routeberekening is onverwacht gestopt.' };
          }
          try { await writeStatus(input.version, status); }
          catch (error) { console.error(`Routestatus kon niet worden opgeslagen (${error.name}).`); }
          runningVersion = null;
        });
        return reply(response, 202, { state: 'running' });
      } catch (error) {
        runningVersion = null;
        throw error;
      }
    }
    return reply(response, 404, {});
  } catch (error) {
    console.error(`Routeworkerfout (${error.name}).`);
    if (!response.headersSent) reply(response, 503, { detail: 'De routeworker is niet beschikbaar.' });
    else response.destroy();
  }
});

server.listen(8083, '0.0.0.0');
