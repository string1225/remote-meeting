import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, duplex, startCameras } from './browser-fixture.mjs';
const stack = await localStack(), browser = await chromium.launch(mediaLaunchOptions);
try {
  await mkdir('test-results', { recursive: true });
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
  await page.locator('#host-fullscreen').click(); assert.equal(await page.evaluate(() => document.querySelector('#host-stage').getBoundingClientRect().width === innerWidth), true); await page.keyboard.press('Escape');
  await stack.host.locator('.remote-person button').click(); assert.equal(await stack.host.locator('.is-page-fullscreen').count(), 1); await stack.host.keyboard.press('Escape');
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
  console.log('PASS: desktop and 320/390px duplex meeting layouts, in-page fullscreen/ESC at both ends, pan/zoom/reset, delayed acknowledgements and settings drafts.');
} finally { await browser.close(); await stack.close(); }