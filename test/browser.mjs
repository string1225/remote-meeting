import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView } from './browser-fixture.mjs';

const live = !!process.env.E2E_BASE_URL;
const stack = live ? null : await localStack();
const url = process.env.E2E_BASE_URL || stack.url, password = process.env.E2E_ADMIN_KEY || stack.password;
const errors = stack?.errors || [];
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const clients = [];
try {
  await mkdir('test-results', { recursive: true });
  if (stack) assert.equal(await stack.host.evaluate(() => window.testTracks.length), 0);
  for (let i = 0; i < 2; i++) { const p = await remotePage(browser, errors); clients.push(p); await connectRemote(p, url, password, process.env.E2E_USERNAME || 'admin'); }
  for (const p of clients) {
    await p.waitForFunction(() => window.testPeers.filter(pc => pc.connectionState === 'connected').length === 2, null, { timeout: 45000 });
    await p.waitForFunction(live => document.querySelectorAll('#host-videos video').length === 2 && [...document.querySelectorAll('#host-videos video')].every(v => v.readyState >= 2 && (live ? [720,1080].includes(v.videoHeight) : v.videoHeight === 1080) && v.videoWidth === v.videoHeight * 16 / 9), live, { timeout: 45000 });
    await p.waitForFunction(() => document.querySelectorAll('#remote-videos video').length === 2 && document.querySelectorAll('#remote-audio audio').length === 2);
    await p.waitForFunction(async () => { const stats = await Promise.all(window.testPeers.filter(pc => pc.connectionState === 'connected').map(pc => pc.getStats())); return stats.every(s => [...s.values()].some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 0)); });
  }
  if (stack) {
    await stack.host.waitForFunction(() => document.querySelectorAll('#remote-media video').length === 2 && [...document.querySelectorAll('#remote-media video')].every(v => v.readyState >= 2));
    assert.deepEqual(await stack.host.evaluate(() => window.hostDiagnostics().capture.sources.map(s => [s.settings.width, s.settings.height])), [[3840, 2160], [3840, 2160]]);
    assert.equal(await stack.host.evaluate(() => { const d = window.hostDiagnostics(); return [...d.peers.values()].every(p => p.pc.getSenders().filter(s => s.track?.kind === 'video').every(s => !d.capture.sources.some(c => c.stream.getVideoTracks().includes(s.track)))); }), true);
  }
  await setView(clients[0], 0, 2, 0.25); await setView(clients[1], 0, 2, 0.75);
  await setView(clients[0], 1, 3, 0.7);
  if (stack) {
    const sample = async (p, side) => p.waitForFunction(side => { const v = document.querySelector('#host-videos [data-camera="0"] video'), c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(v, v.videoWidth / 2, v.videoHeight / 2, 1, 1, 0, 0, 1, 1); const [r,g,b] = ctx.getImageData(0,0,1,1).data; return side === 'left' ? r > 170 && b < 90 : b > 170 && r < 90; }, side);
    await sample(clients[0], 'left'); await sample(clients[1], 'right');
    await stack.host.waitForFunction(() => { const views = [...window.hostDiagnostics().peers.values()].map(p => p.media.find(m => m.camera === 0).view); return views.some(v => v.x < 0.3) && views.some(v => v.x > 0.7); });
  } else {
    const status = await (await fetch(process.env.E2E_HOST_STATUS_URL || 'http://127.0.0.1:3034/api/status')).json();
    assert.equal(status.capturing, true); assert.equal(status.peers.length, 2); assert.ok(status.peers.some(p => p.views[0].x < 0.3)); assert.ok(status.peers.some(p => p.views[0].x > 0.7));
    console.log('Physical capture resolutions:', status.cameras.map(c => `${c.label}: ${c.width}x${c.height}`).join('; '));
  }
  const extra = await remotePage(browser, errors); await extra.goto(url); await extra.locator('#admin-key').fill(password); await extra.locator('#mode').selectOption('listen'); await extra.locator('#join-button').click(); await extra.waitForFunction(() => document.querySelector('#message').textContent.includes('两位远端'));
  await clients[0].locator('#mute').click(); assert.equal(await clients[0].evaluate(() => window.testTracks.filter(t => t.readyState === 'live' && t.kind === 'audio').every(t => !t.enabled)), true); await clients[0].locator('#mute').click();
  await clients[0].locator('#camera-toggle').click(); assert.equal(await clients[0].evaluate(() => window.testTracks.filter(t => t.readyState === 'live' && t.kind === 'video').every(t => !t.enabled)), true); await clients[0].locator('#camera-toggle').click();
  if (!live) {
    await clients[0].screenshot({ path: 'test-results/remote-crops.png', fullPage: true });
    await stack.host.screenshot({ path: 'test-results/host-console.png', fullPage: true });
  }
  await clients[0].evaluate(() => window.testSockets.at(-1).close());
  await clients[0].waitForFunction(() => window.testSockets.length >= 2 && window.testPeers.filter(pc => pc.connectionState === 'closed').length >= 2 && window.testPeers.slice(-2).every(pc => pc.connectionState === 'connected'), null, { timeout: 45000 });
  await clients[0].waitForFunction(() => document.querySelectorAll('#host-videos video').length === 2 && [...document.querySelectorAll('#host-videos video')].every(v => v.readyState >= 2));
  if (stack) {
    // Pause must close local capture and connections; resuming recreates host links.
    await stack.host.locator('#pause').click();
    await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null);
    await clients[0].waitForFunction(() => document.querySelector('#capture-info').textContent.includes('离线'));
    await stack.host.locator('#pause').click();
    for (const p of clients) await p.waitForFunction(() => window.testPeers.filter(pc => pc.connectionState === 'connected').length === 2 && document.querySelectorAll('#host-videos video').length === 2 && [...document.querySelectorAll('#host-videos video')].every(v => v.readyState >= 2), null, { timeout: 45000 });
    await setView(clients[0], 0, 2, 0.25);
  }
  await clients[0].setViewportSize({ width: 390, height: 844 }); assert.equal(await clients[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (!live) await clients[0].screenshot({ path: 'test-results/remote-mobile.png', fullPage: true });
  await clients[0].locator('.crop-controls[data-camera="0"] button').click(); await clients[0].waitForFunction(() => document.querySelector('.crop-controls[data-camera="0"] .crop-status')?.textContent.includes('1.0×'));
  for (const p of clients) { await p.locator('#leave').click(); assert.equal(await p.evaluate(() => window.testTracks.every(t => t.readyState === 'ended')), true); }
  if (stack) await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null && window.testTracks.every(t => t.readyState === 'ended'));
  else {
    for (let i=0;i<20;i++) { const s=await (await fetch(process.env.E2E_HOST_STATUS_URL || 'http://127.0.0.1:3034/api/status')).json(); if (!s.capturing) break; await new Promise(r=>setTimeout(r,500)); }
    assert.equal((await (await fetch(process.env.E2E_HOST_STATUS_URL || 'http://127.0.0.1:3034/api/status')).json()).capturing, false);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: persistent host wake/idle; 2 remote camera+mic connections; per-viewer/per-camera source-side crops; 1080p received; source tracks never sent; capacity; reconnect; mute; reset; mobile layout.');
} catch (error) {
  for (const [i,p] of clients.entries()) console.error('remote',i,await p.evaluate(() => ({ message:document.querySelector('#message').textContent, host:document.querySelector('#capture-info').textContent, pcs:window.testPeers.map(pc=>({state:pc.connectionState,ice:pc.iceConnectionState,signaling:pc.signalingState})) })));
  if (stack) console.error('host',await stack.host.evaluate(() => ({error:document.querySelector('#error').textContent, state:document.querySelector('#capture-status').textContent, peers:window.testPeers.map(pc=>({state:pc.connectionState,ice:pc.iceConnectionState}))})));
  throw error;
} finally { await browser.close(); if (stack) await stack.close(); }
