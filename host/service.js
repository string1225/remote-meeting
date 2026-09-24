import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';

const assets = new Map([['/', ['host/index.html', 'text/html']], ['/host-app.js', ['host/app.js', 'text/javascript']], ['/capture.js', ['host/capture.js', 'text/javascript']], ['/crop.js', ['host/crop.js', 'text/javascript']], ['/rtc.js', ['public/rtc.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']]]);
export function createHostService(config) {
  const url = new URL('agent', config.serverUrl);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS cloud URL');
  if (typeof config.agentKey !== 'string' || config.agentKey.length < 32 || config.agentKey.startsWith('replace-')) throw new Error('Missing host agent key');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let renderer, cloud, reconnectTimer, attempt = 0, paused = false, stopping = false, localStatus = {};
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 256 * 1024) ws.close(1008, 'Slow consumer'); else ws.send(JSON.stringify(data)); } };
  const status = () => ({ renderer: renderer?.readyState === WebSocket.OPEN, online: cloud?.readyState === WebSocket.OPEN, ...localStatus });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Local service is loopback-only and rejects DNS rebinding Host headers.
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return; }
    try {
      if (req.method === 'GET' && req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(status())); return; }
      const asset = req.method === 'GET' && assets.get(req.url);
      if (!asset) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`); res.end(await readFile(new URL(`../${asset[0]}`, import.meta.url)));
    } catch { res.writeHead(500); res.end('Local host error'); }
  });
  function connectCloud() {
    clearTimeout(reconnectTimer);
    if (paused || stopping || renderer?.readyState !== WebSocket.OPEN) return;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.agentKey}` }, maxPayload: 64 * 1024, handshakeTimeout: 12000 });
    cloud = ws;
    ws.on('open', () => { attempt = 0; send(renderer, { type: 'cloud-status', online: true }); });
    ws.on('message', raw => { if (ws === cloud) { try { send(renderer, JSON.parse(raw.toString())); } catch {} } });
    ws.on('error', () => {});
    ws.on('close', () => { if (ws !== cloud) return; cloud = null; send(renderer, { type: 'cloud-status', online: false }); reconnectTimer = setTimeout(connectCloud, Math.min(1000 * 2 ** attempt++, 15000)); });
  }
  function disconnectCloud() { clearTimeout(reconnectTimer); const old = cloud; cloud = null; old?.terminate(); send(renderer, { type: 'cloud-status', online: false }); }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/bridge' || req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin !== `http://127.0.0.1:${server.address().port}` || renderer) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    renderer = ws; paused = false;
    send(ws, { type: 'config', config: { cameras: config.cameras || [], microphone: config.microphone || '', idleMs: config.idleMs ?? 3000 } });
    connectCloud();
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'local-status') { localStatus = message; delete localStatus.type; }
        else if (message.type === 'bridge-pause') { paused = true; disconnectCloud(); }
        else if (message.type === 'bridge-resume') { paused = false; connectCloud(); }
        else if (message.type === 'bridge-reconnect') { disconnectCloud(); reconnectTimer = setTimeout(connectCloud, 1000); }
        else if (['signal', 'host-state'].includes(message.type)) send(cloud, message);
      } catch { ws.close(1008, 'Invalid local message'); }
    });
    ws.on('close', () => { if (renderer === ws) { renderer = null; localStatus = {}; disconnectCloud(); } });
  });
  server.shutdown = async () => { stopping = true; disconnectCloud(); renderer?.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); };
  server.hostStatus = status;
  return server;
}
