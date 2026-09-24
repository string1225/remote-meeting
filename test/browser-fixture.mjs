import { once } from 'node:events';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';
import { createHostService } from '../host/service.js';

export const launchOptions = { ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true };
export async function instrument(context, syntheticHost = false) {
  await context.addInitScript(({ syntheticHost }) => {
    window.testPeers = []; window.testSockets = []; window.testTracks = [];
    const PC = RTCPeerConnection, WS = WebSocket;
    window.RTCPeerConnection = class extends PC { constructor(...a) { super(...a); window.testPeers.push(this); } };
    window.WebSocket = class extends WS { constructor(...a) { super(...a); window.testSockets.push(this); } };
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    if (syntheticHost) navigator.mediaDevices.enumerateDevices = async () => [...(await enumerate()).filter(d => d.kind !== 'videoinput'), ...[1, 2].map(i => ({ kind: 'videoinput', deviceId: `test-camera-${i}`, label: `Synthetic 4K camera ${i}`, groupId: `${i}` }))];
    navigator.mediaDevices.getUserMedia = async c => {
      let stream;
      if (syntheticHost && c.video?.deviceId?.exact?.startsWith('test-camera-')) {
        const camera = c.video.deviceId.exact.endsWith('2') ? 1 : 0;
        const canvas = document.createElement('canvas'); canvas.width = 3840; canvas.height = 2160;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = camera ? '#14bf40' : '#e81919'; ctx.fillRect(0, 0, 1920, 2160); ctx.fillStyle = camera ? '#e8ca16' : '#183be8'; ctx.fillRect(1920, 0, 1920, 2160);
        let counter = 0; const timer = setInterval(() => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 420, 100); ctx.fillStyle = '#000'; ctx.font = '40px sans-serif'; ctx.fillText(`Frame ${counter++}`, 15, 60); }, 120);
        stream = canvas.captureStream(24);
        const track = stream.getVideoTracks()[0], stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); };
      } else stream = await native(c);
      window.testTracks.push(...stream.getTracks()); return stream;
    };
  }, { syntheticHost });
}
export async function localStack({ hardware = false } = {}) {
  const password = '12345678', agentKey = 'test-host-machine-key-32-characters-only';
  const cloud = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: password, HOST_AGENT_KEY: agentKey, USERS_FILE: ':memory:', ALLOWED_ORIGINS: '', STUN_URLS: '' });
  cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
  const url = `http://127.0.0.1:${cloud.address().port}/`;
  const local = createHostService({ serverUrl: url, agentKey, idleMs: 200 }); local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const hostBrowser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', ...(!hardware ? ['--use-fake-device-for-media-stream'] : []), '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
  const context = await hostBrowser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 900 } });
  await instrument(context, !hardware);
  const host = await context.newPage();
  const errors = []; host.on('pageerror', e => errors.push(`host: ${e.message}`));
  await host.goto(`http://127.0.0.1:${local.address().port}/`);
  await host.waitForFunction(() => document.querySelector('#connection').textContent.includes('在线'));
  return { url, password, host, local, errors, async close() { await hostBrowser.close(); await local.shutdown(); await cloud.shutdown(); } };
}
export async function remotePage(browser, errors) {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 1000 } });
  await instrument(context);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); return page;
}
export async function connectRemote(page, url, password, username = 'admin', mode = 'video') {
  await page.goto(url); await page.locator('#username').fill(username); await page.locator('#admin-key').fill(password); await page.locator('#mode').selectOption(mode); await page.locator('#join-button').click();
  await page.waitForFunction(() => document.querySelector('#signal-status').textContent.includes('在线'));
}
export async function setView(page, camera, zoom, x) {
  const panel = page.locator(`.crop-controls[data-camera="${camera}"]`);
  await panel.locator('input').fill(String(zoom));
  const map = panel.locator('.crop-map'); const box = await map.boundingBox();
  await map.click({ position: { x: box.width * x, y: box.height * 0.5 } });
  await page.waitForFunction(({ camera, zoom }) => document.querySelector(`.crop-controls[data-camera="${camera}"] .crop-status`)?.textContent.includes(`${zoom.toFixed(1)}×`), { camera, zoom });
}
