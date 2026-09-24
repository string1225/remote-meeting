import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';

const adminKey = 'e2e-test-only-admin-key-32-characters';
const server = createMeetingServer({ ADMIN_KEY: adminKey, ALLOWED_ORIGINS: '', STUN_URLS: '' });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
await mkdir('test-results', { recursive: true });
async function page(name) {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.testPeers = []; window.testSockets = []; window.testTracks = [];
    const NativePC = window.RTCPeerConnection, NativeWS = window.WebSocket;
    window.RTCPeerConnection = class extends NativePC { constructor(...args) { super(...args); window.testPeers.push(this); } };
    window.WebSocket = class extends NativeWS { constructor(...args) { super(...args); window.testSockets.push(this); } };
    const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [...(await enumerate()).filter(d => d.kind !== 'videoinput'), ...[1, 2].map(i => ({ kind: 'videoinput', deviceId: `test-camera-${i}`, label: `Test camera ${i}`, groupId: `camera-${i}` }))];
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.video?.deviceId?.exact?.startsWith('test-camera-')) {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); const second = constraints.video.deviceId.exact.endsWith('2');
        let counter = 0;
        const draw = () => { ctx.fillStyle = second ? '#16756a' : '#24364a'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#fff'; ctx.font = '36px sans-serif'; ctx.fillText(`Camera ${second ? 2 : 1} / frame ${counter++}`, 30, 170); };
        draw(); const timer = setInterval(draw, 100); const stream = canvas.captureStream(10);
        stream.getTracks()[0].addEventListener('ended', () => clearInterval(timer));
        window.testTracks.push(...stream.getTracks()); return stream;
      }
      const stream = await nativeCapture(constraints); window.testTracks.push(...stream.getTracks()); return stream;
    };
  });
  const p = await context.newPage();
  p.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  return p;
}
try {
  const host = await page('host'); await host.goto(url);
  await host.screenshot({ path: 'test-results/lobby.png', fullPage: true });
  await host.locator('#admin-key').fill(adminKey);
  await host.locator('#devices-button').click();
  await host.locator('#camera2').selectOption('test-camera-2');
  await host.locator('#join-button').click();
  await host.waitForFunction(() => document.querySelector('#signal-status').textContent.includes('在线'));
  assert.equal(await host.locator('.video-card video').count(), 2);
  // Retrieve the generated guest invitation through the user-facing copy action.
  await host.evaluate(() => { navigator.clipboard.writeText = async value => { window.copiedInvite = value; }; });
  await host.locator('#invite').click();
  const invite = await host.evaluate(() => window.copiedInvite);
  assert.ok(invite.includes('#room='));
  const guests = [];
  for (let i = 1; i <= 2; i++) {
    const guest = await page(`guest${i}`); guests.push(guest);
    await guest.goto(invite); await guest.locator('#name').fill(`Guest ${i}`);
    await guest.locator('#devices-button').click(); await guest.locator('#join-button').click();
  }
  for (const p of [host, ...guests]) {
    await p.waitForFunction(() => window.testPeers.filter(pc => pc.connectionState === 'connected').length === 2, { timeout: 25000 });
    await p.waitForFunction(() => [...document.querySelectorAll('.video-card video')].length === 4 && [...document.querySelectorAll('.video-card video')].every(v => v.readyState >= 2 && v.videoWidth > 0), { timeout: 25000 });
    await p.waitForFunction(() => document.querySelectorAll('#video-grid audio').length === 2);
    await p.waitForFunction(async () => {
      const stats = await Promise.all(window.testPeers.filter(pc => pc.connectionState === 'connected').map(pc => pc.getStats()));
      return stats.every(s => [...s.values()].some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 0));
    });
    assert.equal(await p.locator('#people-count').textContent(), '3 / 3');
  }
  await host.waitForFunction(() => document.querySelector('#participants').textContent.includes('P2P 直连'));
  await host.screenshot({ path: 'test-results/meeting.png', fullPage: true });
  await host.locator('#mute').click();
  assert.equal(await host.evaluate(() => window.testTracks.filter(t => t.readyState === 'live' && t.kind === 'audio').every(t => !t.enabled)), true);
  await host.locator('#mute').click();
  await host.locator('#camera-toggle').click();
  assert.equal(await host.evaluate(() => window.testTracks.filter(t => t.readyState === 'live' && t.kind === 'video').every(t => !t.enabled)), true);
  await host.locator('#camera-toggle').click();
  const fourth = await page('fourth'); await fourth.goto(invite); await fourth.locator('#mode').selectOption('listen'); await fourth.locator('#join-button').click();
  await fourth.waitForFunction(() => document.querySelector('#message').textContent.includes('会议已满'));
  assert.equal(await fourth.locator('#lobby').isVisible(), true);
  // Signal reconnect must restore all peer connections and keep dual-camera media.
  await guests[0].evaluate(() => window.testSockets.at(-1).close());
  await guests[0].waitForFunction(() => window.testSockets.length >= 2);
  await guests[0].waitForFunction(() => window.testPeers.filter(pc => pc.connectionState === 'connected').length === 2);
  await guests[0].waitForFunction(() => document.querySelectorAll('.video-card video').length === 4 && [...document.querySelectorAll('.video-card video')].every(v => v.readyState >= 2));
  await guests[1].locator('#leave').click();
  await host.waitForFunction(() => document.querySelector('#people-count').textContent === '2 / 3');
  assert.equal(await guests[1].evaluate(() => window.testTracks.every(t => t.readyState === 'ended')), true);
  // Rejoin as receive-only and ensure two host cameras still arrive.
  await guests[1].locator('#mode').selectOption('listen'); await guests[1].locator('#join-button').click();
  await guests[1].waitForFunction(() => document.querySelectorAll('.video-card video').length === 3 && [...document.querySelectorAll('.video-card video')].every(v => v.readyState >= 2));
  await host.setViewportSize({ width: 390, height: 844 });
  assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await host.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  host.on('dialog', dialog => dialog.accept()); await host.locator('#end-room').click();
  for (const p of [host, ...guests]) { await p.waitForFunction(() => !document.querySelector('#lobby').hidden); assert.equal(await p.evaluate(() => window.testTracks.every(t => t.readyState === 'ended')), true); }
  assert.deepEqual(errors, []);
  console.log('PASS: real WebRTC dual-camera/video/audio across 3 browser contexts; room limit; mute; reconnect; receive-only rejoin; room end; mobile layout.');
} catch (error) {
  for (const context of browser.contexts()) for (const p of context.pages()) {
    console.error(await p.evaluate(() => ({ message: document.querySelector('#message')?.textContent, participants: document.querySelector('#participants')?.textContent, pcs: window.testPeers?.map(pc => ({ state: pc.connectionState, signaling: pc.signalingState, ice: pc.iceConnectionState })) })));
  }
  throw error;
} finally { await browser.close(); await server.shutdown(); }
