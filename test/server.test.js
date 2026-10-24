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
  async function client({ agent = false, media = false, cookie = '', ticket, key = agentKey, origin = url } = {}) {
    const ws = new WebSocket(url.replace('http:', 'ws:') + (media ? agent ? '/agent-media' : '/media' : agent ? '/agent' : '/ws'), { origin, headers: agent ? { Authorization: `Bearer ${key}` } : { Cookie: cookie } });
    const inbox = [], waiters = [];
    ws.on('message', (raw, binary) => { const m = binary ? { type: 'binary', raw } : JSON.parse(raw); const i = waiters.findIndex(w => w.type === m.type); if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); } else inbox.push(m); });
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

test('two authenticated control panels, isolated tickets and validated camera commands', async t => {
  const f = await fixture(t); const host = await f.client({ agent: true }); const hj = await host.next('joined');
  const aCookie = cookieOf(await f.login()), bCookie = cookieOf(await f.login()), cCookie = cookieOf(await f.login());
  const a = await (await f.reserve(aCookie)).json(), b = await (await f.reserve(bCookie)).json();
  assert.equal((await f.reserve(cCookie)).status, 409);
  const wrong = await f.client({ cookie: bCookie, ticket: a.ticket }); assert.equal((await wrong.next('error')).code, 'AUTH');
  const ar = await f.client({ cookie: aCookie, ticket: a.ticket }); const aj = await ar.next('joined');
  assert.equal(aj.peers.length, 1); assert.equal(aj.peers[0].role, 'host'); assert.equal(JSON.stringify(aj).includes(agentKey), false);
  const br = await f.client({ cookie: bCookie, ticket: b.ticket }); const bj = await br.next('joined'); assert.equal(bj.peers.length, 2);
  const duplicate = await f.client({ cookie: aCookie, ticket: a.ticket }); assert.equal((await duplicate.next('error')).code, 'FULL');
  ar.send({ type: 'control', data: { type: 'viewport', camera: 0, zoom: 2, x: 0, y: 1, media: 'ignored' } });
  const command = await host.next('control'); assert.equal(command.from, aj.self.id);
  assert.deepEqual(command.data, { type: 'viewport', camera: 0, zoom: 2, x: 0.25, y: 0.75 });
  assert.equal(aj.mediaTransport, 'wss-relay');
  host.send({ type: 'host-state', state: 'capturing', cameras: [{ width: 3840, height: 2160, label: 'Camera 1' }] });
  assert.equal((await ar.next('host-state')).cameras[0].width, 3840);
  ar.send({ type: 'host-state', state: 'error', message: 'spoofed' });
  assert.equal((await (await f.request('host-status', 'GET', undefined, aCookie)).json()).state, 'capturing');
  ar.send({ type: 'leave' }); await host.next('peer-left');
  assert.equal((await f.reserve(cCookie)).status, 201);
  br.send({ type: 'control', data: { type: 'camera-stop', media: 'ignored' } });
  const stop = await host.next('control'); assert.equal(stop.from, bj.self.id); assert.deepEqual(stop.data, { type: 'camera-stop' });
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
  b.send({ type: 'control', data: { type: 'camera-start' } }); assert.equal((await host.next('control')).from, bj.self.id);
  await f.request('logout', 'POST', undefined, admin); await b.next('ended'); assert.equal((await f.reserve(admin)).status, 401);
});

test('login throttle and secure scoped cookie; media uses the authenticated web relay', async t => {
  const f = await fixture(t, { TRUST_PROXY: 'true', COOKIE_PATH: '/meeting/' });
  const response = await fetch(`${f.url}/api/login`, { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.match(response.headers.get('set-cookie'), /Path=\/meeting\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  const host = await f.client({ agent: true }); const joined = await host.next('joined');
  assert.equal(joined.mediaTransport, 'wss-relay');
  for (let i = 0; i < 10; i++) assert.equal((await f.login('admin', 'wrong')).status, 401);
  assert.equal((await f.login()).status, 429);
});

test('duplex media permissions and live playback assets', async t => {
  const f = await fixture(t), response = await fetch(f.url);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(self), microphone=(self)');
  assert.match(response.headers.get('content-security-policy'), /media-src 'self' blob:/);
  for (const path of ['relay.js', 'media.js', 'audio-meter.js', 'playback-controls.js']) assert.equal((await fetch(f.url + '/' + path)).status, 200);
});

test('web media binds to the logged-in control identity, relays only opposite roles and closes on logout', async t => {
  const f = await fixture(t), host = await f.client({ agent: true }), hj = await host.next('joined');
  const cookie = cookieOf(await f.login()), otherCookie = cookieOf(await f.login());
  const { ticket } = await (await f.reserve(cookie)).json(), remote = await f.client({ cookie, ticket }); const rj = await remote.next('joined');
  await assert.rejects(f.client({ media: true }), /401/);
  await assert.rejects(f.client({ media: true, agent: true, key: 'bad' }), /401/);
  const wrong = await f.client({ media: true, cookie: otherCookie, ticket }); const wrongClosed = once(wrong.ws, 'close'); await wrongClosed;
  const hm = await f.client({ media: true, agent: true }); await hm.next('media-joined');
  const rm = await f.client({ media: true, cookie, ticket }); await rm.next('media-joined'); await hm.next('media-request');
  hm.send({ type: 'source-start', mime: 'video/webm;codecs=vp8,opus', video: true, audio: true, source: { id: 'spoof' } });
  const source = await rm.next('source-start'); assert.equal(source.source.id, hj.self.id); assert.equal(source.epoch, 1);
  hm.ws.send(Buffer.from([1, 2, 3])); const frame = (await rm.next('binary')).raw;
  assert.equal(frame.subarray(0, 36).toString(), hj.self.id); assert.equal(frame.readUInt32BE(36), 1); assert.deepEqual([...frame.subarray(40)], [1, 2, 3]);
  const secondTicket = (await (await f.reserve(otherCookie)).json()).ticket;
  const other = await f.client({ cookie: otherCookie, ticket: secondTicket }); await other.next('joined');
  const om = await f.client({ media: true, cookie: otherCookie, ticket: secondTicket }); await om.next('media-joined'); await hm.next('media-request');
  rm.send({ type: 'source-start', mime: 'audio/webm;codecs=opus', video: false, audio: true }); assert.equal((await hm.next('source-start')).source.id, rj.self.id);
  rm.ws.send(Buffer.from([9, 8])); assert.equal((await hm.next('binary')).raw.subarray(40).toString('hex'), '0908');
  assert.equal(om.inbox.some(m => ['binary', 'source-start'].includes(m.type)), false);
  const closed = once(rm.ws, 'close'); await f.request('logout', 'POST', undefined, cookie); await closed;
  assert.equal((await hm.next('source-ended')).from, rj.self.id);
  hm.ws.send(Buffer.alloc(2 * 1024 * 1024 + 1)); await once(hm.ws, 'close');
});
