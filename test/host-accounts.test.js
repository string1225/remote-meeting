import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { WebSocket } from 'ws';
import { createHostService } from '../host/service.js';
import { createMeetingServer } from '../server/app.js';
import { createUserStore } from '../server/users.js';

const agentKey = 'local-account-test-machine-key-at-least-32-chars';
async function fixture(t, file = ':memory:') {
  const cloud = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: 'admin-password', USERS_FILE: file, HOST_AGENT_KEY: agentKey, ALLOWED_ORIGINS: '', STUN_URLS: '' });
  cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
  const cloudUrl = `http://127.0.0.1:${cloud.address().port}`;
  const host = createHostService({ serverUrl: cloudUrl + '/', agentKey });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const localUrl = `http://127.0.0.1:${host.address().port}`;
  t.after(async () => { await host.shutdown(); await cloud.shutdown(); });
  const request = (path = '', method = 'GET', data, headers = {}) => fetch(`${localUrl}/api/users${path}`, {
    method, headers: { Origin: localUrl, 'X-Host-Console': '1', 'Content-Type': 'application/json', ...headers }, ...(data ? { body: JSON.stringify(data) } : {})
  });
  const remote = (path, method = 'GET', data, cookie = '') => fetch(`${cloudUrl}/api/${path}`, {
    method, headers: { Origin: cloudUrl, Cookie: cookie, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {})
  });
  const login = (username, password) => remote('login', 'POST', { username, password });
  const session = cookie => remote('session', 'GET', undefined, cookie).then(r => r.json());
  return { cloudUrl, localUrl, request, remote, login, session };
}
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
async function socket(url, options, ticket) {
  const ws = new WebSocket(url, options), messages = [];
  let joined;
  const ready = new Promise(resolve => { joined = resolve; });
  ws.on('message', raw => { const message = JSON.parse(raw); messages.push(message); if (message.type === 'joined') joined(); });
  await once(ws, 'open');
  if (ticket) ws.send(JSON.stringify({ type: 'join', ticket }));
  await ready;
  return { ws, messages };
}

