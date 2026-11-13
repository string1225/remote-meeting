import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createMeetingServer } from '../server/app.js';
import { createWakeBroker } from '../server/wol.js';
import { relayTestEnv } from './relay-fixture.mjs';

const key = 'test-nas-key-separate-from-the-host-credential';
const hostKey = 'test-host-key-separate-from-the-nas-credential';
async function fixture(t, env = {}) {
  const server = createMeetingServer({ ...relayTestEnv, HOST_AGENT_KEY: hostKey, WOL_AGENT_KEY: key, USERS_FILE: ':memory:', BOOTSTRAP_ADMIN_PASSWORD: '12345678', ...env });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => server.shutdown());
  async function api(path, { method = 'GET', cookie, authorization, origin = base, data, signal } = {}) {
    return fetch(base + '/api/' + path, { method, signal, headers: {
      ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  }
  const login = await api('login', { method: 'POST', data: { username: 'admin', password: '12345678' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { api, cookie, base, poll: (data = { configured: ['basement'] }, extra = {}) => api('wol/agent/poll', { method: 'POST', origin: null, authorization: key, data, ...extra }) };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Condition was not reached');
}

test('WOL auth is separate, same-origin, and usable while the meeting host is off', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('wol')).status, 401);
  assert.equal((await f.poll(undefined, { authorization: hostKey })).status, 401);
  assert.equal((await f.poll(undefined, { authorization: 'undefined' })).status, 401);
  assert.equal((await f.poll(undefined, { origin: f.base })).status, 401);
  assert.equal((await f.api('agent/status', { origin: null, authorization: key })).status, 401);
  assert.equal((await f.poll({ configured: ['unapproved-pc'] })).status, 400);
  assert.equal((await f.poll({ configured: ['basement'], result: { id: 'x', ok: 'true' } })).status, 400);
  const state = await (await f.api('wol', { cookie: f.cookie })).json();
  assert.equal(state.online, false); assert.equal(state.targets.length, 2);
  assert.equal(JSON.stringify(state).includes(key), false);
  assert.equal((await f.api('wol/basement/wake', { method: 'POST', cookie: f.cookie, origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.api('wol/basement/wake', { method: 'POST', cookie: f.cookie })).status, 503);
  assert.equal((await f.api('wol/unknown/wake', { method: 'POST', cookie: f.cookie })).status, 404);
  const poll = f.poll();
  await until(async () => (await (await f.api('wol', { cookie: f.cookie })).json()).online);
  assert.equal((await f.api('wol/small-room/wake', { method: 'POST', cookie: f.cookie })).status, 409);
  const wake = f.api('wol/basement/wake', { method: 'POST', cookie: f.cookie });
  const { command } = await (await poll).json();
  assert.equal(command.target, 'basement'); assert.ok(command.expiresAt > Date.now());
  assert.equal((await f.api('wol/basement/wake', { method: 'POST', cookie: f.cookie })).status, 429);
  const nextPoll = f.poll({ configured: ['basement'], result: { id: command.id, ok: true } });
  const result = await (await wake).json(); assert.equal(result.ok, true);
  const confirmed = await (await f.api('wol', { cookie: f.cookie })).json();
  assert.ok(confirmed.targets.find(target => target.id === 'basement').lastSentAt);
  assert.equal((await f.api('host-status', { cookie: f.cookie })).status, 200);
  assert.equal((await f.api('connect', { method: 'POST', cookie: f.cookie })).status, 503);
  // A normal remote account has the same explicit permission to wake computers.
  await f.api('users', { method: 'POST', cookie: f.cookie, data: { username: 'remote', password: '12345678', role: 'host' } });
  const userLogin = await f.api('login', { method: 'POST', data: { username: 'remote', password: '12345678' } });
  const userCookie = userLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.api('wol', { cookie: userCookie })).status, 200);
  await f.api('logout', { method: 'POST', cookie: userCookie });
  assert.equal((await f.api('wol/basement/wake', { method: 'POST', cookie: userCookie })).status, 401);
  // Duplicate long-polls cannot replace the connected agent.
  await until(async () => (await (await f.api('wol', { cookie: f.cookie })).json()).online);
  assert.equal((await f.poll()).status, 409);
  // Releasing the server also releases its pending poll immediately.
  const close = f.poll(undefined, { method: 'GET', data: undefined }); assert.equal((await close).status, 405);
  // Keep the promise handled while t.after closes the server.
  t.after(async () => { const response = await nextPoll; assert.equal(response.status, 200); });
});

test('unconfigured service never authenticates a missing NAS key', async t => {
  const f = await fixture(t, { WOL_AGENT_KEY: '' });
  assert.equal((await f.poll(undefined, { authorization: 'undefined' })).status, 401);
  const state = await (await f.api('wol', { cookie: f.cookie })).json(); assert.equal(state.enabled, false);
  assert.equal((await f.api('wol/basement/wake', { method: 'POST', cookie: f.cookie })).status, 503);
});

function brokerPoll(broker, input) {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const res = { destroyed: false, once() {}, off() {} };
  broker.poll(input, res, (_res, _status, data) => resolve(data));
  return response;
}

test('commands expire without replay; failure receipts and stale NAS are honest', async () => {
  const broker = createWakeBroker({ enabled: true, pollMs: 30, commandMs: 20, cooldownMs: 0, onlineMs: 100 });
  try {
    await brokerPoll(broker, { configured: ['basement'] });
    await assert.rejects(broker.wake('basement'), error => error.status === 504);
    const recovered = await brokerPoll(broker, { configured: ['basement'] });
    assert.equal(recovered.command, null);
    const poll = brokerPoll(broker, { configured: ['basement'] });
    const wake = broker.wake('basement');
    const { command } = await poll;
    const failed = assert.rejects(wake, error => error.status === 502);
    await brokerPoll(broker, { configured: ['basement'], result: { id: command.id, ok: false } });
    await failed;
    assert.equal(broker.status().targets[1].lastSentAt, null);
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(broker.status().online, false);
    assert.throws(() => broker.wake('basement'), error => error.status === 503);
  } finally { broker.shutdown(); }
});
