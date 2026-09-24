import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createMeetingServer } from '../server/app.js';

const password = '12345678', agentKey = 'test-machine-key-only-32-characters-long';
async function fixture(t, options = {}) {
  const server = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: password, USERS_FILE: ':memory:', HOST_AGENT_KEY: agentKey, ALLOWED_ORIGINS: '', STUN_URLS: '', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', data, cookie = '', origin = url) => fetch(`${url}/api/${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const login = (username = 'admin', secret = password) => request('login', 'POST', { username, password: secret });
  async function client({ agent = false, cookie = '', ticket, key = agentKey, origin = url } = {}) {
    const ws = new WebSocket(url.replace('http:', 'ws:') + (agent ? '/agent' : '/ws'), { origin, headers: agent ? { Authorization: `Bearer ${key}` } : { Cookie: cookie } });
    const inbox = [], waiters = [];
    ws.on('message', raw => { const m = JSON.parse(raw); const i = waiters.findIndex(w => w.type === m.type); if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); } else inbox.push(m); });
    const next = type => { const i = inbox.findIndex(m => m.type === type); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]); return new Promise((resolve, reject) => { waiters.push({ type, resolve, timer: setTimeout(() => reject(new Error(`Missing ${type}`)), 2500) }); }); };
    await once(ws, 'open');
    const send = m => ws.send(JSON.stringify(m)); if (ticket) send({ type: 'join', ticket });
    return { ws, next, send, inbox };
  }
  const reserve = cookie => request('connect', 'POST', undefined, cookie);
  return { server, url, request, login, client, reserve };
}
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];

