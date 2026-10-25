import { once } from 'node:events';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';
import { createHostService } from '../host/service.js';
import { createVirtualCamera } from '../host/virtual-camera.js';
import { createFakeCamera } from './fake-camera.js';
export const launchOptions = { ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true };
export const mediaLaunchOptions = { ...launchOptions, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] };
function pollState(page) {
  const wait = page.waitForFunction.bind(page);
  page.waitForFunction = (expression, arg, options = {}) => wait(expression, arg, { polling: 100, ...options });
  return page;
}
export async function instrument(context) {
  await context.addInitScript(() => {
    window.testMediaRequests = []; window.testPeers = []; window.testSockets = []; window.testMessages = [];
    if (navigator.mediaDevices) for (const method of ['getUserMedia', 'enumerateDevices']) { const original = navigator.mediaDevices[method].bind(navigator.mediaDevices); navigator.mediaDevices[method] = (...args) => { window.testMediaRequests.push({ method, args }); return original(...args); }; }
    const RTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends RTC { constructor(...args) { super(...args); window.testPeers.push(this); } };
    const WS = WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) { super(...args); window.testSockets.push(this); this.addEventListener('message', event => window.testMessages.push(event.data)); }
      send(data) { window.testMessages.push(data); return super.send(data); }
    };
  });
}
export async function localStack({ hardware = false, native = false, virtualCamera = {}, deviceSettingsFile } = {}) {
  const password = '12345678', agentKey = 'test-host-machine-key-32-characters-only';
  const cloud = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: password, HOST_AGENT_KEY: agentKey, USERS_FILE: ':memory:', ALLOWED_ORIGINS: '' });
  cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
  const url = 'http://127.0.0.1:' + cloud.address().port + '/';
  let fake;
  const local = createHostService({ serverUrl: url, agentKey, mediaTest: !hardware && !native, deviceSettingsFile, virtualCamera: { ...virtualCamera, synthetic: native && !hardware } },
    hardware ? {} : native ? { cameraFactory: createVirtualCamera } : { cameraFactory: (config, publish) => { fake = createFakeCamera(config, publish); return fake; } });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const hostBrowser = await chromium.launch(hardware || native ? { ...launchOptions, args: ['--autoplay-policy=no-user-gesture-required'] } : mediaLaunchOptions);
  const context = await hostBrowser.newContext({ viewport: { width: 1280, height: 900 }, permissions: [] }); await instrument(context);
  const host = pollState(await context.newPage()), errors = [];
  host.on('pageerror', e => errors.push('host: ' + e.message));
  await host.goto('http://127.0.0.1:' + local.address().port + '/');
  await host.waitForFunction(() => document.querySelector('#connection').textContent.includes('在线'));
  return { url, password, host, hostBrowser, local, errors, camera: fake, async close() { await hostBrowser.close(); await local.shutdown(); await cloud.shutdown(); } };
}
export async function remotePage(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] }); await instrument(context);
  const page = pollState(await context.newPage()); page.on('pageerror', e => errors.push(e.message)); return page;
}
export async function connectRemote(page, url, password, username = 'admin') {
  await page.goto(url); await page.locator('#username').fill(username); await page.locator('#admin-key').fill(password); await page.locator('#login').click();
  await page.waitForFunction(() => document.querySelector('#signal-status').textContent.includes('已接入'));
}
export async function setView(page, camera, zoom, x) {
  const panel = page.locator('.crop-controls[data-camera="' + camera + '"]');
  await panel.locator('input').fill(String(zoom));
  const map = panel.locator('.crop-map'), box = await map.boundingBox();
  await map.click({ position: { x: box.width * x, y: box.height * 0.5 } });
  await page.waitForFunction(({ zoom }) => document.querySelector('.crop-status')?.textContent.includes(zoom.toFixed(1) + '×'), { zoom });
}
export async function startCameras(page) {
  if (await page.locator('#host-camera-toggle').textContent() === '启动摄像头') await page.locator('#host-camera-toggle').click();
  await page.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '关闭摄像头' && !document.querySelector('#host-camera-toggle').disabled);
}
export async function duplex(page, host = false) {
  await page.waitForFunction(host => {
    const stats = host ? window.hostMediaStats() : window.meetingStats();
    return stats.length > 0 && stats.every(peer => peer.state === 'connected' && peer.receivedAudio > 0 && peer.receivedVideo > 0);
  }, host, { timeout: 30000 });
  await page.waitForFunction(() => Number(document.querySelector('[data-audio-kind="speaker"] [role="meter"]').getAttribute('aria-valuenow')) > 0);
}
