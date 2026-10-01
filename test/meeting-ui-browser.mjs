import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote } from './browser-fixture.mjs';

const stack = await localStack();
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const level = (page, selector) => page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(el => Number(el.getAttribute('aria-valuenow')) > 5), selector, { polling: 100 });
async function preview(page) {
  await page.locator('[data-audio-action="microphone"]').click(); await level(page, '[data-audio-kind="microphone"] [role="meter"]');
  await page.locator('[data-audio-action="microphone"]').click();
  assert.equal(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), true);
  await page.locator('[data-audio-action="speaker"]').click(); await level(page, '[data-audio-kind="speaker"] [role="meter"]');
  await page.locator('[data-audio-action="speaker"]').click();
}
try {
  await mkdir('test-results', { recursive: true });
  await preview(stack.host);
  const page = await remotePage(browser, stack.errors); await page.goto(stack.url); await preview(page);
  await connectRemote(page, stack.url, stack.password);
  await page.waitForFunction(() => document.querySelectorAll('#host-thumbnails video').length === 2 && [...document.querySelectorAll('#host-thumbnails video')].every(video => video.readyState >= 2));
  await level(page, '[data-audio-kind="microphone"] [role="meter"]'); await level(page, '[data-audio-kind="speaker"] [role="meter"]');
  await level(page, '#host-thumbnails [role="meter"]'); await level(stack.host, '#remote-media [role="meter"]');
  console.log('PASS: pre-connection microphone/speaker tests and live local/peer audio meters.');
  await page.locator('#mute').click();
  await page.waitForFunction(() => document.querySelector('[data-audio-kind="microphone"] [role="meter"]').getAttribute('aria-valuetext') === '已静音', null, { polling: 100 });
  await page.locator('#mute').click();
  await page.evaluate(() => document.querySelectorAll('#remote-audio audio').forEach(audio => { audio.muted = true; }));
  await page.waitForFunction(() => document.querySelector('[data-audio-kind="speaker"] [role="meter"]').getAttribute('aria-valuetext') === '待播放', null, { polling: 100 });
  await page.evaluate(() => document.querySelectorAll('#remote-audio audio').forEach(audio => { audio.muted = false; }));
  await level(page, '[data-audio-kind="speaker"] [role="meter"]');
  await stack.host.evaluate(() => window.testSockets[0].send(JSON.stringify({ type: 'host-state', state: 'capturing', cameras: [{ width: 3840, height: 2160 }, { width: 7680, height: 4320 }] })));
  await page.waitForFunction(() => document.querySelector('#host-thumbnails [data-camera="1"]').getAttribute('aria-pressed') === 'true');
  await page.locator('#host-thumbnails [data-camera="0"]').click();
  await stack.host.evaluate(() => window.testSockets[0].send(JSON.stringify({ type: 'host-state', state: 'capturing', cameras: window.hostDiagnostics().capture.sources.map(source => source.settings) })));
  const stage = await page.locator('.main-stage').boundingBox(), sidebar = await page.locator('.video-sidebar').boundingBox();
  assert.ok(stage.x < sidebar.x && stage.width > sidebar.width * 2);
  assert.equal(await page.locator('#host-videos > :visible').count(), 1);
  const overlay = page.locator('#host-videos [data-camera="0"] .crop-overlay');
  const hostView = expected => stack.host.waitForFunction(expected => {
    const view = [...window.hostDiagnostics().peers.values()][0]?.media.find(m => m.camera === 0)?.view;
    return view && Object.entries(expected).every(([key, value]) => Math.abs(view[key] - value) < 0.01);
  }, expected, { polling: 100 });
  await overlay.getByRole('button', { name: '放大主画面' }).click(); await hostView({ zoom: 1.5 });
  for (const [name, view] of [['向右移动视野', { x: 0.6 }], ['向下移动视野', { y: 0.6 }], ['向左移动视野', { x: 0.5 }], ['向上移动视野', { y: 0.5 }]]) {
    await overlay.getByRole('button', { name }).click(); await hostView(view);
  }
  await overlay.getByRole('button', { name: '缩小主画面' }).click(); await hostView({ zoom: 1 });
  await overlay.getByRole('button', { name: '放大主画面' }).click(); await hostView({ zoom: 1.5 });
  await page.locator('#host-thumbnails [data-camera="1"]').click(); await page.locator('#host-thumbnails [data-camera="0"]').click();
  assert.equal(await page.locator('.crop-controls[data-camera="0"] input').inputValue(), '1.5');
  await overlay.getByRole('button', { name: '全景复位' }).click(); await hostView({ zoom: 1, x: 0.5, y: 0.5 });
  console.log('PASS: resolution-based main selection, sidebar switching, independent retained views, overlay pan/zoom/reset.');
  await page.screenshot({ path: 'test-results/meeting-ui-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.equal(await page.locator('#leave').isVisible(), true);
  assert.ok((await page.locator('.meeting-bottom').boundingBox()).y < 720);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await overlay.getByRole('button', { name: '放大主画面' }).click(); await hostView({ zoom: 1.5 });
  await overlay.getByRole('button', { name: '全景复位' }).click(); await hostView({ zoom: 1 });
  await page.screenshot({ path: 'test-results/meeting-ui-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const second = await remotePage(browser, stack.errors); await connectRemote(second, stack.url, stack.password);
  await page.waitForFunction(() => document.querySelectorAll('#remote-videos video').length === 2 && [...document.querySelectorAll('#remote-videos video')].every(video => video.readyState >= 2));
  await level(page, '#remote-videos [data-owner]:not([data-owner="local"]) [role="meter"]');
  await page.screenshot({ path: 'test-results/meeting-ui-two-remotes.png', fullPage: true });
  await second.locator('#leave').click();
  await page.waitForFunction(() => document.querySelectorAll('#remote-videos video').length === 1);
  await page.locator('#leave').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null && window.testTracks.every(track => track.readyState === 'ended'), null, { polling: 100 });
  assert.equal(await page.evaluate(() => window.testTracks.every(track => track.readyState === 'ended')), true);
  assert.equal(await page.locator('#lobby-audio .audio-monitor').isVisible(), true);
  const retry = await page.evaluate(async () => {
    const { cropControls } = await import('./crop-controls.js'); let sent = 0;
    const control = cropControls(document.createElement('video'), 0, undefined, message => {
      sent++;
      if (sent === 1) return false;
      setTimeout(() => control.applied({ ...message, sourceWidth: 3840, sourceHeight: 2160, outputWidth: 1920, outputHeight: 1080 }), 0);
      return true;
    });
    control.overlay.querySelector('[data-zoom="in"]').click();
    control.applied({ zoom: 1, x: 0.5, y: 0.5, sourceWidth: 3840, sourceHeight: 2160, outputWidth: 1920, outputHeight: 1080 });
    const ignoredOldAck = !control.element.textContent.includes('主机已裁剪');
    await new Promise(resolve => setTimeout(resolve, 1100));
    const applied = control.element.textContent.includes('1.5×') && control.element.textContent.includes('主机已裁剪');
    const acknowledged = sent;
    await new Promise(resolve => setTimeout(resolve, 1600));
    control.dispose(); return { ignoredOldAck, applied, acknowledged, sent };
  });
  assert.deepEqual(retry, { ignoredOldAck: true, applied: true, acknowledged: 2, sent: 2 });
  assert.deepEqual(stack.errors, []);
  console.log('PASS: desktop/mobile controls, two remote sidebar videos with audio levels, removal, idle release and return to preflight.');
} finally { await browser.close(); await stack.close(); }
