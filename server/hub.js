import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (status, message) => Object.assign(new Error(message), { status });
const describe = p => ({ id: p.id, role: p.role, name: p.name });

export function createHub(server, { hostKey, sessionFor, originAllowed, rate, address, iceServers, reconnectMs = 30000 }) {
  if (typeof hostKey !== 'string' || hostKey.length < 32 || hostKey.startsWith('replace-')) throw new Error('HOST_AGENT_KEY must contain at least 32 random characters');
  const remotes = new Map(), connections = new Map();
  let host = null, hostState = { state: 'offline', cameras: [] };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  function send(ws, message) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.close(1008, 'Slow consumer'); return; }
    ws.send(JSON.stringify(message));
  }
  const connected = () => [...remotes.values()].filter(p => p.ws?.readyState === WebSocket.OPEN);
  const broadcast = (message, except) => { for (const p of [host, ...connected()]) if (p && p !== except) send(p.ws, message); };
  function detach(peer, reason = '连接已结束', remove = true) {
    if (remove) remotes.delete(peer.ticket);
    const ws = peer.ws;
    peer.ws = null;
    peer.reservedUntil = Date.now() + reconnectMs;
    if (ws) { send(ws, { type: 'ended', message: reason }); ws.close(1000, 'Session ended'); broadcast({ type: 'peer-left', id: peer.id }); }
  }
  function prune() {
    for (const peer of remotes.values()) {
      if (!peer.ws && peer.reservedUntil <= Date.now()) remotes.delete(peer.ticket);
      else if (!sessionFor(peer.request)) detach(peer, '登录已过期，请重新登录');
    }
  }
  server.on('upgrade', (req, socket, head) => {
    const agent = req.url === '/agent';
    if (agent ? !same(req.headers.authorization, `Bearer ${hostKey}`) : req.url !== '/ws' || !originAllowed(req.headers.origin, req) || !sessionFor(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (agent && host) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    const ip = address(req);
    if (!rate(`connect:${ip}`, 60) || (connections.get(ip) || 0) >= 12) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, agent));
  });
  wss.on('connection', (ws, req, agent) => {
    const ip = address(req); connections.set(ip, (connections.get(ip) || 0) + 1);
    ws.alive = true;
    let peer, burst = { start: Date.now(), count: 0 };
    const joinTimer = setTimeout(() => { if (!peer) ws.close(1008, 'Join timeout'); }, 10000);
    const fail = (code, message) => { send(ws, { type: 'error', code, message }); ws.close(1008, code); };
    ws.on('error', () => {});
    ws.on('pong', () => { ws.alive = true; });
    if (agent) {
      peer = host = { id: randomUUID(), role: 'host', name: '现场主机', ws };
      hostState = { state: 'idle', cameras: [] };
      clearTimeout(joinTimer);
      send(ws, { type: 'joined', self: describe(peer), peers: connected().map(describe), iceServers: iceServers() });
      broadcast({ type: 'peer-joined', peer: describe(peer) }, peer);
      broadcast({ type: 'host-state', ...hostState }, peer);
    }
    ws.on('message', (raw, binary) => {
      if (Date.now() - burst.start > 1000) burst = { start: Date.now(), count: 0 };
      if (++burst.count > 150) return fail('RATE_LIMIT', '信令过于频繁');
      try {
        if (binary) return fail('INVALID', '仅支持 JSON 信令');
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('INVALID', '无效消息');
        if (!peer) {
          prune();
          const reservation = remotes.get(msg.ticket), session = sessionFor(req);
          if (msg.type !== 'join' || !reservation || !session || reservation.sessionKey !== session.key) return fail('AUTH', '登录或连接凭据已失效，请重新连接');
          if (reservation.ws) return fail('FULL', '此连接已在使用');
          if (!host) return fail('HOST_OFFLINE', '现场主机离线，请等待主机上线');
          peer = reservation; peer.ws = ws; peer.request = req;
          clearTimeout(joinTimer);
          send(ws, { type: 'joined', self: describe(peer), peers: [host, ...connected().filter(p => p !== peer)].map(describe), iceServers: iceServers(), expiresAt: session.expiresAt, hostState });
          broadcast({ type: 'peer-joined', peer: describe(peer) }, peer);
          return;
        }
        if (!agent && !sessionFor(req)) return detach(peer, '登录已失效，请重新登录');
        if (msg.type === 'leave' && !agent) return detach(peer);
        if (msg.type === 'host-state' && agent) {
          if (!['idle', 'starting', 'capturing', 'error'].includes(msg.state)) return;
          hostState = { state: msg.state, message: String(msg.message || '').slice(0, 240), cameras: (Array.isArray(msg.cameras) ? msg.cameras : []).slice(0, 2).map((c, index) => ({ camera: index, label: String(c.label || '').slice(0, 100), width: Math.max(0, Math.min(32768, Number(c.width) || 0)), height: Math.max(0, Math.min(32768, Number(c.height) || 0)), frameRate: Math.max(0, Math.min(120, Number(c.frameRate) || 0)) })) };
          broadcast({ type: 'host-state', ...hostState }, peer); return;
        }
        if (msg.type !== 'signal') return;
        const target = [host, ...connected()].find(p => p?.id === msg.to);
        if (!target || target === peer) return;
        const data = msg.data;
        if (!data || typeof data !== 'object') return;
        if (data.description) {
          const d = data.description;
          if (!['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 48000) return fail('INVALID', '无效 SDP');
          const streams = (Array.isArray(data.streams) ? data.streams : []).slice(0, 3).map(s => ({ id: String(s.id || '').slice(0, 100), label: String(s.label || '').slice(0, 100), kind: s.kind === 'audio' ? 'audio' : 'video', camera: agent && [0, 1].includes(s.camera) ? s.camera : undefined }));
          send(target.ws, { type: 'signal', from: peer.id, data: { description: { type: d.type, sdp: d.sdp }, streams } });
        } else if (data.candidate && typeof data.candidate.candidate === 'string' && data.candidate.candidate.length <= 2048) {
          const c = data.candidate;
          if (c.sdpMid !== null && typeof c.sdpMid !== 'string') return;
          if (c.sdpMLineIndex !== null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 20)) return;
          send(target.ws, { type: 'signal', from: peer.id, data: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : undefined } } });
        }
      } catch { fail('INVALID', '无法解析消息'); }
    });
    ws.on('close', () => {
      clearTimeout(joinTimer);
      const count = (connections.get(ip) || 1) - 1;
      if (count) connections.set(ip, count); else connections.delete(ip);
      if (!peer || peer.ws !== ws) return;
      if (agent) {
        host = null; hostState = { state: 'offline', cameras: [] };
        broadcast({ type: 'peer-left', id: peer.id }); broadcast({ type: 'host-state', ...hostState });
      } else { peer.ws = null; peer.reservedUntil = Date.now() + reconnectMs; broadcast({ type: 'peer-left', id: peer.id }); }
    });
  });
  const cleanup = setInterval(() => { prune(); for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 15000);
  cleanup.unref();
  return {
    status: () => ({ online: !!host, ...hostState, participants: connected().length, capacity: 2 }),
    reserve(session, req) {
      prune();
      if (!host) throw error(503, '现场主机尚未上线，请先启动主机常驻程序');
      if (remotes.size >= 2) throw error(409, '已有两位远端连接主机，请等待有人离开');
      const ticket = randomBytes(24).toString('base64url');
      remotes.set(ticket, { ticket, id: randomUUID(), role: 'remote', name: session.user.displayName, userId: session.user.id, sessionKey: session.key, request: req, ws: null, reservedUntil: Date.now() + reconnectMs });
      return { ticket, expiresAt: session.expiresAt };
    },
    revokeUser(id) { for (const peer of remotes.values()) if (peer.userId === id) detach(peer, '账号已变更，请重新登录'); },
    revokeSession(key) { for (const peer of remotes.values()) if (peer.sessionKey === key) detach(peer, '已退出登录'); },
    shutdown() { clearInterval(cleanup); for (const ws of wss.clients) ws.terminate(); wss.close(); }
  };
}
