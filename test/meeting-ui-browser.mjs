import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, duplex, startCameras } from './browser-fixture.mjs';
const stack = await localStack(), browser = await chromium.launch(mediaLaunchOptions);
const fullscreenOn = (page, selector) => page.waitForFunction(selector => {
  const stage = document.querySelector(selector), box = stage.getBoundingClientRect();
  return stage.classList.contains('is-page-fullscreen') && document.fullscreenElement === document.documentElement && Math.abs(box.width - innerWidth) < 1 && Math.abs(box.height - innerHeight) < 1;
}, selector);
const fullscreenOff = page => page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('.is-page-fullscreen') && !document.body.classList.contains('has-page-fullscreen'));
try {
  await mkdir('test-results', { recursive: true });
  assert.equal(await stack.host.locator('#camera-view').isVisible(), true);
  assert.equal(await stack.host.locator('#access-settings').isVisible(), false);
  assert.equal(await stack.host.locator('#view-cameras').getAttribute('aria-pressed'), 'true');
  const hostLayout = await stack.host.evaluate(() => {
    const [local, remote] = [...document.querySelectorAll('.host-meeting-grid>.panel')].map(panel => panel.getBoundingClientRect());
    return { ratio: local.width / remote.width, ordered: local.right < remote.left };
  });
  assert.ok(Math.abs(hostLayout.ratio - 2) < 0.01); assert.equal(hostLayout.ordered, true);
  assert.equal(stack.local.hostStatus().capturing, false);
  const page = await remotePage(browser, stack.errors); await connectRemote(page, stack.url, stack.password); await startCameras(page); await page.locator('#host-microphone-toggle').click(); await page.locator('#camera-toggle').click(); await page.locator('#microphone-toggle').click();
  await page.waitForFunction(() => !document.querySelector('.crop-controls input').disabled);
  await duplex(page); await duplex(stack.host, true);
  const overlay = page.locator('.crop-overlay');
  const hostView = expected => stack.host.waitForFunction(expected => {
    const view = window.hostDiagnostics().view; return Object.entries(expected).every(([key, value]) => Math.abs(view[key] - value) < 0.01);
  }, expected);
  await overlay.getByRole('button', { name: '放大主画面' }).click(); await hostView({ zoom: 1.5 });
  for (const [name, view] of [['向右移动视野', { x: 0.6 }], ['向下移动视野', { y: 0.6 }], ['向左移动视野', { x: 0.5 }], ['向上移动视野', { y: 0.5 }]]) { await overlay.getByRole('button', { name }).click(); await hostView(view); }
  await overlay.getByRole('button', { name: '全景复位' }).click(); await hostView({ zoom: 1, x: 0.5, y: 0.5 });
  await page.screenshot({ path: 'test-results/control-desktop.png', fullPage: true });
  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(size); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await overlay.getByRole('button', { name: '放大主画面' }).click(); await hostView({ zoom: 1.5 });
    await overlay.getByRole('button', { name: '全景复位' }).click(); await hostView({ zoom: 1 });
  }
  await page.screenshot({ path: 'test-results/control-mobile.png', fullPage: true });
  await page.locator('#host-fullscreen').click(); await fullscreenOn(page, '#host-stage');
  await page.keyboard.press('Escape'); await fullscreenOff(page);
  await page.locator('#host-fullscreen').click(); await fullscreenOn(page, '#host-stage');
  await page.locator('#host-fullscreen').click(); await fullscreenOff(page);
  await stack.host.locator('#local-fullscreen').click(); await fullscreenOn(stack.host, '#local-stage');
  await stack.host.locator('#local-fullscreen').click(); await fullscreenOff(stack.host);
  await stack.host.locator('.remote-person button').click(); await fullscreenOn(stack.host, '.remote-person .video-stage');
  await stack.host.evaluate(() => document.exitFullscreen()); await fullscreenOff(stack.host);
  assert.equal(await stack.host.locator('.remote-person button').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new DOMException('Fullscreen denied', 'NotAllowedError')) }); });
  await page.locator('#host-fullscreen').click();
  assert.equal(await page.locator('.is-page-fullscreen').count(), 1);
  assert.equal(await page.evaluate(() => document.fullscreenElement), null);
  await page.keyboard.press('Escape'); await fullscreenOff(page);
  await page.evaluate(() => { delete document.documentElement.requestFullscreen; });
  await stack.host.locator('#view-settings').click();
  await stack.host.locator('#remote-name').fill('未保存的配置草稿');
  await stack.host.locator('#view-cameras').click(); await stack.host.screenshot({ path: 'test-results/native-host.png', fullPage: true });
  await stack.host.locator('#view-settings').click(); assert.equal(await stack.host.locator('#remote-name').inputValue(), '未保存的配置草稿');
  const retry = await page.evaluate(async () => {
    const { cropControls } = await import('./crop-controls.js'); let sent = 0;
    const control = cropControls(null, 0, undefined, message => {
      sent++; if (sent === 1) return false;
      setTimeout(() => control.applied({ ...message, shared: true, outputWidth: 1920, outputHeight: 1080 }), 0); return true;
    });
    control.overlay.querySelector('[data-zoom="in"]').click();
    const oldAck = { zoom: 1, x: 0.5, y: 0.5, shared: true, outputWidth: 1920, outputHeight: 1080 };
    control.applied(oldAck); setTimeout(() => control.applied(oldAck), 200);
    const ignoredOldAck = control.view.zoom === 1.5;
    await new Promise(resolve => setTimeout(resolve, 1100));
    const applied = control.element.textContent.includes('1.5×') && control.element.textContent.includes('USB 画面已更新');
    await new Promise(resolve => setTimeout(resolve, 1600)); control.dispose(); return { ignoredOldAck, applied, sent };
  });
  assert.deepEqual(retry, { ignoredOldAck: true, applied: true, sent: 2 });

  assert.deepEqual(stack.errors, []);
  console.log('PASS: default host camera view with 2:1 panels; page and browser fullscreen/exit/fallback at both ends; desktop and 320/390px layouts, pan/zoom/reset and settings drafts.');
} finally { await browser.close(); await stack.close(); }
