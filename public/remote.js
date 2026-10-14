import { initAccounts } from './accounts.js';
import { cropControls } from './crop-controls.js';
const $ = id => document.getElementById(id), base = new URL('./', location.href);
let socket, ticket, connected = false, wantConnect = false, joining = false, reconnectTimer, requestTimer, messageTimer, retry = 0, state = 'offline', peers = [];
const storageKey = 'camera-control-ticket';
function notify(text, error = false) {
  clearTimeout(messageTimer); $('message').textContent = text; $('message').className = error ? 'error' : ''; $('message').hidden = false;
  messageTimer = setTimeout(() => { $('message').hidden = true; }, error ? 12000 : 5000);
}
const accounts = initAccounts(notify);
function send(data) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: 'control', data })); return true;
}
const control = cropControls(null, 0, undefined, send);
$('usb-controls').append(control.overlay, control.element);
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
  const labels = { offline: '现场主机离线 · 等待上线', idle: '虚拟摄像头已关闭', starting: '正在准备虚拟摄像头…', capturing: '虚拟摄像头已开启 · 钉钉可使用', error: '摄像头异常：' + (status.message || '请检查本地设备') };
  $('host-status').textContent = labels[state] || '正在读取主机状态…';
  $('capture-info').textContent = (status.output?.width || 1920) + ' × ' + (status.output?.height || 1080) + ' / ' + (status.output?.fps || 30) + ' fps · USB 主画面 + 右下角笔记本画中画';
  $('system-camera-status').textContent = status.virtualCamera?.state === 'ready' ? `系统摄像头：${status.virtualCamera.device}` : status.virtualCamera?.state === 'error' ? status.virtualCamera.message : '';
  renderButton();
  if (status.view) control.applied(status.view);
  clearTimeout(requestTimer);
}
function renderPeers() {
  $('people-count').textContent = peers.filter(p => p.role === 'remote').length + ' / 2 位远端';
  $('participants').replaceChildren(...peers.filter(p => p.role === 'remote').map(peer => {
    const row = document.createElement('p'); row.textContent = peer.name + ' · 控制板已连接'; return row;
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
      $('signal-status').textContent = '● 控制板在线';
      hostStatus(message.hostState);
    } else if (message.type === 'host-state') hostStatus(message);
    else if (message.type === 'peer-joined') { peers = [...peers.filter(p => p.id !== message.peer.id), message.peer]; renderPeers(); }
    else if (message.type === 'peer-left') { peers = peers.filter(p => p.id !== message.id); renderPeers(); }
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
    socket = null; connected = false; renderButton();
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
$('leave').onclick = () => { wantConnect = false; disconnect(true); $('signal-status').textContent = '控制板已断开 · 虚拟摄像头继续输出'; };
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
window.addEventListener('pagehide', () => { wantConnect = false; clearInterval(poll); disconnect(); control.dispose(); });
window.controlDiagnostics = () => ({ connected, state, view: control.view });
