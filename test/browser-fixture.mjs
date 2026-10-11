import { once } from 'node:events';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';
import { createHostService } from '../host/service.js';
import { createFakeCamera } from './fake-camera.js';
export const launchOptions = { ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true };
function pollState(page) {
  const wait = page.waitForFunction.bind(page);
  page.waitForFunction = (expression, arg, options = {}) => wait(expression, arg, { polling: 100, ...options });
  return page;
}
export async function instrument(context) {
  await context.addInitScript(() => {
    window.testMediaRequests = []; window.testPeers = []; window.testSockets = []; window.testMessages = [];
    if (navigator.mediaDevices) for (const method of ['getUserMedia', 'enumerateDevices']) navigator.mediaDevices[method] = async (...args) => { window.testMediaRequests.push({ method, args }); throw new Error('Web media APIs must never be called'); };
    window.RTCPeerConnection = class { constructor() { window.testPeers.push(true); throw new Error('WebRTC must never be created'); } };
    const WS = WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) { super(...args); window.testSockets.push(this); this.addEventListener('message', event => window.testMessages.push(event.data)); }
      send(data) { window.testMessages.push(data); return super.send(data); }
    };
  });
}
export async function localStack({ hardware = false, native = false, virtualCamera = {} } = {}) {
  const password = '12345678', agentKey = 'test-host-machine-key-32-characters-only';
  const cloud = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: password, HOST_AGENT_KEY: agentKey, USERS_FILE: ':memory:', ALLOWED_ORIGINS: '' });
  cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
  const url = 'http://127.0.0.1:' + cloud.address().port + '/';
  let fake;
  const local = createHostService({ serverUrl: url, agentKey, virtualCamera: { ...virtualCamera, synthetic: native && !hardware } },
    hardware || native ? {} : { cameraFactory: (config, publish) => { fake = createFakeCamera(config, publish); return fake; } });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const hostBrowser = await chromium.launch(launchOptions);
  const context = await hostBrowser.newContext({ viewport: { width: 1280, height: 900 } }); await instrument(context);
  const host = pollState(await context.newPage()), errors = [];
  host.on('pageerror', e => errors.push('host: ' + e.message));
  await host.goto('http://127.0.0.1:' + local.address().port + '/');
  await host.waitForFunction(() => document.querySelector('#connection').textContent.includes('在线'));
  return { url, password, host, hostBrowser, local, errors, camera: fake, async close() { await hostBrowser.close(); await local.shutdown(); await cloud.shutdown(); } };
}
export async function remotePage(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await instrument(context);
  const page = pollState(await context.newPage()); page.on('pageerror', e => errors.push(e.message)); return page;
}
export async function connectRemote(page, url, password, username = 'admin') {
  await page.goto(url); await page.locator('#username').fill(username); await page.locator('#admin-key').fill(password); await page.locator('#login').click();
  await page.waitForFunction(() => document.querySelector('#signal-status').textContent.includes('在线'));
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
export async function noWebMedia(page) {
  return page.evaluate(() => ({ requests: window.testMediaRequests.length, peers: window.testPeers.length, elements: document.querySelectorAll('video,audio,canvas').length, jsonOnly: window.testMessages.every(data => typeof data === 'string' && data.length < 8192 && !JSON.parse(data).data?.description && !JSON.parse(data).data?.candidate) }));
}