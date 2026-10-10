// Opt-in Windows OBS driver test. Physical cameras are replaced by colored sources.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView } from './browser-fixture.mjs';

const stack = await localStack({ virtualCamera: { enabled: true } });
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
let receiver;
try {
  await stack.host.locator('#view-cameras').click();
  await stack.host.locator('#local-camera-toggle').click();
  await stack.host.waitForFunction(() => document.querySelector('#virtual-camera-status').textContent.includes('已输出'), null, { timeout: 20000 });
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'ready');
  assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().session.audio), null);
  assert.deepEqual(await stack.host.evaluate(() => window.hostDiagnostics().session.composite.settings), { width: 1920, height: 1080, fps: 30 });
  assert.equal(await stack.host.evaluate(() => window.hostDiagnostics().session.composite.stream.getVideoTracks()[0].getSettings().frameRate), 30);
  receiver = await browser.newPage({ permissions: ['camera'], viewport: { width: 1280, height: 900 } });
  await receiver.goto(stack.url);
  await receiver.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camera = devices.find(d => d.kind === 'videoinput' && d.label === 'OBS Virtual Camera');
    if (!camera) throw new Error('OBS Virtual Camera is not registered');
    const video = document.createElement('video'); video.id = 'virtual-receiver'; video.muted = true; video.playsInline = true;
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camera.deviceId }, width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    document.body.append(video); await video.play();
  });
  await receiver.waitForFunction(() => document.querySelector('#virtual-receiver').videoWidth === 1920 && document.querySelector('#virtual-receiver').videoHeight === 1080);
  assert.equal(await receiver.evaluate(() => document.querySelector('#virtual-receiver').srcObject.getVideoTracks()[0].getSettings().frameRate), 30);
  const remote = await remotePage(browser, stack.errors); await connectRemote(remote, stack.url, stack.password, 'admin', 'listen');
  const sample = (color, pip = false) => receiver.waitForFunction(({ color, pip }) => {
    const video = document.querySelector('#virtual-receiver'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 1920 * (pip ? 0.78 : 0.5), 1080 * (pip ? 0.84 : 0.5), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return color === 'red' ? r > 170 && b < 90 : color === 'blue' ? b > 170 && r < 90 : g > 130 && r < 90 && b < 130;
  }, { color, pip }, { polling: 100 });
  await remote.waitForFunction(() => document.querySelector('.crop-controls input') && !document.querySelector('.crop-controls input').disabled);
  await setView(remote, 0, 2, 0.25); await sample('red'); await sample('green', true);
  await setView(remote, 0, 2, 0.75); await sample('blue'); await sample('green', true);
  await remote.locator('#leave').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().session.audio === null);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'ready'); await sample('blue');
  await receiver.evaluate(() => document.querySelector('#virtual-receiver').srcObject.getTracks().forEach(t => t.stop()));
  await stack.host.locator('#local-camera-toggle').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().session === null);
  for (let attempt = 0; attempt < 50 && stack.local.hostStatus().virtualCamera.state !== 'stopped'; attempt++) await setTimeout(100);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'stopped'); assert.deepEqual(stack.errors, []);
  console.log('PASS: OBS driver receives 1080p/30 pixels; USB remote zoom/pan changes the system camera; lower-right PIP fixed; local-only start uses no microphone; remote departure preserves system output; explicit stop releases worker and devices.');
} catch (error) {
  console.error(stack.local.hostStatus());
  if (receiver) console.error(await receiver.evaluate(() => {
    const video = document.querySelector('#virtual-receiver'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    const pixel = (x, y) => { ctx.drawImage(video, video.videoWidth * x, video.videoHeight * y, 1, 1, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    return { main: pixel(0.5, 0.5), pip: pixel(0.78, 0.84), frames: video.getVideoPlaybackQuality().totalVideoFrames, settings: video.srcObject.getVideoTracks()[0].getSettings() };
  }));
  console.error(await stack.host.evaluate(() => {
    const composite = window.hostDiagnostics().session?.composite;
    if (!composite) return null;
    return { view: composite.snapshot(), main: [...composite.canvas.getContext('2d').getImageData(960, 540, 1, 1).data] };
  }));
  throw error;
}
finally { await browser.close(); await stack.close(); }
