import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRecover } from '../host/health-check.js';

function fixture({ local = true, registered = true, upstream = true, mismatched = false, paused = false } = {}) {
  let time = 0;
  const calls = [], config = { serverUrl: 'https://cloud.example/meeting/', agentKey: 'health-check-test-key', port: 3034 };
  const request = async (url, options = {}) => {
    url = String(url); calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/api/connection/reconnect')) { assert.equal(options.headers.Origin, 'http://127.0.0.1:3034'); registered = true; mismatched = false; return new Response('{}', { status: 202 }); }
    if (url.startsWith('http://127.0.0.1')) {
      if (!local) throw new Error('Connection refused');
      return Response.json({ service: 'remote-meeting-host', online: true, renderer: true, paused, cloudConnection: { hostId: 'current-host' } });
    }
    assert.equal(options.headers.Authorization, 'Bearer ' + config.agentKey);
    if (!upstream) throw new Error('Cloud unavailable');
    return Response.json({ online: registered, hostId: mismatched ? 'other-host' : 'current-host' });
  };
  const options = { request, now: () => time, wait: async ms => { time += ms; }, recoveryMs: 10, pollMs: 1, startGuard: async () => { local = true; registered = true; }, restartHost: async () => assert.fail('An ordinary cloud failure must not restart devices') };
  return { config, options, calls };
}
test('scheduled health verifies cloud registration and leaves healthy services untouched', async () => {
  const f = fixture(); const r = await checkAndRecover(f.config, f.options);
  assert.equal(r.healthy, true); assert.deepEqual(r.actions, []);
});
test('scheduled health starts an absent local host and waits for cloud registration', async () => {
  const f = fixture({ local: false }); const r = await checkAndRecover(f.config, f.options);
  assert.equal(r.healthy, true); assert.deepEqual(r.actions, ['start-guard']);
});
test('cloud-side missing or mismatched registration triggers targeted reconnection', async () => {
  for (const setting of [{ registered: false }, { mismatched: true }]) {
    const f = fixture(setting); const r = await checkAndRecover(f.config, f.options);
    assert.equal(r.healthy, true); assert.deepEqual(r.actions, ['reconnect-cloud']);
  }
});
test('an upstream outage is reported without restarting working local devices', async () => {
  const f = fixture({ upstream: false }); const r = await checkAndRecover(f.config, f.options);
  assert.equal(r.healthy, false); assert.deepEqual(r.actions, []);
});
test('minute watchdog checks the local registered heartbeat without querying the cloud', async () => {
  const f = fixture({ upstream: false }); const r = await checkAndRecover(f.config, { ...f.options, localOnly: true });
  assert.equal(r.healthy, true); assert.equal(r.cloudVerified, false);
  assert.ok(f.calls.every(call => call.url.startsWith('http://127.0.0.1')));
});
test('operator pause is preserved rather than silently undone by recovery', async () => {
  const f = fixture({ paused: true }); const r = await checkAndRecover(f.config, f.options);
  assert.ok(r.skipped); assert.deepEqual(r.actions, []); assert.equal(f.calls.length, 1);
});
