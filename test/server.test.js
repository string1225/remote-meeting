import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createMeetingServer } from '../server/app.js';

const key = 'test-only-admin-key-at-least-24-chars';
async function fixture(t, options = {}) {
  const server = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: key, USERS_FILE: ':memory:', ALLOWED_ORIGINS: '', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', data, cookie = '', origin = url) => fetch(`${url}/api/${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const login = (username = 'admin', password = key) => request('login', 'POST', { username, password });
  const create = async (secret = key, origin = url) => {
    const response = await login('admin', secret);
    if (!response.ok) return response;
    return request('rooms', 'POST', undefined, response.headers.get('set-cookie').split(';')[0], origin);
  };
  async function client(invitation, name = 'Test') {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin: url });
    const inbox = [], waiters = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      const index = waiters.findIndex(w => w.type === msg.type);
      if (index >= 0) { const [w] = waiters.splice(index, 1); clearTimeout(w.timer); w.resolve(msg); } else inbox.push(msg);
    });
    const next = type => {
      const index = inbox.findIndex(m => m.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => { const waiter = { type, resolve, timer: setTimeout(() => reject(new Error(`Missing ${type}`)), 2500) }; waiters.push(waiter); });
    };
    await once(ws, 'open');
    const send = msg => ws.send(JSON.stringify(msg));
    if (invitation) send({ type: 'join', ...invitation, name });
    return { ws, next, send, inbox };
  }
  return { server, url, create, client, request, login };
}

test('health, browser security headers, authentication and origin validation', async t => {
  const { url, create } = await fixture(t);
  assert.equal((await create('wrong')).status, 401);
  assert.equal((await create(key, 'https://attacker.example')).status, 403);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /同屏/);
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: 'ok', mode: 'signaling-only' });
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});

