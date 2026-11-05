import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createHostService } from '../host/service.js';

test('local control listener blocks cross-origin sockets and DNS rebinding; no machine key in assets/status', async t => {
  const key = 'host-local-test-machine-credential-32-chars';
  const server = createHostService({ serverUrl: 'http://127.0.0.1:9/', agentKey: key });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const reboundStatus = await new Promise((resolve, reject) => get(url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(reboundStatus, 403);
  for (const path of ['/', '/api/status', '/host-app.js']) assert.equal((await (await fetch(url + path)).text()).includes(key), false);
  assert.equal((await fetch(url + '/.local/host.json')).status, 404);
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/bridge', { origin: 'https://evil.example' });
  await assert.rejects(once(ws, 'open'));
  assert.throws(() => createHostService({ serverUrl: 'http://example.com/', agentKey: key }), /HTTPS/);
});

test('native device APIs work without a renderer and require same-origin console requests', async t => {
  const calls = [], server = createHostService({ serverUrl: 'http://127.0.0.1:9/', agentKey: 'native-api-test-machine-key-32-characters' }, { cameraFactory: () => ({ start: output => calls.push(['camera', true, output.width]), stop: () => calls.push(['camera', false]), microphone: enabled => calls.push(['microphone', enabled]) }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.shutdown());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (kind, data, headers = {}) => fetch(origin + '/api/devices/' + kind, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Host-Console': '1', ...headers }, body: JSON.stringify(data) });
  assert.equal((await fetch(origin)).headers.get('permissions-policy'), 'camera=(), microphone=()');
  assert.equal((await request('camera', { enabled: true }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('camera', { enabled: true }, { 'X-Host-Console': '' })).status, 403);
  assert.equal((await request('camera', { enabled: 'yes' })).status, 400);
  assert.deepEqual(calls, []);
  for (const kind of ['microphone', 'camera']) for (const enabled of [true, false]) assert.equal((await request(kind, { enabled })).status, 202);
  assert.deepEqual(calls, [['microphone', true], ['microphone', false], ['camera', true, 1280], ['camera', false]]);
});

async function waitFor(predicate, timeout = 1000) {
  for (let i = 0; i < timeout / 10; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Host did not reach the expected state');
}

async function cloudHealthFixture(t, options = {}) {
  const cloud = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: options.autoPong !== false });
  await once(cloud, 'listening');
  const connections = [], changes = [];
  const joined = ws => ws.send(JSON.stringify({ type: 'joined', self: { id: 'host', role: 'host' }, peers: [], iceServers: [] }));
  cloud.on('connection', ws => { connections.push(ws); if (options.register !== false) joined(ws); });
  const server = createHostService({ serverUrl: `http://127.0.0.1:${cloud.address().port}/`, agentKey: 'cloud-watchdog-test-machine-key-32-characters' }, {
    cameraFactory: () => ({ shutdown() {} }), heartbeatMs: 20, heartbeatTimeoutMs: 140, registrationTimeoutMs: options.registrationTimeoutMs || 1000
  });
  server.on('cloud-state', state => changes.push(state));
  t.after(async () => { await server.shutdown(); for (const ws of cloud.clients) ws.terminate(); await new Promise(resolve => cloud.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await waitFor(() => connections.length > 0);
  return { server, connections, changes, joined };
}

test('an open socket is offline until the cloud acknowledges host registration', async t => {
  const f = await cloudHealthFixture(t, { register: false });
  assert.equal(f.server.hostStatus().online, false);
  f.joined(f.connections[0]);
  await waitFor(() => f.server.hostStatus().online);
  assert.equal(f.server.hostStatus().cloudConnection.state, 'registered');
  assert.ok(f.server.hostStatus().cloudConnection.lastRegisteredAt);
});

test('a silent half-open connection is terminated and registers again without restarting the host', { timeout: 5000 }, async t => {
  const f = await cloudHealthFixture(t, { autoPong: false });
  await waitFor(() => f.server.hostStatus().online);
  await waitFor(() => !f.server.hostStatus().online);
  await waitFor(() => f.connections.length >= 2, 3000);
  await waitFor(() => f.server.hostStatus().online);
  assert.ok(f.changes.some(s => s.lastError.includes('heartbeat timed out')));
});

test('idle registered connections stay online through heartbeat replies', { timeout: 3000 }, async t => {
  const f = await cloudHealthFixture(t);
  await waitFor(() => f.server.hostStatus().online);
  await delay(450);
  assert.equal(f.server.hostStatus().online, true);
  assert.equal(f.connections.length, 1);
});

test('missing registration acknowledgement forces a retry even when WebSocket pongs arrive', { timeout: 5000 }, async t => {
  const f = await cloudHealthFixture(t, { register: false, registrationTimeoutMs: 100 });
  await waitFor(() => f.connections.length >= 2, 3000);
  assert.equal(f.server.hostStatus().online, false);
  assert.ok(f.changes.some(s => s.lastError.includes('registration timed out')));
});

async function cameraLifecycle(t, state = 'ready') {
  const cloud = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(cloud, 'listening');
  const camera = { starts: 0, stops: 0, peers: new Set() };
  const server = createHostService({ serverUrl: `http://127.0.0.1:${cloud.address().port}/`, agentKey: 'camera-lifecycle-test-machine-key-32-characters' }, {
    cameraFactory: (config, publish) => ({
      start() { camera.starts++; publish({ type: 'virtual-camera-state', state, cameras: [{ label: 'USB' }, { label: 'Front' }] }); },
      stop() { camera.stops++; publish({ type: 'virtual-camera-state', state: 'stopped' }); },
      microphone(enabled) { publish({ type: 'microphone-state', state: enabled ? 'ready' : 'stopped' }); },
      peerAdd(id) { camera.peers.add(id); }, peerRemove(id) { camera.peers.delete(id); },
      shutdown() {}
    })
  });
  t.after(async () => { await server.shutdown(); for (const ws of cloud.clients) ws.terminate(); await new Promise(resolve => cloud.close(resolve)); });
  const connection = once(cloud, 'connection');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const [ws] = await connection, origin = `http://127.0.0.1:${server.address().port}`;
  const send = message => ws.send(JSON.stringify(message));
  const joined = peers => send({ type: 'joined', self: { id: 'host', role: 'host' }, peers, iceServers: [] });
  const remote = id => ({ id, role: 'remote', name: id });
  const device = (kind, enabled) => fetch(origin + '/api/devices/' + kind, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Host-Console': '1' }, body: JSON.stringify({ enabled }) });
  return { server, camera, ws, origin, send, joined, remote, device };
}

test('only the last remote departure releases cameras; local preview and microphone remain independent', { timeout: 10000 }, async t => {
  const f = await cameraLifecycle(t);
  f.joined([]);
  await f.device('camera', true); await f.device('microphone', true);
  assert.equal(f.server.hostStatus().capturing, true);
  assert.equal(f.camera.stops, 0);
  for (const id of ['a', 'b']) f.send({ type: 'peer-joined', peer: f.remote(id) });
  await waitFor(() => f.server.hostStatus().peers.length === 2);
  f.send({ type: 'peer-left', id: 'a' });
  await waitFor(() => f.server.hostStatus().peers.length === 1);
  assert.equal(f.server.hostStatus().capturing, true);
  assert.equal(f.camera.stops, 0);
  f.send({ type: 'peer-left', id: 'b' });
  await waitFor(() => f.server.hostStatus().peers.length === 0);
  assert.equal(f.server.hostStatus().capturing, false);
  assert.deepEqual(f.server.hostStatus().cameras, []);
  assert.equal(f.server.hostStatus().microphone, true);
  assert.equal(f.camera.peers.size, 0);
  assert.equal(f.camera.stops, 1);
  f.send({ type: 'peer-joined', peer: f.remote('a') });
  await waitFor(() => f.server.hostStatus().peers.length === 1);
  assert.equal(f.server.hostStatus().capturing, false);
  assert.equal(f.camera.starts, 1);
  await f.device('camera', true);
  assert.equal(f.server.hostStatus().capturing, true);
});

test('losing all remotes also stops active or starting cameras on cloud disconnect, pause and peer snapshots', async t => {
  for (const state of ['ready', 'starting']) for (const reason of ['cloud-close', 'bridge-pause', 'empty-snapshot', 'last-peer-left']) await t.test(`${state}: ${reason}`, { timeout: 5000 }, async t => {
    const f = await cameraLifecycle(t, state);
    f.joined([f.remote('a')]);
    await waitFor(() => f.server.hostStatus().peers.length === 1);
    await f.device('camera', true);
    assert.equal(f.server.hostStatus().virtualCamera.state, state);
    if (reason === 'cloud-close') f.ws.terminate();
    else if (reason === 'empty-snapshot') f.joined([]);
    else if (reason === 'last-peer-left') f.send({ type: 'peer-left', id: 'a' });
    else {
      const renderer = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', { origin: f.origin });
      t.after(() => renderer.terminate());
      await once(renderer, 'open');
      renderer.send(JSON.stringify({ type: 'bridge-pause' }));
    }
    await waitFor(() => f.server.hostStatus().peers.length === 0);
    assert.equal(f.server.hostStatus().virtualCamera.state, 'stopped');
    assert.equal(f.camera.stops, 1);
    assert.equal(f.camera.peers.size, 0);
  });
});
