import { WebSocket, WebSocketServer } from 'ws';
import { authenticateAgent } from './agent-auth.js';

// Only the live initialization/chunks in socket buffers are held; no recording.
export function createMediaRelay({ hostKey, host, remotes, sessionFor, originAllowed, rate, address }) {
  const clients = new Map(), wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const open = ws => ws?.readyState === WebSocket.OPEN;
  const send = (ws, data, binary = false) => {
    if (!open(ws)) return;
    if (ws.bufferedAmount > 3 * 1024 * 1024) { ws.close(1013, 'Media receiver too slow'); return; }
    ws.send(data, { binary });
  };
  const targets = peer => [...clients.values()].filter(c => c.peer.role !== peer.role && open(c.ws));
  function ended(client) {
    if (clients.get(client.peer.id) !== client) return;
    clients.delete(client.peer.id);
    for (const target of targets(client.peer)) send(target.ws, JSON.stringify({ type: 'source-ended', from: client.peer.id }));
  }
  wss.on('connection', (ws, req, agent) => {
    let client, count = 0, since = Date.now(), budget = 3 * 1024 * 1024, refill = Date.now(); ws.alive = true;
    ws.on('error', () => {}); ws.on('pong', () => { ws.alive = true; });
    const timer = setTimeout(() => { if (!client) ws.close(1008, 'Media join timeout'); }, 10000);
    function join(peer) {
      if (!peer || clients.has(peer.id)) { ws.close(1008, 'Media identity unavailable'); return; }
      client = { peer, ws, epoch: 0, publishing: false }; clients.set(peer.id, client); clearTimeout(timer);
      send(ws, JSON.stringify({ type: 'media-joined' }));
      for (const target of targets(peer)) send(target.ws, JSON.stringify({ type: 'media-request' }));
    }
    if (agent) join(host());
    ws.on('message', (raw, binary) => {
      if (Date.now() - since > 1000) { count = 0; since = Date.now(); }
      if (++count > 100) { ws.close(1008, 'Media rate limit'); return; }
      const now = Date.now(); budget = Math.min(3 * 1024 * 1024, budget + (now - refill) * 1024); refill = now; budget -= raw.length;
      if (budget < 0) { ws.close(1008, 'Media bandwidth limit'); return; }
      if (!agent && !sessionFor(req)) { ws.close(1008, 'Media login expired'); return; }
      if (client && !open(client.peer.ws)) { ws.close(1008, 'Control session closed'); return; }
      if (binary) {
        if (!client?.publishing || raw.length === 0) return;
        const header = Buffer.allocUnsafe(40); header.write(client.peer.id, 0, 36, 'ascii'); header.writeUInt32BE(client.epoch, 36);
        const frame = Buffer.concat([header, raw]); for (const target of targets(client.peer)) send(target.ws, frame, true);
        return;
      }
      if (raw.length > 2048) { ws.close(1008, 'Invalid media metadata'); return; }
      try {
        const message = JSON.parse(raw.toString());
        if (!client) {
          const peer = remotes().get(message.ticket), session = sessionFor(req);
          if (message.type !== 'join' || !peer || !session || peer.sessionKey !== session.key || !open(peer.ws)) { ws.close(1008, 'Media authentication failed'); return; }
          join(peer); return;
        }
        if (message.type === 'source-start') {
          if (typeof message.mime !== 'string' || message.mime.length > 160 || !/^(video|audio)\/(webm|mp4)(;codecs=[a-zA-Z0-9., _-]+)?$/.test(message.mime) || typeof message.video !== 'boolean' || typeof message.audio !== 'boolean' || !message.video && !message.audio) { ws.close(1008, 'Unsupported media format'); return; }
          client.epoch = (client.epoch + 1) >>> 0; client.publishing = true;
          const metadata = JSON.stringify({ type: 'source-start', source: { id: client.peer.id, role: client.peer.role, name: client.peer.name }, epoch: client.epoch, mime: message.mime, video: message.video, audio: message.audio });
          for (const target of targets(client.peer)) send(target.ws, metadata);
        } else if (message.type === 'source-ended') {
          client.publishing = false; for (const target of targets(client.peer)) send(target.ws, JSON.stringify({ type: 'source-ended', from: client.peer.id }));
        } else if (message.type === 'media-request') {
          for (const target of targets(client.peer)) send(target.ws, JSON.stringify({ type: 'media-request' }));
        }
      } catch { ws.close(1008, 'Malformed media metadata'); }
    });
    ws.on('close', () => { clearTimeout(timer); if (client) ended(client); });
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 15000); heartbeat.unref();
  return {
    upgrade(req, socket, head) {
      const agent = req.url === '/agent-media'; if (!agent && req.url !== '/media') return false;
      if (agent ? !authenticateAgent(req.headers.authorization, hostKey) || !host() : !originAllowed(req.headers.origin, req) || !sessionFor(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
      if (!rate('media-connect:' + address(req), 30)) { socket.destroy(); return true; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, agent)); return true;
    },
    detach(id) { const client = clients.get(id); if (client) { ended(client); client.ws.close(1000, 'Control session ended'); } },
    shutdown() { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); }
  };
}
