import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomInt } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createMeetingServer } from '../server/app.js';

const password = process.env.E2E_ADMIN_KEY || '12345678';
const server = process.env.E2E_BASE_URL ? null : createMeetingServer({ BOOTSTRAP_ADMIN_PASSWORD: password, USERS_FILE: ':memory:', ALLOWED_ORIGINS: '', STUN_URLS: '' });
if (server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
const url = process.env.E2E_BASE_URL || `http://127.0.0.1:${server.address().port}/`;
const username = `test_${Date.now().toString(36)}`;
const hostPassword = String(randomInt(10000000, 100000000)), newPassword = String(randomInt(10000000, 100000000));
const browser = await chromium.launch({ ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), headless: true });
const context = await browser.newContext();
const admin = await context.newPage();
const errors = [];
admin.on('pageerror', error => errors.push(error.message));
admin.on('dialog', dialog => dialog.accept());
try {
  await mkdir('test-results', { recursive: true });
  await admin.goto(url);
  await admin.locator('#username').fill(process.env.E2E_USERNAME || 'admin');
  await admin.locator('#admin-key').fill(password);
  await admin.locator('#login').click();
  await admin.locator('#manage-users').click();
  await admin.locator('#new-username').fill(username);
  await admin.locator('#new-display-name').fill('测试主持人');
  await admin.locator('#new-password').fill(hostPassword);
  await admin.locator('#create-user-form button[type=submit]').click();
  const row = admin.locator(`.account-row[data-username="${username}"]`);
  await row.waitFor();
  await admin.screenshot({ path: 'test-results/accounts.png', fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  assert.equal(await admin.evaluate(() => document.querySelector('#users-dialog').scrollWidth <= document.querySelector('#users-dialog').clientWidth), true);
  await admin.screenshot({ path: 'test-results/accounts-mobile.png', fullPage: true });
  const guestContext = await browser.newContext();
  const host = await guestContext.newPage();
  host.on('pageerror', error => errors.push(error.message));
  await host.goto(url);
  await host.locator('#username').fill(username);
  await host.locator('#admin-key').fill(hostPassword);
  await host.locator('#login').click();
  await host.locator('#signed-in').waitFor();
  assert.equal(await host.locator('#manage-users').isVisible(), false);
  await host.reload(); await host.locator('#signed-in').waitFor();
  await host.locator('#mode').selectOption('listen');
  await host.locator('#join-button').click();
  await host.waitForFunction(() => document.querySelector('#signal-status').textContent.includes('在线'));
  await row.locator('[data-action=reset]').click();
  await admin.locator('#reset-password').fill(newPassword);
  await admin.locator('#reset-user-form button[type=submit]').click();
  await host.waitForFunction(() => !document.querySelector('#lobby').hidden);
  await host.reload(); await host.locator('#login-fields').waitFor();
  await host.locator('#username').fill(username);
  await host.locator('#admin-key').fill(hostPassword);
  await host.locator('#login').click();
  await host.waitForFunction(() => document.querySelector('#message').textContent.includes('不正确'));
  await host.locator('#admin-key').fill(newPassword);
  await host.locator('#login').click(); await host.locator('#signed-in').waitFor();
  await row.locator('[data-action=toggle]').click();
  await row.getByText('主持人 · 已停用', { exact: true }).waitFor();
  await host.reload(); await host.locator('#login-fields').waitFor();
  await host.locator('#username').fill(username); await host.locator('#admin-key').fill(newPassword);
  await host.locator('#login').click();
  await host.waitForFunction(() => document.querySelector('#message').textContent.includes('不正确'));
  await row.locator('[data-action=toggle]').click();
  await row.getByText('主持人 · 已启用', { exact: true }).waitFor();
  await host.locator('#login').click(); await host.locator('#signed-in').waitFor();
  await row.locator('[data-action=delete]').click(); await row.waitFor({ state: 'detached' });
  await host.reload(); await host.locator('#login-fields').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: account manager creation, separate host login, session reload, room creation, password reset, revocation, disable/enable/delete and mobile layout.');
} finally {
  // Remove only this run's temporary account, including after a failed assertion.
  try {
    const response = await context.request.get(new URL('api/users', url).href);
    if (response.ok()) {
      const user = (await response.json()).users.find(u => u.username === username);
      if (user) await context.request.delete(new URL(`api/users/${user.id}`, url).href, { headers: { Origin: new URL(url).origin } });
    }
  } finally { await browser.close(); if (server) await server.shutdown(); }
}
