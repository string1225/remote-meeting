import { initAccounts } from './accounts.js';
import { cropControls } from './crop-controls.js';
import { MeetingRelay } from './relay.js';
import { LocalMedia, pageFullscreen, preview, remotePlayers } from './media.js';
import { createAudioMonitor } from './audio-meter.js';
import { createPlaybackControls } from './playback-controls.js';
const $ = id => document.getElementById(id), base = new URL('./', location.href);
let socket, ticket, connected = false, wantConnect = false, joining = false, reconnectTimer, requestTimer, messageTimer, retry = 0, state = 'offline', peers = [];
const storageKey = 'camera-control-ticket';
let hostMedia = {}, self, localBusy = false;
function notify(text, error = false) {
  clearTimeout(messageTimer); $('message').textContent = text; $('message').className = error ? 'error' : ''; $('message').hidden = false;
  messageTimer = setTimeout(() => { $('message').hidden = true; }, error ? 12000 : 5000);
}
const accounts = initAccounts(notify);
const micConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const monitor = createAudioMonitor({ container: $('remote-audio-monitor'), onError: message => notify(message, true), requestMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: micConstraints, video: false }) });
const playback = createPlaybackControls({ button: $('play-audio'), container: $('remote-audio'), activate: monitor.activate, onError: message => notify(message, true) });
const media = new LocalMedia(async () => {
  preview($('self-video'), media.stream.getVideoTracks()[0]); $('self-empty').hidden = media.has('video');
  monitor.setMicrophone(media.has('audio') ? new MediaStream(media.stream.getAudioTracks()) : null);
  $('camera-toggle').textContent = media.has('video') ? '关闭我的摄像头' : '开启我的摄像头';
  $('microphone-toggle').textContent = media.has('audio') ? '关闭麦克风' : '开启麦克风';
  $('self-status').textContent = `我的摄像头${media.has('video') ? '已开启' : '已关闭'} · 麦克风${media.has('audio') ? '已开启' : '已关闭'}`;
  await rtc.sync();
}, message => notify(message + '。仍可接收现场画面和声音。', true));
const players = remotePlayers({ mainVideo: $('host-video'), audioContainer: $('remote-audio'), playback, monitor, onChange: renderVideo });
const rtc = new MeetingRelay({ stream: media.stream, createSocket: () => { const url = new URL('media', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return new WebSocket(url); }, join: () => ({ type: 'join', ticket }),
  onSource: (peer, state) => players.source(peer, state), onPeer: peer => { players.update(peer); renderPeers(); }, onRemove: peer => players.remove(peer), onError: error => notify('音视频连接异常：' + error.message, true)
});
const closeFullscreen = pageFullscreen($('host-stage'), $('host-fullscreen'));
function renderVideo() {
  const video = $('host-video');
  const receiving = state === 'capturing' && !!video.getAttribute('src') && video.readyState >= 2;
  $('host-video').hidden = !receiving; $('video-empty').hidden = receiving;
  $('video-empty').textContent = !connected ? '等待连接现场…' : state === 'error' ? '现场设备异常，请检查本地主机' : state === 'idle' ? '现场摄像头已关闭，点击“启动摄像头”查看' : '正在连接现场画面…';
}
async function startLocal() {
  if (localBusy || !connected) return; localBusy = true; void monitor.activate();
  try { await Promise.all([media.set('audio', true, micConstraints), media.set('video', true, { facingMode: 'user', width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 15, max: 15 } })]); }
  finally { localBusy = false; }
}
function send(data) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: 'control', data })); return true;
}
const control = cropControls($('host-video'), 0, undefined, send);
$('video-controls').append(control.overlay); $('usb-controls').append(control.element);
control.setEnabled(false);
function renderButton() {
  const button = $('host-camera-toggle');
  button.disabled = !connected || state === 'starting' || state === 'offline';
  button.textContent = state === 'starting' ? '摄像头正在准备…' : state === 'capturing' ? '关闭摄像头' : '启动摄像头';
  button.setAttribute('aria-pressed', String(state === 'capturing'));
  control.setEnabled(connected && state === 'capturing');
  $('join-button').hidden = connected;
}
function hostStatus(status) {
  state = status.state;
  const labels = { offline: '现场主机离线 · 等待上线', idle: '现场摄像头已关闭', starting: '正在准备现场摄像头…', capturing: '现场摄像头已开启', error: '摄像头异常：' + (status.message || '请检查本地设备') };
  $('host-status').textContent = labels[state] || '正在读取主机状态…';
  $('capture-info').textContent = (status.output?.width || 1920) + ' × ' + (status.output?.height || 1080) + ' / ' + (status.output?.fps || 30) + ' fps · USB 主画面 + 右下角笔记本画中画';
  hostMedia = status.media || {};
  $('system-camera-status').textContent = hostMedia.error || (hostMedia.audio ? '现场麦克风已开启' : '现场麦克风未开启');
  renderButton(); renderVideo();
  if (status.view) control.applied(status.view);
  clearTimeout(requestTimer);
}
function renderPeers() {
  $('people-count').textContent = peers.filter(p => p.role === 'remote').length + ' / 2 位远端';
  $('participants').replaceChildren(...peers.map(peer => {
    const row = document.createElement('p'), link = rtc.peers.get(peer.id);
    row.textContent = peer.name + ' · ' + (peer.id === self?.id ? '我' : link?.link || ({ connected: '音视频已连接', connecting: '正在连接音视频', failed: '中转连接失败', disconnected: '正在重连' })[link?.state] || '已接入'); return row;
  }));
}
async function api(path, method = 'GET') {
  const response = await fetch(new URL('api/' + path, base), { method });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status }); return data;
}
function disconnect(leave = false) {
  clearTimeout(reconnectTimer); clearTimeout(requestTimer);
  const old = socket; socket = null; connected = false;
  if (leave) { if (old?.readyState === WebSocket.OPEN) old.send(JSON.stringify({ type: 'leave' })); ticket = null; sessionStorage.removeItem(storageKey); }
  old?.close(); control.setEnabled(false); renderButton();
  rtc.clear(); closeFullscreen(); void media.stop(); monitor.reset(); renderVideo();
}
function openSocket() {
  if (!wantConnect || !ticket) return;
  const url = new URL('ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url); socket = ws;
  const timeout = setTimeout(() => ws.close(), 10000);
  $('signal-status').textContent = '正在连接控制板…';
  ws.onopen = () => { clearTimeout(timeout); ws.send(JSON.stringify({ type: 'join', ticket })); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    const message = JSON.parse(event.data);
    if (message.type === 'joined') {
      connected = true; retry = 0; peers = [message.self, ...message.peers]; renderPeers();
      self = message.self; rtc.configure(self);
      for (const peer of message.peers) rtc.add(peer);
      $('signal-status').textContent = '● 已接入现场';
      hostStatus(message.hostState);
      void startLocal();
    } else if (message.type === 'host-state') hostStatus(message);
    else if (message.type === 'peer-joined') { peers = [...peers.filter(p => p.id !== message.peer.id), message.peer]; rtc.add(message.peer); renderPeers(); }
    else if (message.type === 'peer-left') { peers = peers.filter(p => p.id !== message.id); rtc.remove(message.id); renderPeers(); }
    else if (message.type === 'media-reset') { rtc.remove(message.from); const peer = peers.find(p => p.id === message.from); if (peer) rtc.add(peer); }
    else if (message.type === 'error' || message.type === 'ended') {
      disconnect(true); notify(message.message, true);
      if (message.code === 'AUTH') { reconnectTimer = setTimeout(() => void activate(), 1000); }
      else if (message.type === 'ended') { wantConnect = false; void accounts.refresh(); }
      else wantConnect = false;
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    clearTimeout(timeout); if (socket !== ws) return;
    socket = null; connected = false; rtc.clear(); renderButton(); renderVideo();
    $('signal-status').textContent = '控制连接中断，正在恢复…';
    if (wantConnect) reconnectTimer = setTimeout(openSocket, Math.min(1000 * 2 ** retry++, 5000));
  };
}
async function activate() {
  if (!accounts.current()) return;
  $('lobby').hidden = true; $('meeting').hidden = false; document.body.classList.add('control-active');
  if (!wantConnect || joining || socket) return;
  joining = true;
  try {
    ticket ||= sessionStorage.getItem(storageKey);
    if (!ticket) { ticket = (await api('connect', 'POST')).ticket; sessionStorage.setItem(storageKey, ticket); }
    openSocket();
  } catch (error) { notify(error.message, true); $('signal-status').textContent = error.status === 503 ? '等待现场主机上线…' : '控制连接未建立'; if (error.status === 401) await accounts.refresh(); }
  finally { joining = false; renderButton(); }
}
document.addEventListener('account-change', () => {
  if (accounts.current()) { wantConnect = true; void activate(); }
  else {
    wantConnect = false; disconnect(true); peers = []; state = 'offline';
    $('lobby').hidden = false; $('meeting').hidden = true; document.body.classList.remove('control-active'); renderPeers();
  }
});
$('setup-form').onsubmit = async event => { event.preventDefault(); try { await accounts.ensureLoggedIn(); } catch (error) { notify(error.message, true); } };
$('join-button').onclick = () => { wantConnect = true; void activate(); };
$('leave').onclick = () => { wantConnect = false; disconnect(true); peers = []; renderPeers(); $('signal-status').textContent = '通话已退出'; };
$('camera-toggle').onclick = () => { if (connected) void media.set('video', !media.has('video'), { facingMode: 'user', width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 15, max: 15 } }); };
$('microphone-toggle').onclick = () => { if (connected) { void monitor.activate(); void media.set('audio', !media.has('audio'), micConstraints); } };
$('host-camera-toggle').onclick = () => {
  if (!send({ type: state === 'capturing' ? 'camera-stop' : 'camera-start' })) return;
  $('host-camera-toggle').disabled = true;
  requestTimer = setTimeout(() => { renderButton(); notify('暂未收到摄像头状态，请检查本地主机。', true); }, 20000);
};
const poll = setInterval(async () => {
  if (!accounts.current()) return;
  try { if (!connected) { hostStatus(await api('host-status')); if (wantConnect) void activate(); } }
  catch (error) { if (error.status === 401) await accounts.refresh(); }
}, 10000);
const statsTimer = setInterval(() => void rtc.stats(), 3000);
window.addEventListener('pagehide', () => { wantConnect = false; clearInterval(poll); clearInterval(statsTimer); disconnect(); control.dispose(); monitor.dispose(); });
window.controlDiagnostics = () => ({ connected, state, view: control.view, localMedia: rtc.flags(), rtc: [...rtc.peers.values()].map(peer => ({ id: peer.info.id, state: peer.state, media: peer.media })) });
window.meetingStats = () => rtc.stats();