test('local personnel API requires same-origin console headers; machine API cannot manage administrators', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.localUrl + '/api/users')).status, 403);
  assert.equal((await f.request('', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('', 'POST', {}, { Origin: '' })).status, 403);
  const rebound = await new Promise((resolve, reject) => get(f.localUrl + '/api/users', { headers: { Host: 'evil.example', 'X-Host-Console': '1' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(rebound, 403);
  assert.equal((await f.request('/invalid')).status, 404);
  assert.equal((await f.request('', 'POST', { displayName: 'x'.repeat(5000) })).status, 413);
  assert.equal((await f.request('', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  for (const authorization of ['', 'Bearer invalid']) assert.equal((await fetch(f.cloudUrl + '/api/agent/users', { headers: { Authorization: authorization } })).status, 401);
  assert.equal((await fetch(f.cloudUrl + '/api/agent/users', { headers: { Authorization: `Bearer ${agentKey}`, Origin: f.cloudUrl } })).status, 401);
  const admin = (await (await f.login('admin', 'admin-password')).json()).user;
  assert.deepEqual((await (await f.request()).json()).users, []);
  for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(`/${admin.id}`, method, method === 'PATCH' ? { password: 'changed-secret' } : undefined)).status, 404);
  assert.equal((await f.request('', 'POST', { username: 'evil', password: 'secret12', role: 'admin' })).status, 400);
  const user = (await (await f.request('', 'POST', { username: 'alice', displayName: '张三', password: 'alice-key' })).json()).user;
  assert.equal((await f.request(`/${user.id}`, 'PATCH', { role: 'admin' })).status, 400);
  assert.equal((await f.request('', 'POST', { username: 'ALICE', password: 'other-key' })).status, 400);
  assert.equal((await f.request(`/${user.id}`, 'PATCH', { username: 'admin' })).status, 400);
  assert.equal((await f.request(`/${user.id}`, 'PATCH', { username: 'x' })).status, 400);
  assert.equal((await f.request(`/${user.id}`, 'PATCH', { password: '' })).status, 400);
  const data = await (await f.request()).text();
  for (const secret of [agentKey, 'alice-key', 'salt', 'hash']) assert.equal(data.includes(secret), false);
  for (const path of ['/', '/host-app.js', '/host-accounts.js', '/api/status']) assert.equal((await (await fetch(f.localUrl + path)).text()).includes(agentKey), false);
  assert.equal((await f.login('admin', 'admin-password')).status, 200);
});

test('host edits persist; renamed accounts and rotated keys revoke only the affected remote', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-local-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'users.json'), f = await fixture(t, file);
  const create = async (username, displayName, password) => {
    const response = await f.request('', 'POST', { username, displayName, password }); assert.equal(response.status, 201); return (await response.json()).user;
  };
  const a = await create('alice', '张三', 'alice-key'), b = await create('bob', '李四', 'bob-key');
  const host = await socket(f.cloudUrl.replace('http:', 'ws:') + '/agent', { headers: { Authorization: `Bearer ${agentKey}` } });
  const aCookie = cookieOf(await f.login('alice', 'alice-key')), bCookie = cookieOf(await f.login('bob', 'bob-key'));
  async function connect(cookie) {
    const response = await f.remote('connect', 'POST', undefined, cookie); assert.equal(response.status, 201);
    return socket(f.cloudUrl.replace('http:', 'ws:') + '/ws', { origin: f.cloudUrl, headers: { Cookie: cookie } }, (await response.json()).ticket);
  }
  const ar = await connect(aCookie), br = await connect(bCookie);
  assert.equal(ar.messages.find(m => m.type === 'joined').self.name, '张三');
  assert.equal((await f.request(`/${a.id}`, 'PATCH', { displayName: '张老师' })).status, 200);
  assert.equal((await f.session(aCookie)).user.displayName, '张老师');
  const closed = once(ar.ws, 'close');
  assert.equal((await f.request(`/${a.id}`, 'PATCH', { username: 'Alice.New' })).status, 200);
  await closed;
  assert.ok(ar.messages.some(m => m.type === 'ended'));
  assert.equal((await f.session(aCookie)).user, null);
  assert.equal((await f.session(bCookie)).user.id, b.id);
  assert.equal(br.ws.readyState, WebSocket.OPEN); assert.equal(host.ws.readyState, WebSocket.OPEN);
  assert.equal((await f.login('alice', 'alice-key')).status, 401);
  const renamed = await f.login('alice.new', 'alice-key'); assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).user.displayName, '张老师');
  assert.equal((await f.request(`/${a.id}`, 'PATCH', { password: 'new-alice-key' })).status, 200);
  assert.equal((await f.session(cookieOf(renamed))).user, null);
  assert.equal((await f.login('alice.new', 'alice-key')).status, 401);
  assert.equal((await f.login('alice.new', 'new-alice-key')).status, 200);
  const reloaded = createUserStore({ file });
  assert.equal((await reloaded.authenticate('alice.new', 'new-alice-key')).displayName, '张老师');
  const saved = await readFile(file, 'utf8');
  for (const secret of ['alice-key', 'new-alice-key', 'bob-key', agentKey]) assert.equal(saved.includes(secret), false);
  assert.equal((await f.request(`/${a.id}`, 'PATCH', { enabled: false })).status, 200);
  assert.equal((await f.login('alice.new', 'new-alice-key')).status, 401);
  assert.equal((await f.request(`/${a.id}`, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await f.login('alice.new', 'new-alice-key')).status, 200);
  assert.equal((await f.request(`/${a.id}`, 'DELETE')).status, 200);
  assert.equal((await f.login('alice.new', 'new-alice-key')).status, 401);
  assert.equal((await f.session(bCookie)).user.id, b.id);
});

test('unreachable cloud reports failure instead of claiming a local save succeeded', async t => {
  const server = createHostService({ serverUrl: 'http://127.0.0.1:9/', agentKey });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url + '/api/users', { method: 'POST', headers: { Origin: url, 'X-Host-Console': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test', password: 'secret12' }) });
  assert.equal(response.status, 502); assert.match((await response.json()).error, /核对/);
});
