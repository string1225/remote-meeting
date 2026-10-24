// Opt-in native hardware acceptance. Real media remains in the local test stack; no images are saved.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, setView, duplex } from './browser-fixture.mjs';
import { nativeReceiver, openVirtual, stopVirtual } from './native-receiver.mjs';
const stack = await localStack({ hardware: true }), browser = await chromium.launch(mediaLaunchOptions);
let receiver;
try {
  const remote = await remotePage(browser, stack.errors); await connectRemote(remote, stack.url, stack.password);
  await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'ready', null, { timeout: 40000 });
  const status = stack.local.hostStatus();
  assert.equal(status.cameras.length, 2);
  assert.deepEqual(status.output, { width: 1920, height: 1080, fps: 30 });
  const [usb, pip] = status.cameras;
  assert.ok(usb.width <= 1920 && usb.height <= 1080 && usb.frameRate <= 30.01);
  assert.ok(pip.width <= 640 && pip.height <= 480 && pip.frameRate <= 30.01);
  assert.match(usb.label, /PC Camera|USB/i); assert.match(pip.label, /Surface.*Front/i);
  receiver = await nativeReceiver(); const info = await openVirtual(receiver.page);
  assert.equal(info.settings.width, 1920); assert.equal(info.settings.height, 1080); assert.equal(info.settings.frameRate, 30);
  await setView(remote, 0, 2, 0.25); await stack.host.waitForFunction(() => window.hostDiagnostics().view.zoom === 2);
  await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.measuredFps > 0);
  // Observe output after the receiver has opened; producer frame rate is distinct from device mode.
  await receiver.page.waitForTimeout(6000);
  console.log(JSON.stringify({ cameras: status.cameras, output: status.output, device: info.settings, measuredFps: stack.local.hostStatus().virtualCamera.measuredFps }));
  assert.equal(await remote.evaluate(() => window.testPeers.length), 0);
  await stack.host.locator('#view-cameras').click(); await stack.host.locator('#local-camera-toggle').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'stopped'); await stopVirtual(receiver.page);
  const reopened = await receiver.page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices(), streams = [];
    try {
      for (const name of ['PC Camera (eba4:6579)', 'Surface Camera Front (045e:0990)']) {
        const device = devices.find(d => d.kind === 'videoinput' && d.label === name);
        if (!device) throw new Error('Original camera missing: ' + name);
        streams.push(await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 } }, audio: false }));
      }
      return streams.map(stream => ({ label: stream.getVideoTracks()[0].label, state: stream.getVideoTracks()[0].readyState }));
    } finally { streams.forEach(stream => stream.getTracks().forEach(t => t.stop())); }
  });
  assert.equal(reopened.length, 2); assert.ok(reopened.every(camera => camera.state === 'live'));
  assert.equal(stack.local.hostStatus().peers.length, 1); assert.deepEqual(stack.errors, []);
  console.log('PASS: actual native USB and Surface capture; independent 1080p/30 virtual-camera mode; remote login/start/zoom, web media, and local close allows another app to reacquire both original cameras while control remains connected.');
} catch (error) { console.error(stack.local.hostStatus()); throw error; }
finally { await receiver?.close(); await browser.close(); await stack.close(); }