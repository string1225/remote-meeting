// Opt-in independent Windows driver acceptance, using synthetic pixels only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, setView, duplex, startCameras } from './browser-fixture.mjs';
import { nativeReceiver, openVirtual, stopVirtual } from './native-receiver.mjs';
const stack = await localStack({ native: true }), browser = await chromium.launch(mediaLaunchOptions);
let receiver;
try {
  const remote = await remotePage(browser, stack.errors); await connectRemote(remote, stack.url, stack.password); await startCameras(remote);
  await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'ready', null, { timeout: 40000 });
  assert.match(stack.local.hostStatus().virtualCamera.device, /^Remote Meeting Camera.*Windows/);

  assert.deepEqual(stack.local.hostStatus().output, { width: 1920, height: 1080, fps: 30 });
  receiver = await nativeReceiver(); const info = await openVirtual(receiver.page);
  assert.equal(info.settings.width, 1920); assert.equal(info.settings.height, 1080); assert.equal(info.settings.frameRate, 30);
  assert.ok(info.devices.includes('OBS Virtual Camera')); assert.ok(info.devices.includes(stack.local.hostStatus().virtualCamera.device));
  const sample = (color, pip = false) => receiver.page.waitForFunction(({ color, pip }) => {
    const video = document.querySelector('#virtual-receiver'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 1920 * (pip ? 0.78 : 0.5), 1080 * (pip ? 0.84 : 0.5), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return color === 'red' ? r > 170 && b < 90 : color === 'blue' ? b > 170 && r < 90 : g > 130 && r < 90 && b < 130;
  }, { color, pip }, { polling: 100 });
  await remote.waitForFunction(() => !document.querySelector('.crop-controls input').disabled);
  await setView(remote, 0, 2, 0.25); await sample('blue'); await sample('green', true);
  await setView(remote, 0, 2, 0.75); await sample('red'); await sample('green', true);
  await remote.locator('#leave').click(); await stack.host.waitForFunction(() => window.hostDiagnostics().peers.length === 0);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'ready'); await sample('red');
  await stack.host.reload(); await stack.host.waitForFunction(() => window.hostDiagnostics()?.capturing); await sample('red');
  await stack.host.locator('#view-cameras').click();

  await stack.host.locator('#local-camera-toggle').click(); await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'stopped');
  await stopVirtual(receiver.page); assert.deepEqual(stack.errors, []);
  console.log('PASS: independent Remote Meeting Camera receives 1080p/30; OBS remains a separate device; remote zoom/pan with fixed PIP; web preview; remote departure and local console reload preserve output; local stop releases worker.');
} catch (error) { console.error(stack.local.hostStatus()); throw error; }
finally { await receiver?.close(); await browser.close(); await stack.close(); }
