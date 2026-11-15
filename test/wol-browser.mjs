import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';
import { relayTestEnv } from './relay-fixture.mjs';
import { instrument, launchOptions } from './browser-fixture.mjs';

const key = 'browser-test-separate-nas-key-32-characters';
const server = createMeetingServer({ ...relayTestEnv, HOST_AGENT_KEY: 'browser-test-host-agent-key-32-characters', WOL_AGENT_KEY: key, USERS_FILE: ':memory:', BOOTSTRAP_ADMIN_PASSWORD: '12345678' });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`, browser = await chromium.launch(launchOptions), errors = [];
let stop = false, commands = 0, checks = 0, roomState = 'online';
async function nas() {
  let result;
  while (!stop) {
    const response = await fetch(new URL('api/wol/agent/poll', url), { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ configured: ['basement'], capabilities: ['status'], statusTargets: { 'small-room': '192.168.31.250', basement: '192.168.31.100' }, ...(result ? { result } : {}) }) });
    const { command } = await response.json();
    result = undefined;
    if (command?.type === 'check') {
      checks++; await new Promise(resolve => setTimeout(resolve, 200));
      result = { id: command.id, ok: true, states: { 'small-room': roomState, basement: 'unreachable' } };
    } else if (command) { commands++; result = { id: command.id, ok: true }; }
  }
}
const nasLoop = nas();
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } }); await instrument(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); assert.equal(await page.locator('#wake-panel').isVisible(), false);
  await page.locator('#username').fill('admin'); await page.locator('#admin-key').fill('12345678'); await page.locator('#login').click();
  await page.getByRole('button', { name: '唤醒地下室大电脑' }).waitFor();
  const basement = page.getByRole('button', { name: '唤醒地下室大电脑' });
  assert.equal(await basement.isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '唤醒小房间电脑' }).isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('[data-computer="small-room"] [data-power-state="online"]'));
  assert.equal(checks, 1); assert.equal(commands, 0);
  assert.equal(await page.locator('[data-computer="basement"] [data-power-state="unreachable"]').count(), 1);
  assert.match(await page.locator('[data-computer="small-room"]').textContent(), /检查于/);
  assert.match(await page.locator('[data-computer="small-room"]').textContent(), /192\.168\.31\.250/);
  roomState = 'unreachable';
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-computer="small-room"] [data-power-state="unreachable"]'));
  assert.equal(checks, 2); assert.equal(commands, 0);
  roomState = 'online'; await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-computer="small-room"] [data-power-state="online"]'));
  assert.equal(checks, 3); assert.equal(commands, 0);
  assert.match(await page.locator('#signal-status').textContent(), /等待现场主机上线/);
  assert.equal(await page.evaluate(() => window.testMediaRequests.length), 0);
  await basement.click(); await page.waitForFunction(() => document.querySelector('#message').textContent.includes('NAS 已发送唤醒信号'));
  assert.equal(commands, 1);
  // Polling refreshes can replace the button while a receipt is arriving.
  await page.waitForFunction(() => !document.querySelector('[data-target="basement"]').disabled);
  await basement.click(); await page.waitForFunction(() => document.querySelector('#message').textContent.includes('30 秒'));
  assert.equal(commands, 1);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/wol-desktop.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await basement.isVisible(), true);
  }
  await page.screenshot({ path: 'test-results/wol-mobile.png', fullPage: true });
  const text = await page.locator('#wake-panel').textContent(); assert.equal(text.includes(key), false);
  await page.locator('#logout').click(); await page.locator('#login').waitFor();
  assert.equal(await page.locator('#wake-panel').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: automatic and manual computer status, fresh checks on reload, WOL without a meeting host, no media permissions, logout and 320/390px layouts.');
} finally {
  stop = true; await browser.close(); await server.shutdown(); await nasLoop;
}
