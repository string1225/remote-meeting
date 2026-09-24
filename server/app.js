import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import { createHub } from './hub.js';
import { createUserStore } from './users.js';

const token = () => randomBytes(24).toString('base64url');
const split = value => (value || '').split(',').map(v => v.trim()).filter(Boolean);
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/remote.js', ['remote.js', 'text/javascript']], ['/accounts.js', ['accounts.js', 'text/javascript']], ['/rtc.js', ['rtc.js', 'text/javascript']], ['/crop-controls.js', ['crop-controls.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

export function createMeetingServer(options = {}) {
  const env = { ...process.env, ...options };
  const users = createUserStore({ file: env.USERS_FILE, bootstrapPassword: env.BOOTSTRAP_ADMIN_PASSWORD || env.ADMIN_KEY, bootstrapUsername: env.BOOTSTRAP_ADMIN_USERNAME || 'admin' });
  const sessions = new Map();
  const sessionTTL = 8 * 3600_000;
  const cookiePath = env.COOKIE_PATH || '/';
  if (!/^\/[A-Za-z0-9/_-]*$/.test(cookiePath)) throw new Error('Invalid COOKIE_PATH');
  const allowedOrigins = split(env.ALLOWED_ORIGINS);
  const ttl = Number(env.ROOM_TTL_HOURS || 8) * 3600_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400_000) throw new Error('ROOM_TTL_HOURS must be between 0 and 24.');
  const limits = new Map();
  const originAllowed = (origin, req) => allowedOrigins.length
    ? allowedOrigins.includes(origin)
    : /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin || '') && origin === `http://${req.headers.host}`;
  const address = req => env.TRUST_PROXY === 'true' ? req.headers['x-real-ip'] || req.socket.remoteAddress : req.socket.remoteAddress;
  function rate(key, maximum, windowMs = 60_000) {
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || now > entry.until) { entry = { count: 0, until: now + windowMs }; limits.set(key, entry); }
    return ++entry.count <= maximum;
  }
  function iceServers() {
    const urls = split(env.STUN_URLS === undefined ? 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302' : env.STUN_URLS);
    const servers = urls.length ? [{ urls }] : [];
    const turn = split(env.TURN_URLS);
    if (turn.length && env.TURN_SECRET) {
      const username = `${Math.ceil((Date.now() + ttl) / 1000)}:${env.TURN_USERNAME_PREFIX || 'meeting'}`;
      servers.push({ urls: turn, username, credential: createHmac('sha1', env.TURN_SECRET).update(username).digest('base64') });
    }
    return servers;
  }
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  function sessionFor(req) {
    const key = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('meeting_session='))?.slice(16);
    const session = sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) { sessions.delete(key); return null; }
    const user = users.get(session.userId);
    return user?.enabled ? { key, user, expiresAt: session.expiresAt } : null;
  }
  function cookie(req, value, maxAge) {
    const secure = req.socket.encrypted || (env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https');
    return `meeting_session=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw Object.assign(new Error('请求内容过长'), { status: 413 });
      chunks.push(chunk);
    }
    try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
    catch { throw Object.assign(new Error('无效的请求内容'), { status: 400 }); }
  }
  function revokeUser(id) {
    for (const [key, session] of sessions) if (session.userId === id) sessions.delete(key);
    hub.revokeUser(id);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok', mode: 'signaling-only' });
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !originAllowed(req.headers.origin, req)) return json(res, 403, { error: '不允许的访问来源' });
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { user: sessionFor(req)?.user || null });
      if (req.method === 'POST' && path === '/api/login') {
        if (!rate(`login-ip:${address(req)}`, 20, 60_000)) return json(res, 429, { error: '登录尝试过于频繁，请一分钟后重试' });
        const input = await body(req);
        const name = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
        if (!/^[a-z0-9][a-z0-9_.-]{1,31}$/.test(name)) return json(res, 401, { error: '账号或口令不正确，或账号已停用' });
        if (!rate(`login-account:${name}`, 10, 15 * 60_000)) return json(res, 429, { error: '此账号连续尝试过多，请 15 分钟后重试' });
        const user = await users.authenticate(name, input.password);
        if (!user) return json(res, 401, { error: '账号或口令不正确，或账号已停用' });
        limits.delete(`login-account:${name}`);
        if (sessions.size >= 1000) return json(res, 503, { error: '登录人数已达上限，请稍后重试' });
        const old = sessionFor(req); if (old) { sessions.delete(old.key); hub.revokeSession(old.key); }
        const sessionToken = token();
        sessions.set(sessionToken, { userId: user.id, expiresAt: Date.now() + sessionTTL });
        res.setHeader('Set-Cookie', cookie(req, sessionToken, sessionTTL / 1000));
        return json(res, 200, { user });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        const session = sessionFor(req); if (session) { sessions.delete(session.key); hub.revokeSession(session.key); }
        res.setHeader('Set-Cookie', cookie(req, '', 0));
        return json(res, 200, { ok: true });
      }
      if (path === '/api/users' || path.startsWith('/api/users/')) {
        const session = sessionFor(req);
        if (!session) return json(res, 401, { error: '请先登录' });
        if (session.user.role !== 'admin') return json(res, 403, { error: '只有管理员可以管理账号' });
        if (req.method === 'GET' && path === '/api/users') return json(res, 200, { users: users.list() });
        if (!rate(`user-edit:${session.user.id}`, 30)) return json(res, 429, { error: '操作过于频繁，请稍后重试' });
        const input = ['POST', 'PATCH'].includes(req.method) ? await body(req) : {};
        // Recheck after reading a body: another admin may have revoked this login.
        if (sessionFor(req)?.user.role !== 'admin') return json(res, 401, { error: '登录已失效，请重新登录' });
        if (req.method === 'POST' && path === '/api/users') return json(res, 201, { user: users.create(input) });
        const id = path.slice('/api/users/'.length);
        if (req.method === 'PATCH') {
          const user = users.update(id, input);
          if ('password' in input || !user.enabled || 'role' in input) revokeUser(id);
          return json(res, 200, { user });
        }
        if (req.method === 'DELETE') { users.remove(id); revokeUser(id); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: 'Not found' });
      }
      if (path === '/api/host-status' || path === '/api/connect') {
        const session = sessionFor(req);
        if (!session) return json(res, 401, { error: '请先登录远端账号' });
        if (req.method === 'GET' && path === '/api/host-status') return json(res, 200, hub.status());
        if (req.method === 'POST' && path === '/api/connect') {
          if (!rate('reserve:' + session.user.id, 20)) return json(res, 429, { error: '连接过于频繁，请稍后重试' });
          return json(res, 201, hub.reserve(session, req));
        }
      }
      if (path === '/api/rooms') return json(res, 410, { error: '请刷新页面，使用账号连接现场主机' });
      if (req.method === 'GET' && assets.has(path)) {
        const [filename, type] = assets.get(path);
        const data = await readFile(new URL(`../public/${filename}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(data);
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器错误' }); else res.end(); }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  const hub = createHub(server, { hostKey: env.HOST_AGENT_KEY, sessionFor, originAllowed, rate, address, iceServers, reconnectMs: Number(env.RECONNECT_GRACE_MS || 30000) });
  const cleanup = setInterval(() => {
    for (const [key, session] of sessions) if (session.expiresAt < Date.now()) { sessions.delete(key); hub.revokeSession(key); }
    for (const [key, entry] of limits) if (entry.until < Date.now()) limits.delete(key);
  }, 30000);
  cleanup.unref();
  server.shutdown = () => new Promise(resolve => { clearInterval(cleanup); hub.shutdown(); server.close(resolve); });
  return server;
}
