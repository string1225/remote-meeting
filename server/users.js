import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const derive = promisify(scrypt);
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const publicUser = ({ id, username, displayName, role, enabled, createdAt }) => ({ id, username, displayName, role, enabled, createdAt });
const invalid = message => Object.assign(new Error(message), { status: 400 });
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 128 || !password.trim()) throw invalid('口令需要 6–128 个字符');
}
function hashPassword(password) {
  checkPassword(password);
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function createUserStore({ file = '.local/users.json', bootstrapPassword, bootstrapUsername = 'admin' } = {}) {
  const filename = file === ':memory:' ? null : resolve(file);
  let users;
  function persist(next) {
    if (!filename) return;
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, users: next }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, filename);
    } finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  try {
    if (filename) {
      const data = JSON.parse(readFileSync(filename, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.users)) throw new Error('Invalid user store format');
      users = data.users;
      const names = new Set(), ids = new Set();
      for (const user of users) {
        if (!user.id || ids.has(user.id) || !/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(user.username) || names.has(user.username) || !['admin', 'host'].includes(user.role) || typeof user.enabled !== 'boolean' || !/^[0-9a-f]{32}$/.test(user.salt) || !/^[0-9a-f]{128}$/.test(user.hash)) throw new Error('Invalid account in user store');
        ids.add(user.id); names.add(user.username);
      }
      if (!users.some(u => u.role === 'admin' && u.enabled)) throw new Error('At least one enabled administrator is required');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!users) {
    if (!bootstrapPassword || bootstrapPassword.startsWith('replace-')) throw new Error('Set BOOTSTRAP_ADMIN_PASSWORD (6+ characters) for the first start. Existing ADMIN_KEY is also accepted for migration.');
    const username = normalize(bootstrapUsername);
    if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(username)) throw new Error('Invalid bootstrap administrator username');
    users = [{ id: randomUUID(), username, displayName: '管理员', role: 'admin', enabled: true, createdAt: Date.now(), ...hashPassword(bootstrapPassword) }];
    persist(users);
  }
  const dummy = hashPassword(randomBytes(24).toString('base64url'));
  let verifying = 0;
  return {
    list: () => users.map(publicUser),
    get: id => { const user = users.find(u => u.id === id); return user ? publicUser(user) : null; },
    async authenticate(username, password) {
      if (typeof password !== 'string' || password.length > 128) return null;
      if (verifying >= 3) throw Object.assign(new Error('登录繁忙，请稍后重试'), { status: 429 });
      const user = users.find(u => u.username === normalize(username));
      const record = user || dummy;
      verifying++;
      try {
        const digest = await derive(password, record.salt, 64);
        const valid = timingSafeEqual(digest, Buffer.from(record.hash, 'hex'));
        // An account may have been changed while scrypt ran.
        return valid && user?.enabled && users.includes(user) ? publicUser(user) : null;
      } finally { verifying--; }
    },
    create(input) {
      const username = normalize(input.username);
      if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(username)) throw invalid('账号需为 2–32 位字母、数字、点、下划线或短横线');
      if (users.some(u => u.username === username)) throw invalid('此账号已存在');
      if (users.length >= 100) throw invalid('最多支持 100 个账号');
      const role = input.role || 'host';
      if (!['admin', 'host'].includes(role)) throw invalid('无效的账号类型');
      const user = { id: randomUUID(), username, displayName: String(input.displayName || username).trim().slice(0, 40) || username, role, enabled: true, createdAt: Date.now(), ...hashPassword(input.password) };
      const next = [...users, user]; persist(next); users = next;
      return publicUser(user);
    },
    update(id, input) {
      const old = users.find(u => u.id === id);
      if (!old) throw Object.assign(new Error('账号不存在'), { status: 404 });
      const user = { ...old };
      if ('password' in input) Object.assign(user, hashPassword(input.password));
      if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw invalid('无效的账号状态'); user.enabled = input.enabled; }
      if ('role' in input) { if (!['admin', 'host'].includes(input.role)) throw invalid('无效的账号类型'); user.role = input.role; }
      if ('displayName' in input) user.displayName = String(input.displayName).trim().slice(0, 40) || user.username;
      const next = users.map(u => u.id === id ? user : u);
      if (!next.some(u => u.role === 'admin' && u.enabled)) throw invalid('必须保留至少一位启用的管理员');
      persist(next); users = next; return publicUser(user);
    },
    remove(id) {
      if (!users.some(u => u.id === id)) throw Object.assign(new Error('账号不存在'), { status: 404 });
      const next = users.filter(u => u.id !== id);
      if (!next.some(u => u.role === 'admin' && u.enabled)) throw invalid('必须保留至少一位启用的管理员');
      persist(next); users = next;
    }
  };
}
