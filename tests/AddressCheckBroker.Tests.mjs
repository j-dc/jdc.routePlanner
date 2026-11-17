import assert from 'node:assert/strict';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const version = '20261117T1234561234567Z';
const otherVersion = '20261117T1234571234567Z';
const socketPath = '/var/run/docker.sock';
const containerId = 'a'.repeat(64);
const geometryId = 'b'.repeat(64);
let state = 'created';
let exitCode = 0;
let project = 'jdc-route-planner';
let starts = 0;
let geometryState = 'created';
let geometryExitCode = 0;
let geometryStarts = 0;

const docker = createServer((request, response) => {
  if (request.url === '/_ping') return response.end('OK');
  if (request.url === '/containers/jdc-route-planner-check-addresses-1/json') {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({ Id: containerId, Config: { Labels: {
      'com.docker.compose.project': project, 'com.docker.compose.service': 'check-addresses',
    } }, State: { Running: state === 'running', Status: state, ExitCode: exitCode, StartedAt: state === 'created' ? 'never' : 'check-run-1' } }));
  }
  if (request.url === '/containers/jdc-route-planner-extract-osm-geometry-1/json') {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({ Id: geometryId, Config: { Labels: {
      'com.docker.compose.project': project, 'com.docker.compose.service': 'extract-osm-geometry',
    } }, State: { Running: geometryState === 'running', Status: geometryState, ExitCode: geometryExitCode,
      StartedAt: geometryState === 'created' ? 'never' : 'geometry-run-1' } }));
  }
  if (request.url === `/containers/${containerId}/start` && request.method === 'POST') {
    starts++;
    state = 'running';
    response.writeHead(204);
    return response.end();
  }
  if (request.url === `/containers/${geometryId}/start` && request.method === 'POST') {
    geometryStarts++;
    geometryState = 'running';
    response.writeHead(204);
    return response.end();
  }
  response.writeHead(404);
  response.end();
});

before(async () => {
  await new Promise(resolve => docker.listen(socketPath, resolve));
  await chmod(socketPath, 0o666);
});
after(async () => {
  await new Promise(resolve => docker.close(resolve));
});

const broker = path => `http://127.0.0.1:8081${path}`;

test('an old completed check does not start geometry after upgrade', async () => {
  state = 'exited';
  await writeFile('/jobs/version', version);
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'completed');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(geometryStarts, 0);
  await unlink('/jobs/version');
  state = 'created';
});

test('only the configured service can start and duplicate starts are rejected', async () => {
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'idle');
  assert.equal((await fetch(broker(`/start/${version}`), { method: 'POST' })).status, 202);
  assert.equal(await readFile('/jobs/version', 'utf8'), version);
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'running');
  assert.equal((await (await fetch(broker(`/status/${otherVersion}`))).json()).state, 'busy');
  assert.equal((await fetch(broker(`/start/${otherVersion}`), { method: 'POST' })).status, 409);
  assert.equal(starts, 1);
  assert.equal((await fetch(broker('/start/invalid'), { method: 'POST' })).status, 404);
});

test('geometry starts after geocoding and completion waits for it', async () => {
  state = 'exited';
  exitCode = 2;
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'running');
  const deadline = Date.now() + 5000;
  while (geometryStarts === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(geometryStarts, 1);
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'running');
  geometryState = 'exited';
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'completed');
  assert.equal((await (await fetch(broker(`/status/${otherVersion}`))).json()).state, 'idle');
  geometryExitCode = 1;
  assert.equal((await (await fetch(broker(`/status/${version}`))).json()).state, 'failed');
  project = 'other-project';
  assert.equal((await fetch(broker(`/start/${otherVersion}`), { method: 'POST' })).status, 503);
  assert.equal(starts, 1);
});