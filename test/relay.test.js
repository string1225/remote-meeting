import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRelayConfig, isRelayCandidate, relaySdp, mediaCandidate, mediaSdp } from '../server/relay.js';
import { createMeetingServer } from '../server/app.js';
import { relayTestEnv } from './relay-fixture.mjs';

test('missing relay credentials and non-relay policy fail before starting the server', () => {
  for (const options of [{ TURN_URLS: '' }, { TURN_SECRET: '' }, { TURN_SECRET: 'replace-with-a-random-secret-at-least-32-chars' }, { TURN_URLS: 'stun:127.0.0.1:3478' }, { ICE_TRANSPORT_POLICY: 'all' }]) {
    assert.throws(() => createMeetingServer({ ...relayTestEnv, ...options }), /TURN_|ICE_TRANSPORT_POLICY/);
  }
});

test('coturn credentials are short-lived, independently generated and signed without exposing the secret', () => {
  const config = createRelayConfig(relayTestEnv), a = config(), b = config();
  assert.equal(a.iceTransportPolicy, 'relay');
  const { username, credential } = a.iceServers[0];
  assert.notEqual(username, b.iceServers[0].username);
  assert.equal(credential, createHmac('sha1', relayTestEnv.TURN_SECRET).update(username).digest('base64'));
  assert.ok(Math.abs(Number(username.split(':')[0]) - Date.now() / 1000 - 9 * 3600) < 2);
  assert.equal(JSON.stringify(a).includes(relayTestEnv.TURN_SECRET), false);
});

test('host, reflexive and malformed ICE candidates cannot enter relay signaling', () => {
  const candidate = type => `candidate:1 1 udp 1 127.0.0.1 1234 typ ${type}`;
  for (const type of ['host', 'srflx', 'prflx', 'relay-fake']) assert.equal(isRelayCandidate(candidate(type)), false);
  assert.equal(isRelayCandidate(candidate('relay')), true);
  assert.equal(relaySdp(['v=0', ...['host', 'srflx', 'relay'].map(type => 'a=' + candidate(type)), ''].join('\r\n')), 'v=0\r\na=' + candidate('relay') + '\r\n');
});

test('FRP host media admits only its configured UDP endpoint; other channels retain relay filtering', () => {
  const media = createRelayConfig({ ...relayTestEnv, HOST_MEDIA_UDP_ADDRESS: '183.131.59.248', HOST_MEDIA_UDP_PORT: '33574', HOST_MEDIA_BANDWIDTH_MBPS: '10' })().hostMedia;
  const candidate = 'candidate:1 1 udp 1 183.131.59.248 33574 typ host';
  assert.equal(mediaCandidate(candidate, media, true), true);
  for (const invalid of [candidate.replace('33574', '20000'), candidate.replace('183.131.59.248', '192.168.31.150'), candidate.replace('udp', 'tcp'), candidate.replace('host', 'relay')]) assert.equal(mediaCandidate(invalid, media, true), false);
  assert.equal(mediaCandidate(candidate, undefined, true), false);
  assert.equal(mediaCandidate('candidate:2 1 udp 1 browser.local 1234 typ host', media, false), true);
  assert.equal(mediaSdp('v=0\r\na=' + candidate + '\r\na=' + candidate.replace('33574', '20000') + '\r\n', media, true), 'v=0\r\na=' + candidate + '\r\n');
  assert.throws(() => createRelayConfig({ ...relayTestEnv, HOST_MEDIA_UDP_ADDRESS: 'invalid', HOST_MEDIA_UDP_PORT: '33574' }), /HOST_MEDIA_UDP/);
});
