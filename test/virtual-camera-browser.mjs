// Opt-in independent Windows driver acceptance, using synthetic pixels only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { localStack, launchOptions, remotePage, connectRemote, setView, noWebMedia } from './browser-fixture.mjs';
import { nativeReceiver, openVirtual, stopVirtual } from './native-receiver.mjs';
const stack = await localStack({ native: true }), browser = await chromium.launch(launchOptions);
let receiver, obs;
try {
  const remote = await remotePage(browser, stack.errors); await connectRemote(remote, stack.url, stack.password);
  await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'ready', null, { timeout: 40000 });
  assert.equal(stack.local.hostStatus().virtualCamera.device, 'Remote Meeting Camera');
  assert.equal(stack.local.hostStatus().microphone, false);
  assert.deepEqual(stack.local.hostStatus().output, { width: 1920, height: 1080, fps: 30 });
  receiver = await nativeReceiver(); const info = await openVirtual(receiver.page);
  assert.equal(info.settings.width, 1920); assert.equal(info.settings.height, 1080); assert.equal(info.settings.frameRate, 30);
  assert.ok(info.devices.includes('OBS Virtual Camera')); assert.ok(info.devices.includes('Remote Meeting Camera'));
  const sample = (color, pip = false) => receiver.page.waitForFunction(({ color, pip }) => {
    const video = document.querySelector('#virtual-receiver'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 1920 * (pip ? 0.78 : 0.5), 1080 * (pip ? 0.84 : 0.5), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return color === 'red' ? r > 170 && b < 90 : color === 'blue' ? b > 170 && r < 90 : g > 130 && r < 90 && b < 130;
  }, { color, pip }, { polling: 100 });
  await remote.waitForFunction(() => !document.querySelector('.crop-controls input').disabled);
  await setView(remote, 0, 2, 0.25); await sample('red'); await sample('green', true);
  await setView(remote, 0, 2, 0.75); await sample('blue'); await sample('green', true);
  // Exercise OBS's own output concurrently: changing it must not touch our camera.
  obs = spawn(resolve('.local/virtual-camera/Scripts/python.exe'), ['-u', '-c', `
import sys, threading, numpy as np, pyvirtualcam
stop = threading.Event()
threading.Thread(target=lambda: (sys.stdin.read(), stop.set()), daemon=True).start()
frame = np.empty((720, 1280, 3), np.uint8); frame[:] = (190, 20, 190)
with pyvirtualcam.Camera(width=1280, height=720, fps=15, backend='obs') as camera:
    print('READY', flush=True)
    while not stop.is_set():
        camera.send(frame); camera.sleep_until_next_frame()
`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await Promise.race([once(obs.stdout, 'data'), once(obs, 'exit').then(() => { throw new Error('OBS isolation producer failed'); })]);
  await receiver.page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices(), device = devices.find(d => d.label === 'OBS Virtual Camera');
    const video = document.createElement('video'); video.id = 'obs-reference'; video.muted = true;
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { exact: 1280 }, height: { exact: 720 }, frameRate: { ideal: 15, max: 15 } }, audio: false });
    document.body.append(video); await video.play();
  });
  await receiver.page.waitForFunction(() => {
    const video = document.querySelector('#obs-reference'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 640, 360, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; return r > 150 && b > 150 && g < 70;
  }, null, { polling: 100 });
  await sample('blue'); await sample('green', true);
  await receiver.page.evaluate(() => document.querySelector('#obs-reference').srcObject.getTracks().forEach(t => t.stop()));
  obs.stdin.end(); await once(obs, 'close'); obs = null;
  await remote.locator('#leave').click(); await stack.host.waitForFunction(() => window.hostDiagnostics().peers.length === 0);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'ready'); await sample('blue');
  await stack.host.reload(); await stack.host.waitForFunction(() => window.hostDiagnostics()?.capturing); await sample('blue');
  await stack.host.locator('#view-cameras').click();
  for (const page of [stack.host, remote]) assert.deepEqual(await noWebMedia(page), { requests: 0, peers: 0, elements: 0, jsonOnly: true });
  await stack.host.locator('#local-camera-toggle').click(); await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'stopped');
  await stopVirtual(receiver.page); assert.deepEqual(stack.errors, []);
  console.log('PASS: independent Remote Meeting Camera receives 1080p/30; concurrent OBS output has different pixels without affecting our camera; remote zoom/pan with fixed PIP; no web media; remote departure and local console reload preserve output; local stop releases worker.');
} catch (error) { console.error(stack.local.hostStatus()); throw error; }
finally { if (obs) { obs.stdin.end(); obs.kill(); } await receiver?.close(); await browser.close(); await stack.close(); }
