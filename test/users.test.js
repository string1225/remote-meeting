import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUserStore } from '../server/users.js';

test('hashed accounts persist across restart; bootstrap cannot overwrite saved passwords', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-users-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'users.json');
  let store = createUserStore({ file, bootstrapPassword: '12345678' });
  const host = store.create({ username: 'host1', password: 'host-secret', displayName: '现场' });
  const admin = store.list().find(u => u.role === 'admin');
  store.update(admin.id, { password: '87654321' });
  store.update(host.id, { enabled: false });
  const saved = await readFile(file, 'utf8');
  for (const secret of ['12345678', '87654321', 'host-secret']) assert.equal(saved.includes(secret), false);
  store = createUserStore({ file, bootstrapPassword: '11111111' });
  assert.equal((await store.authenticate('admin', '87654321')).id, admin.id);
  assert.equal(await store.authenticate('admin', '12345678'), null);
  assert.equal(await store.authenticate('admin', '11111111'), null);
  assert.equal(await store.authenticate('host1', 'host-secret'), null);
  store.update(host.id, { enabled: true });
  assert.equal((await store.authenticate('host1', 'host-secret')).displayName, '现场');
  assert.equal(JSON.stringify(store.list()).includes('hash'), false);
});
