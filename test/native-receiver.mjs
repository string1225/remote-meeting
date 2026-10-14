// Independent local app stand-in. App control pages deliberately prohibit all web capture.
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchOptions } from './browser-fixture.mjs';
export async function nativeReceiver() {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body>Local virtual-camera acceptance receiver</body></html>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({ permissions: ['camera'] });
  await page.goto('http://127.0.0.1:' + server.address().port);
  return { page, async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
export async function openVirtual(page) {
  return page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camera = devices.find(d => d.kind === 'videoinput' && d.label.startsWith('Remote Meeting Camera') && d.label.includes('Windows Virtual Camera'));
    if (!camera) throw new Error('Independent virtual camera is not registered: ' + devices.map(d => d.label).join(', '));
    const video = document.createElement('video'); video.id = 'virtual-receiver'; video.muted = true; video.playsInline = true;
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camera.deviceId }, width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    document.body.append(video); await video.play();
    return { settings: video.srcObject.getVideoTracks()[0].getSettings(), devices: devices.filter(d => d.kind === 'videoinput').map(d => d.label) };
  });
}
export function stopVirtual(page) { return page.evaluate(() => document.querySelector('#virtual-receiver')?.srcObject.getTracks().forEach(t => t.stop())); }