test('one host plus two guests; safe routing, invalid credentials, end-room authorization', async t => {
  const { create, client } = await fixture(t);
  const room = await (await create()).json();
  const bad = await client({ room: room.room, token: 'invalid' });
  assert.equal((await bad.next('error')).code, 'AUTH');
  const host = await client({ room: room.room, token: room.hostToken }, 'Host');
  const joinedHost = await host.next('joined');
  assert.equal(joinedHost.self.role, 'host');
  assert.equal(joinedHost.guestToken, room.guestToken);
  const guest = await client({ room: room.room, token: room.guestToken }, 'Guest 1');
  const joinedGuest = await guest.next('joined');
  assert.equal(joinedGuest.peers.length, 1);
  assert.equal(joinedGuest.guestToken, undefined);
  assert.equal(JSON.stringify(joinedGuest).includes(room.hostToken), false);
  const duplicateHost = await client({ room: room.room, token: room.hostToken });
  assert.equal((await duplicateHost.next('error')).code, 'FULL');
  const guest2 = await client({ room: room.room, token: room.guestToken });
  assert.equal((await guest2.next('joined')).peers.length, 2);
  const extra = await client({ room: room.room, token: room.guestToken });
  assert.equal((await extra.next('error')).code, 'FULL');
  guest.send({ type: 'signal', to: joinedHost.self.id, data: { description: { type: 'offer', sdp: 'v=0' }, streams: [{ id: 'cam1', label: '<script>', kind: 'video' }] } });
  const signal = await host.next('signal');
  assert.equal(signal.from, joinedGuest.self.id);
  assert.equal(signal.data.description.sdp, 'v=0');
  guest.send({ type: 'end-room' });
  guest.send({ type: 'signal', to: joinedHost.self.id, data: { candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.equal((await host.next('signal')).data.candidate.candidate, 'candidate:test');
  host.send({ type: 'end-room' });
  await Promise.all([host.next('room-ended'), guest.next('room-ended'), guest2.next('room-ended')]);
  const expired = await client({ room: room.room, token: room.guestToken });
  assert.equal((await expired.next('error')).code, 'EXPIRED');
});

test('room isolation, disconnection frees capacity, and server refuses arbitrary media messages', async t => {
  const { create, client } = await fixture(t);
  const roomA = await (await create()).json(), roomB = await (await create()).json();
  const a = await client({ room: roomA.room, token: roomA.hostToken });
  await a.next('joined');
  const b = await client({ room: roomB.room, token: roomB.hostToken });
  const bj = await b.next('joined');
  a.send({ type: 'signal', to: bj.self.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
  const guest = await client({ room: roomA.room, token: roomA.guestToken });
  await guest.next('joined'); await a.next('peer-joined');
  guest.ws.close(); await a.next('peer-left');
  const again = await client({ room: roomA.room, token: roomA.guestToken });
  const joined = await again.next('joined');
  a.send({ type: 'signal', to: joined.self.id, data: { media: 'data:video/base64,' } });
  // Valid signal sent after rejected traffic forms an ordering barrier.
  a.send({ type: 'signal', to: joined.self.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
  assert.deepEqual((await again.next('signal')).data.description, { type: 'offer', sdp: 'v=0' });
  assert.equal(b.inbox.some(m => m.type === 'signal'), false);
});

test('external TURN credentials are temporary and only returned after valid join', async t => {
  const { create, client } = await fixture(t, { TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: 'test-turn-secret' });
  const room = await (await create()).json();
  const c = await client({ room: room.room, token: room.hostToken });
  const joined = await c.next('joined');
  const turn = joined.iceServers.find(s => s.username);
  assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
  assert.ok(turn.credential);
  assert.equal(JSON.stringify(joined).includes('test-turn-secret'), false);
});

test('invalid payload is rejected without crashing the service', async t => {
  const { client, url } = await fixture(t);
  const c = await client();
  c.ws.send('{oops');
  assert.equal((await c.next('error')).code, 'INVALID');
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

const sessionCookie = response => response.headers.get('set-cookie').split(';')[0];

test('independent host accounts, permissions, short passwords and session cookies', async t => {
  const { request, login, url } = await fixture(t);
  const response = await login();
  const admin = sessionCookie(response);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800/);
  const adminUser = (await response.json()).user;
  assert.equal(adminUser.hash, undefined);
  assert.equal((await request('users')).status, 401);
  assert.equal((await request('rooms', 'POST')).status, 401);
  assert.equal((await request('users', 'POST', { username: 'bad', password: '12345' }, admin)).status, 400);
  const host = (await (await request('users', 'POST', { username: 'Host1', displayName: '主持一', password: '123456' }, admin)).json()).user;
  assert.equal(host.username, 'host1');
  assert.equal(host.role, 'host');
  assert.equal(host.hash, undefined);
  assert.equal((await request('users', 'POST', { username: 'host1', password: '654321' }, admin)).status, 400);
  assert.equal((await login('admin', '123456')).status, 401);
  const hostLogin = await login('HOST1', '123456');
  assert.equal(hostLogin.status, 200);
  const cookie = sessionCookie(hostLogin);
  assert.equal((await request('users', 'GET', undefined, cookie)).status, 403);
  assert.equal((await request(`users/${adminUser.id}`, 'PATCH', { password: '123456' }, cookie)).status, 403);
  assert.equal((await request('rooms', 'POST', undefined, cookie)).status, 201);
  assert.equal((await request('session', 'GET', undefined, cookie)).status, 200);
  assert.equal((await request('users', 'POST', { username: 'attack', password: '123456' }, admin, 'https://attacker.example')).status, 403);
  assert.equal((await request('users', 'POST', { username: 'attack', password: '123456' }, admin, '')).status, 403);
  assert.equal((await request(`users/${adminUser.id}`, 'DELETE', undefined, admin)).status, 400);
  assert.equal((await request(`users/${adminUser.id}`, 'PATCH', { enabled: false }, admin)).status, 400);
  assert.equal((await request(`users/${adminUser.id}`, 'PATCH', { role: 'host' }, admin)).status, 400);
  assert.equal((await request('logout', 'POST', undefined, cookie)).status, 200);
  assert.equal((await (await request('session', 'GET', undefined, cookie)).json()).user, null);
  assert.equal((await request('rooms', 'POST', undefined, cookie)).status, 401);
  // Legacy shared keys cannot bypass account authentication.
  assert.equal((await fetch(`${url}/api/rooms`, { method: 'POST', headers: { Origin: url, Authorization: `Bearer ${key}` } })).status, 401);
});

test('reset, disable and delete revoke old sessions and room invitations', async t => {
  const { request, login, client } = await fixture(t);
  const admin = sessionCookie(await login());
  const user = (await (await request('users', 'POST', { username: 'host2', password: '123456' }, admin)).json()).user;
  let cookie = sessionCookie(await login('host2', '123456'));
  const room = await (await request('rooms', 'POST', undefined, cookie)).json();
  const host = await client({ room: room.room, token: room.hostToken }); await host.next('joined');
  const guest = await client({ room: room.room, token: room.guestToken }); await guest.next('joined');
  assert.equal((await request(`users/${user.id}`, 'PATCH', { password: '654321' }, admin)).status, 200);
  await Promise.all([host.next('room-ended'), guest.next('room-ended')]);
  const revoked = await client({ room: room.room, token: room.hostToken });
  assert.equal((await revoked.next('error')).code, 'EXPIRED');
  assert.equal((await request('rooms', 'POST', undefined, cookie)).status, 401);
  assert.equal((await login('host2', '123456')).status, 401);
  cookie = sessionCookie(await login('host2', '654321'));
  assert.equal((await request(`users/${user.id}`, 'PATCH', { enabled: false }, admin)).status, 200);
  assert.equal((await request('rooms', 'POST', undefined, cookie)).status, 401);
  assert.equal((await login('host2', '654321')).status, 401);
  assert.equal((await request(`users/${user.id}`, 'PATCH', { enabled: true }, admin)).status, 200);
  cookie = sessionCookie(await login('host2', '654321'));
  assert.equal((await request(`users/${user.id}`, 'DELETE', undefined, admin)).status, 200);
  assert.equal((await request('rooms', 'POST', undefined, cookie)).status, 401);
  assert.equal((await login('host2', '654321')).status, 401);
});

test('login throttling and secure cookie scope behind the HTTPS proxy', async t => {
  const { request, login, url } = await fixture(t, { TRUST_PROXY: 'true', COOKIE_PATH: '/meeting/' });
  const response = await fetch(`${url}/api/login`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'admin', password: key }) });
  assert.match(response.headers.get('set-cookie'), /Path=\/meeting\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.equal((await request('login', 'POST', { username: 'a'.repeat(33), password: key })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await login('admin', 'wrong')).status, 401);
  assert.equal((await login()).status, 429);
});
