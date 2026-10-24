import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createVirtualCamera } from './virtual-camera.js';
import { compositeSettings } from './composite.js';
import { normalizeView } from './crop.js';

const assets = new Map([['/', ['host/index.html', 'text/html']], ['/host-app.js', ['host/app.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']], ['/host.css', ['host/style.css', 'text/css']], ['/host-accounts.js', ['host/accounts.js', 'text/javascript']]]);
for (const [path, type] of [['relay.js', 'text/javascript'], ['media.js', 'text/javascript'], ['meeting.css', 'text/css'], ['audio-meter.js', 'text/javascript'], ['audio-meter.css', 'text/css'], ['playback-controls.js', 'text/javascript']]) assets.set('/' + path, ['public/' + path, type]);
export function createHostService(config, { cameraFactory = createVirtualCamera } = {}) {
  const url = new URL('agent', config.serverUrl);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS cloud URL');
  if (typeof config.agentKey !== 'string' || config.agentKey.length < 32 || config.agentKey.startsWith('replace-')) throw new Error('Missing host agent key');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let renderer, cloud, reconnectTimer, attempt = 0, paused = false, stopping = false, remotes = [], cameras = [], view = { zoom: 1, x: 0.5, y: 0.5 }, virtualStatus = { state: 'stopped' };
  let cloudWelcome, mediaStatus = { video: false, audio: false, error: '' };
  let rendererMedia, cloudMedia;
  function closeMedia() { const remote = cloudMedia; cloudMedia = null; remote?.terminate(); const local = rendererMedia; rendererMedia = null; local?.close(); }
  const output = compositeSettings(config.output);
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 256 * 1024) ws.close(1008, 'Slow consumer'); else ws.send(JSON.stringify(data)); } };
  const status = () => ({
    renderer: renderer?.readyState === WebSocket.OPEN, online: cloud?.readyState === WebSocket.OPEN, paused,
    state: virtualStatus.state === 'ready' ? 'capturing' : ['starting', 'stopping'].includes(virtualStatus.state) ? 'starting' : virtualStatus.state === 'error' ? 'error' : 'idle',
    message: virtualStatus.message || '', capturing: virtualStatus.state === 'ready', microphone: mediaStatus.audio, media: mediaStatus,
    cameras, output, view: { ...view, camera: 0, shared: true, sourceWidth: cameras[0]?.width || 0, sourceHeight: cameras[0]?.height || 0, outputWidth: output.width, outputHeight: output.height },
    peers: remotes.map(p => ({ id: p.id, name: p.name, state: 'connected' })), virtualCamera: virtualStatus
  });
  const virtual = cameraFactory({ ...config.virtualCamera, cameras: config.cameras || [] }, message => {
    if (message.type === 'virtual-camera-state') {
      virtualStatus = message;
      cameras = message.state === 'ready' ? message.cameras || [] : [];
    } else if (message.type === 'viewport-applied') view = normalizeView(message);
    else if (message.type === 'metrics') virtualStatus = { ...virtualStatus, measuredFps: message.fps };
    publish();
  });
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
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
  function publish() {
    const current = status();
    send(renderer, { type: 'host-status', ...current });
    send(cloud, { type: 'host-state', state: current.state, message: current.message, cameras: current.cameras, output: current.output, view: current.view, virtualCamera: current.virtualCamera, media: mediaStatus });
  }
  function mediaConfig() { if (cloudWelcome) send(renderer, { type: 'media-config', ...cloudWelcome, peers: remotes }); }
  function command(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'camera-start') {
      if (['ready', 'starting', 'stopping'].includes(virtualStatus.state)) return;
      view = { zoom: 1, x: 0.5, y: 0.5 };
      void virtual.start(output);
    } else if (data.type === 'camera-stop') void virtual.stop();
    else if (data.type === 'viewport' && data.camera === 0 && virtualStatus.state === 'ready') {
      try { virtual.setView(normalizeView(data)); } catch { /* Invalid control coordinates. */ }
    }
  }
  const knownRemotes = new Set();
  function updateRemotes(next) {
    remotes = next.filter(peer => peer.role === 'remote');
    const fresh = remotes.some(peer => !knownRemotes.has(peer.id));
    for (const peer of remotes) knownRemotes.add(peer.id);
    for (const id of knownRemotes) { if (knownRemotes.size <= 256) break; if (!remotes.some(peer => peer.id === id)) knownRemotes.delete(id); }
    if (fresh && !paused) command({ type: 'camera-start' });
    publish();
  }
  function connectCloud() {
    clearTimeout(reconnectTimer);
    if (paused || stopping) return;
    const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + config.agentKey }, maxPayload: 64 * 1024, handshakeTimeout: 12000 });
    cloud = ws;
    ws.on('open', () => { attempt = 0; publish(); });
    ws.on('message', raw => {
      if (ws !== cloud) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'joined') { cloudWelcome = { self: message.self }; updateRemotes(message.peers); mediaConfig(); }
        else if (message.type === 'peer-joined') { updateRemotes([...remotes.filter(p => p.id !== message.peer.id), message.peer]); send(renderer, message); }
        else if (message.type === 'peer-left') { remotes = remotes.filter(p => p.id !== message.id); publish(); send(renderer, message); }
        else if (message.type === 'control') command(message.data);
      } catch { /* Cloud only sends validated JSON controls. */ }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (ws !== cloud) return;
      cloud = null; cloudWelcome = null; remotes = []; closeMedia(); send(renderer, { type: 'media-disconnected' }); publish();
      reconnectTimer = setTimeout(connectCloud, Math.min(1000 * 2 ** attempt++, 15000));
    });
  }
  function disconnectCloud() {
    clearTimeout(reconnectTimer); const old = cloud; cloud = null; cloudWelcome = null; old?.terminate(); remotes = []; closeMedia(); send(renderer, { type: 'media-disconnected' }); publish();
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  mediaWss.on('connection', ws => {
    rendererMedia = ws;
    const mediaUrl = new URL(url); mediaUrl.pathname = mediaUrl.pathname.replace(/agent$/, 'agent-media');
    const upstream = new WebSocket(mediaUrl, { headers: { Authorization: 'Bearer ' + config.agentKey }, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false }); cloudMedia = upstream;
    const forward = (target, data, binary) => { if (target.readyState === WebSocket.OPEN) { if (target.bufferedAmount > 3 * 1024 * 1024) target.close(1013, 'Media congestion'); else target.send(data, { binary }); } };
    ws.on('error', () => {}); upstream.on('error', () => {});
    ws.on('message', (raw, binary) => forward(upstream, raw, binary)); upstream.on('message', (raw, binary) => forward(ws, raw, binary));
    ws.on('close', () => { upstream.terminate(); if (rendererMedia === ws) rendererMedia = null; if (cloudMedia === upstream) cloudMedia = null; });
    upstream.on('close', () => ws.close());
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/media-bridge') {
      if (req.headers.host !== '127.0.0.1:' + server.address().port || req.headers.origin !== 'http://127.0.0.1:' + server.address().port || rendererMedia || !renderer || cloud?.readyState !== WebSocket.OPEN) { socket.destroy(); return; }
      mediaWss.handleUpgrade(req, socket, head, ws => mediaWss.emit('connection', ws)); return;
    }
    if (req.headers.host !== '127.0.0.1:' + server.address().port || req.headers.origin !== 'http://127.0.0.1:' + server.address().port || req.url !== '/bridge' || renderer) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    renderer = ws;
    send(ws, { type: 'config', config: { microphone: config.microphone || '', output, mediaTest: config.mediaTest === true } });
    publish(); mediaConfig();
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      try {
        if (binary) { ws.close(1008, 'Controls only'); return; }
        const message = JSON.parse(raw.toString());
        if (message.type === 'control') command(message.data);
        else if (message.type === 'media-status') { mediaStatus = { video: message.video === true, audio: message.audio === true, error: String(message.error || '').slice(0, 240) }; publish(); }
        else if (message.type === 'bridge-pause') { paused = true; disconnectCloud(); }
        else if (message.type === 'bridge-resume') { paused = false; connectCloud(); publish(); }
      } catch { ws.close(1008, 'Invalid local control'); }
    });
    ws.on('close', () => { if (renderer === ws) { renderer = null; closeMedia(); mediaStatus = { video: false, audio: false, error: '' }; send(cloud, { type: 'media-reset' }); publish(); } });
  });
  server.on('listening', connectCloud);
  server.shutdown = async () => { stopping = true; disconnectCloud(); renderer?.terminate(); closeMedia(); await virtual.stop(); wss.close(); mediaWss.close(); await new Promise(resolve => server.close(resolve)); };
  server.hostStatus = status;
  return server;
}
