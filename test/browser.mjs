import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView, startCameras, noWebMedia } from './browser-fixture.mjs';
const stack = await localStack(), browser = await chromium.launch(launchOptions), clients = [];
const synced = (page, zoom, x) => page.waitForFunction(({ zoom, x }) => {
  const controls = document.querySelector('.crop-controls');
  return Number(controls?.querySelector('input').value) === zoom && controls.querySelector('.crop-status').textContent.includes('画面已更新') && (!x || Math.abs(Number(controls.querySelector('.crop-map').getAttribute('aria-valuetext').match(/横向 (\d+)/)[1]) - x * 100) <= 2);
}, { zoom, x });
try {
  assert.equal(stack.local.hostStatus().capturing, false);
  assert.equal(stack.local.hostStatus().microphone, false);
  for (let i = 0; i < 2; i++) { const page = await remotePage(browser, stack.errors); clients.push(page); await connectRemote(page, stack.url, stack.password); await startCameras(page); }
  assert.equal(stack.camera.starts, 1);
  assert.equal(stack.local.hostStatus().peers.length, 2);
  for (const page of [stack.host, ...clients]) assert.deepEqual(await noWebMedia(page), { requests: 0, peers: 0, elements: 0, jsonOnly: true });
  await setView(clients[0], 0, 2, 0.25); await synced(clients[1], 2, 0.25);
  await setView(clients[1], 0, 2, 0.75); await synced(clients[0], 2, 0.75);
  assert.ok(Math.abs(stack.local.hostStatus().view.x - 0.75) < 0.02);
  await clients[0].reload(); await clients[0].waitForFunction(() => document.querySelector('#signal-status').textContent.includes('在线')); await synced(clients[0], 2, 0.75);
  assert.equal(stack.camera.starts, 1);
  const extra = await remotePage(browser, stack.errors); await extra.goto(stack.url); await extra.locator('#username').fill('admin'); await extra.locator('#admin-key').fill(stack.password); await extra.locator('#login').click();
  await extra.waitForFunction(() => document.querySelector('#message').textContent.includes('两位远端'));
  await stack.host.locator('#view-cameras').click(); await stack.host.locator('#local-camera-toggle').click();
  for (const page of clients) await page.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '启动摄像头' && document.querySelector('.crop-controls input').disabled);
  assert.equal(stack.local.hostStatus().virtualCamera.state, 'stopped');
  await clients[1].reload(); await clients[1].waitForFunction(() => document.querySelector('#signal-status').textContent.includes('在线'));
  assert.equal(stack.camera.starts, 1); assert.equal(stack.local.hostStatus().capturing, false);
  stack.camera.failNext = true; await clients[1].locator('#host-camera-toggle').click();
  await clients[0].waitForFunction(() => document.querySelector('#host-status').textContent.includes('被占用'));
  await startCameras(clients[1]); await clients[0].waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '关闭摄像头');
  await setView(clients[0], 0, 3, 0.4); await synced(clients[1], 3, 0.4);
  await clients[0].evaluate(() => window.testSockets.at(-1).close());
  await clients[0].waitForFunction(() => window.testSockets.length >= 2 && window.controlDiagnostics().connected); await synced(clients[0], 3, 0.4);
  assert.equal(stack.camera.starts, 3);
  await stack.host.locator('#pause').click();
  for (const page of clients) await page.waitForFunction(() => document.querySelector('#host-status').textContent.includes('离线'));
  assert.equal(stack.local.hostStatus().capturing, true);
  await stack.host.locator('#pause').click();
  for (const page of clients) await page.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '关闭摄像头' && !document.querySelector('#host-camera-toggle').disabled);
  await clients[0].locator('#leave').click(); await clients[1].locator('#leave').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().peers.length === 0);
  assert.equal(stack.local.hostStatus().capturing, true); assert.equal(stack.local.hostStatus().microphone, false);
  await stack.host.locator('#local-camera-toggle').click(); await stack.host.waitForFunction(() => window.hostDiagnostics().virtualCamera.state === 'stopped');
  for (const page of [stack.host, ...clients]) assert.deepEqual(await noWebMedia(page), { requests: 0, peers: 0, elements: 0, jsonOnly: true });
  assert.deepEqual(stack.errors, []);
  console.log('PASS: login automatically starts one native virtual camera; no web capture, microphone, playback, WebRTC or binary media; two control panels synchronize; reload/reconnect, local close, startup failure/retry, capacity, pause/resume and departure preserve expected output.');
} finally { await browser.close(); await stack.close(); }