test('password authentication, no anonymous admission, host machine key and origin validation', async t => {
  const f = await fixture(t);
  assert.equal((await f.login('admin', 'wrong')).status, 401);
  assert.equal((await f.request('connect', 'POST')).status, 401);
  assert.equal((await f.request('host-status')).status, 401);
  const cookie = cookieOf(await f.login());
  assert.equal((await f.reserve(cookie)).status, 503);
  await assert.rejects(f.client({ agent: true, key: 'wrong' }), /401/);
  await assert.rejects(f.client(), /401/);
  await assert.rejects(f.client({ cookie, origin: 'https://attacker.example' }), /401/);
  const host = await f.client({ agent: true }); assert.equal((await host.next('joined')).self.role, 'host');
  await assert.rejects(f.client({ agent: true }), /409/);
  assert.equal((await f.request('connect', 'POST', undefined, cookie, 'https://attacker.example')).status, 403);
  const page = await fetch(f.url); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${f.url}/.env`)).status, 404);
  assert.equal((await f.request('rooms', 'POST', undefined, cookie)).status, 410);
});

test('one persistent host, two authenticated remotes, isolated tickets and allowlisted signals', async t => {
  const f = await fixture(t); const host = await f.client({ agent: true }); const hj = await host.next('joined');
  const aCookie = cookieOf(await f.login()), bCookie = cookieOf(await f.login()), cCookie = cookieOf(await f.login());
  const a = await (await f.reserve(aCookie)).json(), b = await (await f.reserve(bCookie)).json();
  assert.equal((await f.reserve(cCookie)).status, 409);
  const wrong = await f.client({ cookie: bCookie, ticket: a.ticket }); assert.equal((await wrong.next('error')).code, 'AUTH');
  const ar = await f.client({ cookie: aCookie, ticket: a.ticket }); const aj = await ar.next('joined');
  assert.equal(aj.peers.length, 1); assert.equal(aj.peers[0].role, 'host'); assert.equal(JSON.stringify(aj).includes(agentKey), false);
  const br = await f.client({ cookie: bCookie, ticket: b.ticket }); const bj = await br.next('joined'); assert.equal(bj.peers.length, 2);
  const duplicate = await f.client({ cookie: aCookie, ticket: a.ticket }); assert.equal((await duplicate.next('error')).code, 'FULL');
  ar.send({ type: 'signal', to: hj.self.id, data: { media: 'base64-video' } });
  ar.send({ type: 'signal', to: hj.self.id, data: { description: { type: 'offer', sdp: 'v=0' }, streams: [{ id: 'remote', kind: 'video', camera: 0 }] } });
  const signal = await host.next('signal'); assert.equal(signal.from, aj.self.id); assert.equal(signal.data.streams[0].camera, undefined);
  host.send({ type: 'host-state', state: 'capturing', cameras: [{ width: 3840, height: 2160, label: 'Camera 1' }] });
  assert.equal((await ar.next('host-state')).cameras[0].width, 3840);
  ar.send({ type: 'host-state', state: 'error', message: 'spoofed' });
  assert.equal((await (await f.request('host-status', 'GET', undefined, aCookie)).json()).state, 'capturing');
  ar.send({ type: 'leave' }); await host.next('peer-left');
  assert.equal((await f.reserve(cCookie)).status, 201);
  br.send({ type: 'signal', to: hj.self.id, data: { candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.equal((await host.next('signal')).from, bj.self.id);
});

test('remote reconnect and host reconnect keep the persistent access model', async t => {
  const f = await fixture(t); let host = await f.client({ agent: true }); await host.next('joined');
  const cookie = cookieOf(await f.login()); const { ticket } = await (await f.reserve(cookie)).json();
  let remote = await f.client({ cookie, ticket }); const before = await remote.next('joined');
  remote.ws.terminate(); await host.next('peer-left');
  remote = await f.client({ cookie, ticket }); assert.equal((await remote.next('joined')).self.id, before.self.id);
  host.ws.terminate(); await remote.next('peer-left'); assert.equal((await remote.next('host-state')).state, 'offline');
  host = await f.client({ agent: true }); assert.equal((await host.next('joined')).peers.length, 1);
  assert.equal((await remote.next('peer-joined')).peer.role, 'host');
});

test('account roles and password reset disconnect only that user, preserving the other participant', async t => {
  const f = await fixture(t); const host = await f.client({ agent: true }); const hj = await host.next('joined');
  const login = await f.login(), admin = cookieOf(login), administrator = (await login.json()).user;
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request('users', 'POST', { username: 'bad', password: '12345' }, admin)).status, 400);
  const user = (await (await f.request('users', 'POST', { username: 'operator', password: '654321' }, admin)).json()).user;
  assert.equal(user.hash, undefined);
  const cookie = cookieOf(await f.login('operator', '654321'));
  assert.equal((await f.request('users', 'GET', undefined, cookie)).status, 403);
  const tokenA = await (await f.reserve(cookie)).json(), tokenB = await (await f.reserve(admin)).json();
  const a = await f.client({ cookie, ticket: tokenA.ticket }); await a.next('joined');
  const b = await f.client({ cookie: admin, ticket: tokenB.ticket }); const bj = await b.next('joined');
  assert.equal((await f.request(`users/${administrator.id}`, 'DELETE', undefined, admin)).status, 400);
  assert.equal((await f.request(`users/${administrator.id}`, 'PATCH', { enabled: false }, admin)).status, 400);
  assert.equal((await f.request(`users/${user.id}`, 'PATCH', { password: '987654' }, admin)).status, 200);
  await a.next('ended'); await b.next('peer-left'); assert.equal((await f.reserve(cookie)).status, 401);
  assert.equal((await f.login('operator', '654321')).status, 401);
  const fresh = cookieOf(await f.login('operator', '987654'));
  assert.equal((await f.request(`users/${user.id}`, 'PATCH', { enabled: false }, admin)).status, 200);
  assert.equal((await f.reserve(fresh)).status, 401);
  assert.equal((await f.login('operator', '987654')).status, 401);
  assert.equal((await f.request(`users/${user.id}`, 'DELETE', undefined, admin)).status, 200);
  b.send({ type: 'signal', to: hj.self.id, data: { description: { type: 'offer', sdp: 'v=0' } } }); assert.equal((await host.next('signal')).from, bj.self.id);
  await f.request('logout', 'POST', undefined, admin); await b.next('ended'); assert.equal((await f.reserve(admin)).status, 401);
});

test('login throttle, secure scoped cookie and temporary external TURN credentials', async t => {
  const f = await fixture(t, { TRUST_PROXY: 'true', COOKIE_PATH: '/meeting/', TURN_URLS: 'turn:example.com:3478', TURN_SECRET: 'test-turn-secret' });
  const response = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.match(response.headers.get('set-cookie'), /Path=\/meeting\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  const host = await f.client({ agent: true }); const joined = await host.next('joined'); const turn = joined.iceServers.find(s => s.username);
  assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000); assert.equal(JSON.stringify(joined).includes('test-turn-secret'), false);
  for (let i = 0; i < 10; i++) assert.equal((await f.login('admin', 'wrong')).status, 401);
  assert.equal((await f.login()).status, 429);
});
