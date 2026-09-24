// Explicit, opt-in local hardware check. Captures two real cameras and a mic.
// Media stays on this computer; no remote participant is connected.
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';

const key = 'hardware-test-only-secret-32-chars';
const server = createMeetingServer({ ADMIN_KEY: key, ALLOWED_ORIGINS: '', STUN_URLS: '' });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true, args: ['--use-fake-ui-for-media-stream'] });
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#admin-key').fill(key);
  await page.locator('#devices-button').click();
  await page.waitForFunction(() => !document.querySelector('#device-fields').hidden);
  const cameras = await page.locator('#camera1 option').evaluateAll(options => options.map(o => ({ value: o.value, label: o.textContent })).filter(o => !/\bIR\b|infrared|红外/i.test(o.label)));
  if (cameras.length < 2) throw new Error('Two non-infrared cameras are required for this check.');
  await page.locator('#camera1').selectOption(cameras[0].value);
  await page.locator('#camera2').selectOption(cameras[1].value);
  await page.locator('#join-button').click();
  await page.waitForFunction(() => document.querySelectorAll('.video-card video').length === 2 && [...document.querySelectorAll('.video-card video')].every(v => v.readyState >= 2 && v.videoWidth > 0));
  const video = await page.locator('.video-card video').evaluateAll(videos => videos.map(v => ({ width: v.videoWidth, height: v.videoHeight, readyState: v.srcObject.getVideoTracks()[0].readyState })));
  console.log(JSON.stringify({ cameras: cameras.slice(0, 2).map(c => c.label), microphone: await page.locator('#microphone option:checked').textContent(), video }, null, 2));
  await page.locator('#leave').click();
  console.log('PASS: both physical cameras and microphone opened simultaneously; local previews rendered; devices released.');
} finally { await browser.close(); await server.shutdown(); }
