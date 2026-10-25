import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { WebSocket } from 'ws';
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
  assert.deepEqual(calls, [['microphone', true], ['microphone', false], ['camera', true, 1920], ['camera', false]]);
});
