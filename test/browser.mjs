import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView, startCameras } from './browser-fixture.mjs';

const live = !!process.env.E2E_BASE_URL, stack = live ? null : await localStack();
const url = process.env.E2E_BASE_URL || stack.url, password = process.env.E2E_ADMIN_KEY || stack.password;
const errors = stack?.errors || [], clients = [];
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const received = page => page.waitForFunction(() => document.querySelectorAll('#host-videos video').length === 1 && document.querySelector('#host-videos video').readyState >= 2 && document.querySelector('#host-videos video').videoHeight === 720, null, { timeout: 45000 });
const synced = (page, zoom, x) => page.waitForFunction(({ zoom, x }) => {
  const controls = document.querySelector('.crop-controls');
  return Number(controls?.querySelector('input').value) === zoom && controls.querySelector('.crop-status').textContent.includes('画面已更新') && (!x || Math.abs(Number(controls.querySelector('.crop-map').getAttribute('aria-valuetext').match(/横向 (\d+)/)[1]) - x * 100) <= 2);
}, { zoom, x });
const sample = (page, color, pip = false) => page.waitForFunction(({ color, pip }) => {
  const v = document.querySelector('#host-videos video'), c = document.createElement('canvas'); c.width = c.height = 1;
  const ctx = c.getContext('2d'); ctx.drawImage(v, v.videoWidth * (pip ? 0.78 : 0.5), v.videoHeight * (pip ? 0.84 : 0.5), 1, 1, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return color === 'red' ? r > 170 && b < 90 : color === 'blue' ? b > 170 && r < 90 : g > 130 && r < 90 && b < 130;
}, { color, pip });
try {
  if (stack) assert.equal(await stack.host.evaluate(() => window.testTracks.length), 0);
  for (let i = 0; i < 2; i++) { const p = await remotePage(browser, errors); clients.push(p); await connectRemote(p, url, password, process.env.E2E_USERNAME || 'admin'); }
  for (const p of clients) {
    await p.waitForFunction(() => window.testPeers.filter(pc => pc.connectionState === 'connected').length === 2, null, { timeout: 45000 });
    await received(p);
    await p.waitForFunction(() => !document.querySelector('#host-camera-toggle').disabled);
    await p.waitForFunction(() => document.querySelectorAll('#remote-videos video').length === 2 && document.querySelectorAll('#remote-audio audio').length === 2);
    await p.waitForFunction(async () => (await Promise.all(window.testPeers.filter(pc => pc.connectionState === 'connected').map(pc => pc.getStats()))).every(s => [...s.values()].some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 0)));
  }
  if (stack) {
    assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().capture), null);
    assert.equal(await stack.host.evaluate(() => window.testMediaRequests.some(r => r.video)), false);
    assert.equal(await clients[0].locator('.crop-controls input').isDisabled(), true);
    // Partial startup failure must release the first camera and allow retry.
    await stack.host.evaluate(() => { window.testCameraFailure = true; });
    await clients[0].locator('#host-camera-toggle').click();
    await clients[0].waitForFunction(() => document.querySelector('#capture-info').textContent.includes('异常'));
    assert.equal(await stack.host.evaluate(() => window.testTracks.filter(t => t.kind === 'video').every(t => t.readyState === 'ended')), true);
    await stack.host.evaluate(() => { window.testCameraFailure = false; });
  }
  await startCameras(clients[0]);
  await clients[1].waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '停止现场摄像头');
  if (stack) {
    assert.deepEqual(await stack.host.evaluate(() => window.hostDiagnostics().capture.sources.map(s => [s.settings.width, s.settings.height])), [[1920, 1080], [640, 360]]);
    assert.equal(await stack.host.evaluate(() => {
      const d = window.hostDiagnostics();
      return document.querySelectorAll('#sources canvas').length === 1 && [...d.peers.values()].every(p => {
        const senders = p.pc.getSenders().filter(s => s.track?.kind === 'video');
        return senders.length === 1 && senders[0].track === d.session.composite.stream.getVideoTracks()[0] && !d.capture.sources.some(c => c.stream.getVideoTracks().includes(senders[0].track));
      });
    }), true);
    assert.equal(await stack.host.evaluate(() => window.testMediaRequests.filter(r => r.video?.deviceId).every(r => r.video.width.max <= 1920 && r.video.height.max <= 1080 && r.video.frameRate.max === 15)), true);
  }
  await setView(clients[0], 0, 2, 0.25);
  await synced(clients[1], 2, 0.25);
  if (stack) for (const p of clients) { await sample(p, 'red'); await sample(p, 'green', true); }
  await setView(clients[1], 0, 2, 0.75);
  await synced(clients[0], 2, 0.75);
  if (stack) for (const p of clients) { await sample(p, 'blue'); await sample(p, 'green', true); }
  console.log('PASS: manual start, bounded acquisition, single shared video track, USB zoom/pan sync and unchanged lower-right PIP pixels.');
  const extra = await remotePage(browser, errors); await extra.goto(url);
  await extra.locator('#username').fill(process.env.E2E_USERNAME || 'admin'); await extra.locator('#admin-key').fill(password); await extra.locator('#mode').selectOption('listen'); await extra.locator('#join-button').click();
  await extra.waitForFunction(() => document.querySelector('#message').textContent.includes('两位远端'));
  await clients[0].locator('#mute').click(); assert.equal(await clients[0].evaluate(() => window.testTracks.filter(t => t.readyState === 'live' && t.kind === 'audio').every(t => !t.enabled)), true); await clients[0].locator('#mute').click();
  await clients[0].locator('#camera-toggle').click(); assert.equal(await clients[0].evaluate(() => window.testTracks.filter(t => t.readyState === 'live' && t.kind === 'video').every(t => !t.enabled)), true); await clients[0].locator('#camera-toggle').click();
  await clients[0].locator('#host-camera-toggle').click();
  await clients[1].waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '启动现场摄像头');
  if (stack) {
    await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null && window.testTracks.filter(t => t.kind === 'video').every(t => t.readyState === 'ended'));
    assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().session.audio.getAudioTracks()[0].readyState), 'live');
  }
  await startCameras(clients[1]); await synced(clients[0], 2, 0.75);
  await clients[0].evaluate(() => window.testSockets.at(-1).close());
  await clients[0].waitForFunction(() => window.testSockets.length >= 2 && window.testPeers.filter(pc => pc.connectionState === 'closed').length >= 2 && window.testPeers.slice(-2).every(pc => pc.connectionState === 'connected'), null, { timeout: 45000 });
  await received(clients[0]); await synced(clients[0], 2, 0.75);
  if (stack) {
    await stack.host.locator('#pause').click();
    await stack.host.waitForFunction(() => window.hostDiagnostics().session === null && window.testTracks.every(t => t.readyState === 'ended'));
    await clients[0].waitForFunction(() => document.querySelector('#capture-info').textContent.includes('离线'));
    await stack.host.locator('#pause').click();
    for (const p of clients) { await received(p); await p.waitForFunction(() => !document.querySelector('#host-camera-toggle').disabled); }
    assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().capture), null);
    await startCameras(clients[0]);
  }
  await clients[0].setViewportSize({ width: 390, height: 844 });
  assert.equal(await clients[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await clients[0].locator('.crop-controls button').click(); await synced(clients[1], 1);
  await clients[0].locator('#leave').click();
  if (stack) {
    assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().session.composite.stream.getVideoTracks()[0].readyState), 'live');
    await sample(clients[1], 'green', true);
  }
  await clients[1].locator('#host-camera-toggle').click(); await clients[1].waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '启动现场摄像头');
  await clients[1].locator('#leave').click();
  for (const p of clients) assert.equal(await p.evaluate(() => window.testTracks.every(t => t.readyState === 'ended')), true);
  if (stack) {
    await stack.host.waitForFunction(() => window.hostDiagnostics().session === null && window.testTracks.every(t => t.readyState === 'ended'));
    // Receive-only viewers can bootstrap the control channel without camera/audio permission.
    const listener = await remotePage(browser, errors); await connectRemote(listener, url, password, 'admin', 'listen'); await received(listener); await startCameras(listener);
    assert.equal(await listener.evaluate(() => window.testMediaRequests.length), 0);
    // Last viewer leaves while camera acquisition is delayed: late devices must be closed.
    await listener.locator('#host-camera-toggle').click();
    await listener.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '启动现场摄像头');
    await stack.host.evaluate(() => { window.testCameraDelay = new Promise(resolve => { window.releaseCameraDelay = resolve; }); });
    await listener.locator('#host-camera-toggle').click();
    await listener.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent.includes('正在启动'));
    await stack.host.locator('#local-camera-toggle').click();
    await listener.locator('#leave').click();
    await stack.host.waitForFunction(() => window.hostDiagnostics().session === null);
    await stack.host.evaluate(() => { window.releaseCameraDelay(); window.testCameraDelay = null; });
    await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null && window.testTracks.every(t => t.readyState === 'ended'));
  }
  assert.deepEqual(errors, []);
  console.log('PASS: stop/restart with audio preserved, capacity, reconnect retains shared view, pause/resume, listener startup, one-viewer removal, idle release, cancellation and mobile layout.');
} catch (error) {
  for (const [i, p] of clients.entries()) console.error('remote', i, await p.evaluate(() => ({ message: document.querySelector('#message').textContent, host: document.querySelector('#capture-info').textContent, controls: [...document.querySelectorAll('.crop-controls')].map(c => ({zoom: c.querySelector('input').value, map: c.querySelector('.crop-map').getAttribute('aria-valuetext'), status: c.querySelector('.crop-status').textContent})), pcs: window.testPeers.map(pc => ({ state: pc.connectionState, signaling: pc.signalingState })) })));
  if (stack) console.error('host', await stack.host.evaluate(() => ({ error: document.querySelector('#error').textContent, state: document.querySelector('#capture-status').textContent })));
  throw error;
} finally { await browser.close(); if (stack) await stack.close(); }
