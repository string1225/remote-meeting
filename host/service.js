import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';

const assets = new Map([['/', ['host/index.html', 'text/html']], ['/host-app.js', ['host/app.js', 'text/javascript']], ['/capture.js', ['host/capture.js', 'text/javascript']], ['/crop.js', ['host/crop.js', 'text/javascript']], ['/rtc.js', ['public/rtc.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']]]);
assets.set('/host-accounts.js', ['host/accounts.js', 'text/javascript']);
export function createHostService(config) {
  const url = new URL('agent', config.serverUrl);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS cloud URL');
  if (typeof config.agentKey !== 'string' || config.agentKey.length < 32 || config.agentKey.startsWith('replace-')) throw new Error('Missing host agent key');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let renderer, cloud, reconnectTimer, attempt = 0, paused = false, stopping = false, localStatus = {};
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 256 * 1024) ws.close(1008, 'Slow consumer'); else ws.send(JSON.stringify(data)); } };
  const status = () => ({ renderer: renderer?.readyState === WebSocket.OPEN, online: cloud?.readyState === WebSocket.OPEN, ...localStatus });
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Local service is loopback-only and rejects DNS rebinding Host headers.
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return; }
    try {
      if (req.url === '/api/users' || req.url.startsWith('/api/users/')) {
        const origin = `http://127.0.0.1:${server.address().port}`;
        // A non-simple header also protects GETs and blocks cross-site forms.
        if (req.headers['x-host-console'] !== '1' || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site'
          || (req.method !== 'GET' && req.headers.origin !== origin)) return json(res, 403, { error: '请在本机控制台操作' });
        if (!/^\/api\/users(?:\/[a-f0-9-]{36})?$/.test(req.url)) return json(res, 404, { error: '账号不存在' });
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return json(res, 405, { error: '不支持的操作' });
        let body;
        if (['POST', 'PATCH'].includes(req.method)) {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '请使用 JSON 请求' });
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 4096) return json(res, 413, { error: '请求内容过长' }); chunks.push(chunk); }
          body = Buffer.concat(chunks);
        }
        try {
          const response = await fetch(new URL(`api/agent/users${req.url.slice('/api/users'.length)}`, config.serverUrl), {
            method: req.method, headers: { Authorization: `Bearer ${config.agentKey}`, 'Content-Type': 'application/json' }, body,
            redirect: 'error', signal: AbortSignal.timeout(10000)
          });
          const data = await response.json();
          if (response.status === 404 && data.error === 'Not found') return json(res, 502, { error: '云端尚未支持人员配置，请更新云端服务' });
          return json(res, response.status, response.ok && req.method === 'GET' ? { ...data, loginUrl: config.serverUrl } : data);
        } catch { return json(res, 502, { error: req.method === 'GET' ? '无法连接云端，请检查网络后刷新人员列表' : '未能确认保存结果，请恢复网络并刷新列表核对后再操作' }); }
      }
      if (req.method === 'GET' && req.url === '/api/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(status())); return; }
      const asset = req.method === 'GET' && assets.get(req.url);
      if (!asset) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`); res.end(await readFile(new URL(`../${asset[0]}`, import.meta.url)));
    } catch { res.writeHead(500); res.end('Local host error'); }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
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
