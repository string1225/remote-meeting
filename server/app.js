import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const token = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const split = value => (value || '').split(',').map(v => v.trim()).filter(Boolean);
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

export function createMeetingServer(options = {}) {
  const env = { ...process.env, ...options };
  const adminKey = env.ADMIN_KEY;
  if (!adminKey || adminKey.length < 24 || adminKey.startsWith('replace-')) throw new Error('Set ADMIN_KEY to a random secret of at least 24 characters.');
  const allowedOrigins = split(env.ALLOWED_ORIGINS);
  const ttl = Number(env.ROOM_TTL_HOURS || 8) * 3600_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400_000) throw new Error('ROOM_TTL_HOURS must be between 0 and 24.');
  const rooms = new Map();
  const limits = new Map();
  const connections = new Map();
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
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok', mode: 'signaling-only' });
      if (req.method === 'POST' && path === '/api/rooms') {
        if (!originAllowed(req.headers.origin, req)) return json(res, 403, { error: '不允许的访问来源' });
        if (!rate(`create:${address(req)}`, 20)) return json(res, 429, { error: '创建过于频繁，请稍后重试' });
        if (!equal(req.headers.authorization, `Bearer ${adminKey}`)) return json(res, 401, { error: '主持密钥不正确' });
        if (rooms.size >= 100) return json(res, 503, { error: '会议室已达上限' });
        const room = { id: token(), hostToken: token(), guestToken: token(), expiresAt: Date.now() + ttl, peers: new Map() };
        rooms.set(room.id, room);
        return json(res, 201, { room: room.id, hostToken: room.hostToken, guestToken: room.guestToken, expiresAt: room.expiresAt });
      }
      if (req.method === 'GET' && assets.has(path)) {
        const [filename, type] = assets.get(path);
        const data = await readFile(new URL(`../public/${filename}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(data);
      }
      json(res, 404, { error: 'Not found' });
    } catch { if (!res.headersSent) json(res, 500, { error: '服务器错误' }); else res.end(); }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !originAllowed(req.headers.origin, req)) return socket.destroy();
    const ip = address(req);
    if (!rate(`connect:${ip}`, 60) || (connections.get(ip) || 0) >= 12) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  const send = (ws, msg) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.close(1008, 'Slow consumer'); return; }
    ws.send(JSON.stringify(msg));
  };
  const describe = peer => ({ id: peer.id, role: peer.role, name: peer.name });
  wss.on('connection', (ws, req) => {
    const ip = address(req);
    connections.set(ip, (connections.get(ip) || 0) + 1);
    ws.alive = true;
    let room, peer;
    let burst = { start: Date.now(), count: 0 };
    const joinTimeout = setTimeout(() => ws.close(1008, 'Join timeout'), 10_000);
    const fail = (code, message) => { send(ws, { type: 'error', code, message }); ws.close(1008, code); };
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (Date.now() - burst.start > 1000) burst = { start: Date.now(), count: 0 };
      if (++burst.count > 120) return fail('RATE_LIMIT', '信令过于频繁');
      try {
        if (isBinary) return fail('INVALID', '仅支持 JSON 信令');
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('INVALID', '无效消息');
        if (!peer) {
          if (msg.type !== 'join') return fail('AUTH', '请先加入会议');
          room = rooms.get(msg.room);
          if (!room || room.expiresAt < Date.now()) return fail('EXPIRED', '会议不存在或已过期，请联系主持人');
          const role = equal(msg.token, room.hostToken) ? 'host' : equal(msg.token, room.guestToken) ? 'guest' : null;
          if (!role) { room = null; return fail('AUTH', '邀请链接无效'); }
          if (room.peers.size >= 3 || [...room.peers.values()].filter(p => p.role === role).length >= (role === 'host' ? 1 : 2)) return fail('FULL', '会议已满（1 位主持人、2 位访客）');
          peer = { id: randomUUID(), ws, role, name: String(msg.name || (role === 'host' ? '现场主持人' : '远端访客')).trim().slice(0, 40) };
          clearTimeout(joinTimeout);
          send(ws, { type: 'joined', self: describe(peer), peers: [...room.peers.values()].map(describe), iceServers: iceServers(), expiresAt: room.expiresAt, ...(role === 'host' ? { guestToken: room.guestToken } : {}) });
          for (const p of room.peers.values()) send(p.ws, { type: 'peer-joined', peer: describe(peer) });
          room.peers.set(peer.id, peer);
          return;
        }
        if (msg.type === 'signal') {
          const target = room.peers.get(msg.to);
          if (!target || target === peer) return;
          const data = msg.data;
          if (!data || typeof data !== 'object') return;
          // An explicit signaling allowlist prevents this server becoming a generic media relay.
          if (data.description) {
            const d = data.description;
            if (!['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 48_000) return fail('INVALID', '无效 SDP');
            const streams = Array.isArray(data.streams) ? data.streams.slice(0, 4).map(s => ({ id: String(s.id || '').slice(0, 100), label: String(s.label || '').slice(0, 40), kind: s.kind === 'audio' ? 'audio' : 'video' })) : [];
            send(target.ws, { type: 'signal', from: peer.id, data: { description: { type: d.type, sdp: d.sdp }, streams } });
          } else if (data.candidate && typeof data.candidate.candidate === 'string' && data.candidate.candidate.length <= 2048) {
            const c = data.candidate;
            if (c.sdpMid !== null && typeof c.sdpMid !== 'string') return;
            if (c.sdpMLineIndex !== null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 20)) return;
            send(target.ws, { type: 'signal', from: peer.id, data: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : undefined } } });
          }
        } else if (msg.type === 'end-room' && peer.role === 'host') {
          rooms.delete(room.id);
          for (const p of room.peers.values()) { send(p.ws, { type: 'room-ended' }); p.ws.close(1000, 'Room ended'); }
        }
      } catch { fail('INVALID', '无法解析消息'); }
    });
    ws.on('close', () => {
      clearTimeout(joinTimeout);
      const count = (connections.get(ip) || 1) - 1;
      if (count) connections.set(ip, count); else connections.delete(ip);
      if (room && peer && room.peers.delete(peer.id)) for (const p of room.peers.values()) send(p.ws, { type: 'peer-left', id: peer.id });
    });
  });
  const cleanup = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    for (const [id, room] of rooms) if (room.expiresAt < Date.now()) {
      rooms.delete(id);
      for (const p of room.peers.values()) { send(p.ws, { type: 'room-ended' }); p.ws.close(1000, 'Expired'); }
    }
    for (const [key, entry] of limits) if (entry.until < Date.now()) limits.delete(key);
  }, 30_000);
  cleanup.unref();
  server.shutdown = () => new Promise(resolve => {
    clearInterval(cleanup);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(resolve);
  });
  return server;
}
