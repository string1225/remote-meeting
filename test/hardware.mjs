// Opt-in actual cameras and OBS output acceptance. Media remains local.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView, startCameras } from './browser-fixture.mjs';
const stack = await localStack({ hardware: true, virtualCamera: { enabled: true } });
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const remote = await remotePage(browser, stack.errors);
  assert.equal(await stack.host.evaluate(() => window.testTracks.length), 0);
  await connectRemote(remote, stack.url, stack.password, 'admin', 'listen');
  await remote.waitForFunction(() => !document.querySelector('#host-camera-toggle').disabled);
  assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().capture), null);
  await startCameras(remote);
  await remote.waitForFunction(() => document.querySelectorAll('#host-videos video').length === 1 && document.querySelector('#host-videos video').videoWidth === 1920 && document.querySelector('#host-videos video').videoHeight === 1080 && document.querySelector('#host-videos video').readyState >= 2, null, { timeout: 60000 });
  await stack.host.waitForFunction(() => document.querySelector('#virtual-camera-status').textContent.includes('已输出'), null, { timeout: 20000 });
  const devices = await stack.host.evaluate(() => {
    const d = window.hostDiagnostics();
    return { cameras: d.capture.sources.map(s => ({ label: s.label, width: s.settings.width, height: s.settings.height, fps: s.settings.frameRate })), microphone: d.session.audio.getAudioTracks()[0].label, output: d.session.composite.settings };
  });
  assert.equal(devices.cameras.length, 2);
  assert.deepEqual(devices.output, { width: 1920, height: 1080, fps: 30 });
  assert.equal(await stack.host.evaluate(() => [...window.hostDiagnostics().peers.values()].every(p => p.pc.getSenders().filter(s => s.track?.kind === 'video').every(s => s.track.getSettings().frameRate === 30 && s.getParameters().encodings.every(e => e.maxFramerate === 30)))), true);
  assert.ok(devices.cameras[0].width <= 1920 && devices.cameras[0].height <= 1080 && devices.cameras[0].fps <= 30);
  assert.ok(devices.cameras[1].width <= 640 && devices.cameras[1].height <= 480 && devices.cameras[1].fps <= 30);
  assert.match(devices.cameras[0].label, /PC Camera|USB/i); assert.match(devices.cameras[1].label, /Surface.*Front/i);
  console.log(JSON.stringify(devices, null, 2));
  await setView(remote, 0, 2, 0.25);
  await stack.host.waitForFunction(() => window.hostDiagnostics().session.composite.view.zoom === 2);
  assert.equal(await stack.host.evaluate(() => {
    const d = window.hostDiagnostics();
    return [...d.peers.values()].every(p => { const video = p.pc.getSenders().filter(s => s.track?.kind === 'video'); return video.length === 1 && video[0].track === d.session.composite.stream.getVideoTracks()[0]; });
  }), true);
  await stack.host.locator('#local-camera-toggle').click();
  await remote.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '启动现场摄像头');
  await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null && window.testTracks.filter(t => t.kind === 'video').every(t => t.readyState === 'ended'));
  for (let attempt = 0; attempt < 50 && stack.local.hostStatus().virtualCamera.state !== 'stopped'; attempt++) await setTimeout(100);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'stopped');
  // Another app/browser must be able to open both original cameras after local close.
  const originalBrowser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream'] });
  try {
    const original = await originalBrowser.newPage({ permissions: ['camera'] }); await original.goto(stack.url);
    const reopened = await original.evaluate(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices(), streams = [];
      try {
        for (const name of ['PC Camera (eba4:6579)', 'Surface Camera Front (045e:0990)']) {
          const device = devices.find(d => d.kind === 'videoinput' && d.label === name);
          if (!device) throw new Error('Original camera missing: ' + name);
          const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 } }, audio: false });
          streams.push(stream);
        }
        return streams.map(stream => ({ label: stream.getVideoTracks()[0].label, state: stream.getVideoTracks()[0].readyState }));
      } finally { for (const stream of streams) stream.getTracks().forEach(t => t.stop()); }
    });
    assert.equal(reopened.length, 2); assert.ok(reopened.every(camera => camera.state === 'live'));
    console.log('PASS: local close releases both original cameras; another browser reacquires USB and Surface while the remote session stays connected.');
  } finally { await originalBrowser.close(); }
  await remote.locator('#leave').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().session === null && window.testTracks.every(t => t.readyState === 'ended'));
  assert.deepEqual(stack.errors, []);
  console.log('PASS: actual bounded USB + Surface capture, shared 1080p/30fps composite over WebRTC and OBS driver, remote start/stop/pan/zoom, and device release.');
} catch (e) { console.error(await stack.host.locator('#error').textContent()); throw e; }
finally { await browser.close(); await stack.close(); }
