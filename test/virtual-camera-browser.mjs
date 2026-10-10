// Opt-in Windows OBS driver test. Physical cameras are replaced by colored sources.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView } from './browser-fixture.mjs';

const stack = await localStack({ virtualCamera: { enabled: true } });
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  await stack.host.locator('#view-cameras').click();
  await stack.host.locator('#local-camera-toggle').click();
  await stack.host.waitForFunction(() => document.querySelector('#virtual-camera-status').textContent.includes('已输出'), null, { timeout: 20000 });
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'ready');
  assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().session.audio), null);
  const receiver = await browser.newPage({ permissions: ['camera'], viewport: { width: 1280, height: 900 } });
  await receiver.goto(stack.url);
  await receiver.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camera = devices.find(d => d.kind === 'videoinput' && d.label === 'OBS Virtual Camera');
    if (!camera) throw new Error('OBS Virtual Camera is not registered');
    const video = document.createElement('video'); video.id = 'virtual-receiver'; video.muted = true; video.playsInline = true;
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camera.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    document.body.append(video); await video.play();
  });
  await receiver.waitForFunction(() => document.querySelector('#virtual-receiver').videoWidth === 1280 && document.querySelector('#virtual-receiver').videoHeight === 720);
  const remote = await remotePage(browser, stack.errors); await connectRemote(remote, stack.url, stack.password, 'admin', 'listen');
  const sample = (color, pip = false) => receiver.waitForFunction(({ color, pip }) => {
    const video = document.querySelector('#virtual-receiver'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 1280 * (pip ? 0.78 : 0.5), 720 * (pip ? 0.84 : 0.5), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return color === 'red' ? r > 170 && b < 90 : color === 'blue' ? b > 170 && r < 90 : g > 130 && r < 90 && b < 130;
  }, { color, pip });
  await remote.waitForFunction(() => document.querySelector('.crop-controls input') && !document.querySelector('.crop-controls input').disabled);
  await setView(remote, 0, 2, 0.25); await sample('red'); await sample('green', true);
  await setView(remote, 0, 2, 0.75); await sample('blue'); await sample('green', true);
  await remote.locator('#leave').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().session.audio === null);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'ready'); await sample('blue');
  await receiver.evaluate(() => document.querySelector('#virtual-receiver').srcObject.getTracks().forEach(t => t.stop()));
  await stack.host.locator('#local-camera-toggle').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().session === null);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'stopped'); assert.deepEqual(stack.errors, []);
  console.log('PASS: OBS driver receives 720p pixels; USB remote zoom/pan changes the system camera; lower-right PIP fixed; local-only start uses no microphone; remote departure preserves system output; explicit stop releases worker and devices.');
} catch (error) { console.error(stack.local.hostStatus()); throw error; }
finally { await browser.close(); await stack.close(); }
