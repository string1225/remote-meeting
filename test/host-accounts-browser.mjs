import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createHostService } from '../host/service.js';
import { createMeetingServer } from '../server/app.js';

const agentKey = 'browser-account-test-machine-key-32-characters';
const cloud = createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: 'test-admin-key', USERS_FILE: ':memory:', HOST_AGENT_KEY: agentKey, ALLOWED_ORIGINS: '', STUN_URLS: '' });
cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
const cloudUrl = `http://127.0.0.1:${cloud.address().port}/`;
const local = createHostService({ serverUrl: cloudUrl, agentKey }); local.listen(0, '127.0.0.1'); await once(local, 'listening');
const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true });
const host = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), remote = await browser.newPage();
const errors = []; for (const page of [host, remote]) page.on('pageerror', error => errors.push(error.message));
host.on('dialog', dialog => dialog.accept());
async function saved() { await host.waitForFunction(() => !document.getElementById('access-fields').disabled); }
async function login(username, password, success = true) {
  await remote.goto(cloudUrl);
  await remote.locator('#username').fill(username); await remote.locator('#admin-key').fill(password); await remote.locator('#login').click();
  if (success) await remote.locator('#signed-in').waitFor();
  else await remote.waitForFunction(() => document.getElementById('message').textContent.includes('不正确'));
}
try {
  await mkdir('test-results', { recursive: true });
  await host.goto(`http://127.0.0.1:${local.address().port}/`);
  await host.getByText('尚未配置外部人员，请填写姓名、账号和密钥后保存。', { exact: true }).waitFor();
  assert.equal(await host.locator('#access-settings').isVisible(), true);
  await host.locator('#remote-name').fill('张三'); await host.locator('#remote-username').fill('alice'); await host.locator('#remote-key').fill('alice-key');
  await host.locator('#save-account').click(); await host.locator('[data-username="alice"]').waitFor(); await saved();
  assert.equal(await host.locator('#remote-key').inputValue(), '');
  await host.locator('#remote-name').fill('李四'); await host.locator('#remote-username').fill('bob'); await host.locator('#generate-key').click();
  const bobKey = await host.locator('#remote-key').inputValue(); assert.equal(bobKey.length, 20);
  await host.locator('#save-account').click(); await host.locator('[data-username="bob"]').waitFor(); await saved();
  await login('alice', 'alice-key'); assert.match(await remote.locator('#account-name').textContent(), /张三/);
  assert.equal(await remote.locator('#manage-users').isVisible(), false);
  await host.locator('[data-username="alice"] [data-action="edit"]').click();
  await host.locator('#remote-name').fill('张老师'); await host.locator('#save-account').click(); await saved();
  await remote.reload(); await remote.locator('#signed-in').waitFor(); assert.match(await remote.locator('#account-name').textContent(), /张老师/);
  await host.locator('[data-username="alice"] [data-action="edit"]').click();
  await host.locator('#remote-username').fill('alice.new'); await host.locator('#remote-key').fill('new-alice-key');
  await host.locator('#save-account').click(); await host.locator('[data-username="alice.new"]').waitFor(); await saved();
  await login('alice', 'alice-key', false); await login('alice.new', 'new-alice-key');
  await host.locator('#pause').click();
  await host.locator('[data-username="alice.new"] [data-action="toggle"]').click(); await saved();
  await host.locator('[data-username="alice.new"]').getByText('alice.new · 已停用', { exact: true }).waitFor();
  await login('alice.new', 'new-alice-key', false);
  await host.locator('[data-username="alice.new"] [data-action="toggle"]').click(); await saved();
  await login('alice.new', 'new-alice-key');
  await host.screenshot({ path: 'test-results/host-accounts.png', fullPage: true });
  await host.setViewportSize({ width: 390, height: 844 });
  assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await host.screenshot({ path: 'test-results/host-accounts-mobile.png', fullPage: true });
  await host.locator('[data-username="alice.new"] [data-action="delete"]').click(); await host.locator('[data-username="alice.new"]').waitFor({ state: 'detached' }); await saved();
  await login('alice.new', 'new-alice-key', false);
  await login('bob', bobKey); assert.match(await remote.locator('#account-name').textContent(), /李四/);
  await host.reload(); await host.locator('[data-username="bob"]').waitFor();
  assert.equal(await host.locator('#remote-key').inputValue(), ''); assert.deepEqual(errors, []);
  console.log('PASS: local personnel UI, multiple accounts, generated keys, name-only edit, renamed login, key rotation, pause/enable/disable/delete, reload and mobile layout.');
} finally { await browser.close(); await local.shutdown(); await cloud.shutdown(); }
