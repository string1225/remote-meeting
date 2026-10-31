import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createRtcWorker } from './rtc-worker.js';
import { compositeSettings } from './composite.js';
import { normalizeView } from './crop.js';
import { createDeviceSettings, validateDeviceSettings } from './device-settings.js';

const assets = new Map([['/', ['host/index.html', 'text/html']], ['/host-app.js', ['host/app.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']], ['/host.css', ['host/style.css', 'text/css']], ['/host-accounts.js', ['host/accounts.js', 'text/javascript']]]);
assets.set('/device-controls.js', ['host/device-controls.js', 'text/javascript']);
for (const [path, type] of [['rtc.js', 'text/javascript'], ['media.js', 'text/javascript'], ['meeting.css', 'text/css'], ['audio-meter.js', 'text/javascript'], ['audio-meter.css', 'text/css'], ['playback-controls.js', 'text/javascript']]) assets.set('/' + path, ['public/' + path, type]);
export function createHostService(config, { cameraFactory = createRtcWorker } = {}) {
  const url = new URL('agent', config.serverUrl);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS cloud URL');
  if (typeof config.agentKey !== 'string' || config.agentKey.length < 32 || config.agentKey.startsWith('replace-')) throw new Error('Missing host agent key');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let renderer, cloud, reconnectTimer, attempt = 0, paused = false, stopping = false, remotes = [], cameras = [], view = { zoom: 1, x: 0.5, y: 0.5 }, virtualStatus = { state: 'stopped' };
  let cloudWelcome, mediaStatus = { video: false, audio: false, error: '' };
  let microphoneStatus = { state: 'stopped' };
  const output = compositeSettings(config.output);
  const deviceSettings = createDeviceSettings({ file: config.deviceSettingsFile, fallback: config });
  let deviceSaving = false;
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 256 * 1024) ws.close(1008, 'Slow consumer'); else ws.send(JSON.stringify(data)); } };
  const status = () => ({
    renderer: renderer?.readyState === WebSocket.OPEN, online: cloud?.readyState === WebSocket.OPEN, paused,
    state: virtualStatus.state === 'ready' ? 'capturing' : ['starting', 'stopping'].includes(virtualStatus.state) ? 'starting' : virtualStatus.state === 'error' ? 'error' : 'idle',
    message: virtualStatus.message || '', capturing: virtualStatus.state === 'ready', microphone: mediaStatus.audio, media: mediaStatus, microphoneStatus,
    cameras, output, view: { ...view, camera: 0, shared: true, sourceWidth: cameras[0]?.width || 0, sourceHeight: cameras[0]?.height || 0, outputWidth: output.width, outputHeight: output.height },
    peers: remotes.map(p => ({ id: p.id, name: p.name, state: 'connected' })), virtualCamera: virtualStatus
  });
  const virtual = cameraFactory({ ...config.virtualCamera, ...config.rtc, output, ...deviceSettings.value, synthetic: config.mediaTest === true || config.rtc?.synthetic === true || config.virtualCamera?.synthetic === true }, message => {
    if (message.type === 'virtual-camera-state') {
      virtualStatus = message;
      cameras = message.state === 'ready' ? message.cameras || [] : []; mediaStatus.video = message.state === 'ready';
    } else if (message.type === 'microphone-state') { microphoneStatus = message; mediaStatus.audio = message.state === 'ready'; mediaStatus.error = message.state === 'error' ? message.message : ''; }
    else if (message.type === 'audio-metrics') { microphoneStatus = { ...microphoneStatus, ...message, type: 'microphone-state' }; }
    else if (message.type === 'signal') { send(cloud, message); return; }
    else if (message.type === 'worker-error') { mediaStatus.error = message.message; }
    else if (message.type === 'viewport-applied') view = normalizeView(message);
    else if (message.type === 'metrics') virtualStatus = { ...virtualStatus, measuredFps: message.fps, encoder: message.encoder, encodeMs: message.encodeMs, renderMs: message.renderMs };
    publish();
  });
  function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    // Local service is loopback-only and rejects DNS rebinding Host headers.
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return; }
    try {
      if (req.url === '/api/devices' || req.url === '/api/devices/config') {
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (req.headers['x-host-console'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== origin || req.method !== 'GET' && req.headers.origin !== origin) return json(res, 403, { error: '请在本机控制台操作' });
        if (req.method === 'GET' && req.url === '/api/devices') {
          try { return json(res, 200, { devices: await virtual.listDevices(), settings: deviceSettings.value, file: deviceSettings.file || '', saving: deviceSaving }); }
          catch (error) { return json(res, 503, { error: error.message }); }
        }
        if (req.method !== 'PUT' || req.url !== '/api/devices/config') return json(res, 405, { error: '不支持的操作' });
        if (deviceSaving) return json(res, 409, { error: '正在保存另一份设备配置，请稍后重试' });
        if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: '请使用 JSON 请求' });
        deviceSaving = true;
        try {
          let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return json(res, 413, { error: '请求过长' }); }
          let next; try { next = validateDeviceSettings(JSON.parse(raw)); } catch (error) { return json(res, 400, { error: error.message }); }
          const catalog = await virtual.listDevices();
          if (next.cameras.some(name => !catalog.cameras.includes(name)) || next.microphone && !catalog.microphones.some(m => m.id === next.microphone || m.name === next.microphone)) return json(res, 400, { error: '所选设备未连接，请刷新设备列表' });
          await deviceSettings.save(next);
          try { await virtual.applyDevices(next); }
          catch (error) { return json(res, 200, { settings: next, file: deviceSettings.file || '', warning: '配置已保存，暂未完成应用：' + error.message }); }
          return json(res, 200, { settings: next, file: deviceSettings.file || '' });
        } catch (error) { return json(res, 500, { error: '保存设备配置失败：' + error.message }); }
        finally { deviceSaving = false; }
      }
      if (req.method === 'POST' && ['/api/devices/camera', '/api/devices/microphone'].includes(req.url)) {
        if (req.headers.origin !== `http://127.0.0.1:${server.address().port}` || req.headers['x-host-console'] !== '1' || req.headers['content-type'] !== 'application/json') return json(res, 403, { error: '请在本机控制台操作' });
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 256) return json(res, 413, { error: '请求过长' }); }
        let data; try { data = JSON.parse(raw); } catch { return json(res, 400, { error: '无效的开关请求' }); }
        if (typeof data?.enabled !== 'boolean') return json(res, 400, { error: '需要 enabled 开关' });
        command({ type: `${req.url.endsWith('/camera') ? 'camera' : 'microphone'}-${data.enabled ? 'start' : 'stop'}` });
        return json(res, 202, { accepted: true });
      }
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
      if (req.method === 'GET' && req.url.startsWith('/api/preview')) { const image = virtual.preview; if (!image) { res.writeHead(204); res.end(); } else { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(image); } return; }
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
    send(cloud, { type: 'host-state', state: current.state, message: current.message, cameras: current.cameras, output: current.output, view: current.view, virtualCamera: current.virtualCamera, media: mediaStatus, microphoneStatus });
  }
  function mediaConfig() { if (cloudWelcome) send(renderer, { type: 'media-config', ...cloudWelcome, peers: remotes }); }
  function command(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'camera-start') {
      if (['ready', 'starting', 'stopping'].includes(virtualStatus.state)) return;
      view = { zoom: 1, x: 0.5, y: 0.5 };
      void virtual.start(output);
    } else if (data.type === 'camera-stop') void virtual.stop();
    else if (data.type === 'microphone-start' || data.type === 'microphone-stop') virtual.microphone?.(data.type === 'microphone-start');
    else if (data.type === 'viewport' && data.camera === 0 && virtualStatus.state === 'ready') {
      try { virtual.setView(normalizeView(data)); } catch { /* Invalid control coordinates. */ }
    }
  }
  function updateRemotes(next) {
    const previous = remotes; remotes = next.filter(p => p.role === 'remote');
    for (const peer of previous) if (!remotes.some(p => p.id === peer.id)) virtual.peerRemove?.(peer.id);
    for (const peer of remotes) virtual.peerAdd?.(peer.id);
    if (previous.length && !remotes.length) void virtual.stop();
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
          if (message.type === 'joined') { cloudWelcome = { self: message.self, iceServers: message.iceServers }; virtual.configure?.(message.iceServers); updateRemotes(message.peers); mediaConfig(); }
          else if (message.type === 'ice-config' && cloudWelcome) { cloudWelcome.iceServers = message.iceServers; virtual.configure?.(message.iceServers); mediaConfig(); }
        else if (message.type === 'peer-joined') { updateRemotes([...remotes.filter(p => p.id !== message.peer.id), message.peer]); send(renderer, message); }
        else if (message.type === 'peer-left') { updateRemotes(remotes.filter(p => p.id !== message.id)); send(renderer, message); }
        else if (message.type === 'control') command(message.data);
        else if (message.type === 'signal') { if (message.channel === 'host-media') { if (message.data.restart) { virtual.peerRemove?.(message.from); virtual.peerAdd?.(message.from); } else virtual.signal?.(message.from, message.data); } else send(renderer, message); }
      } catch { /* Cloud only sends validated JSON controls. */ }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (ws !== cloud) return;
      cloud = null; cloudWelcome = null; updateRemotes([]); send(renderer, { type: 'media-disconnected' });
      reconnectTimer = setTimeout(connectCloud, Math.min(1000 * 2 ** attempt++, 15000));
    });
  }
  function disconnectCloud() {
    clearTimeout(reconnectTimer); const old = cloud; cloud = null; cloudWelcome = null; old?.terminate(); updateRemotes([]); send(renderer, { type: 'media-disconnected' });
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
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
        else if (message.type === 'signal' && message.channel === 'remote-media') send(cloud, message);
        else if (message.type === 'bridge-pause') { paused = true; disconnectCloud(); }
        else if (message.type === 'bridge-resume') { paused = false; connectCloud(); publish(); }
      } catch { ws.close(1008, 'Invalid local control'); }
    });
    ws.on('close', () => { if (renderer === ws) { renderer = null; send(cloud, { type: 'media-reset' }); publish(); } });
  });
  server.on('listening', connectCloud);
  server.shutdown = async () => { stopping = true; disconnectCloud(); renderer?.terminate(); if (virtual.shutdown) await virtual.shutdown(); else await virtual.stop(); wss.close(); await new Promise(resolve => server.close(resolve)); };
  server.hostStatus = status;
  return server;
}
