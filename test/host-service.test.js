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
