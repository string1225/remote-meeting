import '/host-accounts.js';
const $ = id => document.getElementById(id);
let bridge, current, reconnectTimer;
function showView(camera) {
  $('camera-view').hidden = !camera; $('access-settings').hidden = camera;
  $('view-cameras').setAttribute('aria-pressed', String(camera)); $('view-settings').setAttribute('aria-pressed', String(!camera));
}
function render(status) {
  current = status;
  $('connection').textContent = status.online ? '● 远端控制在线' : status.paused ? '远端控制已暂停' : '正在连接远端控制…';
  $('people-count').textContent = status.peers.length + ' / 2 位远端';
  $('capture-status').textContent = status.state === 'capturing' ? '虚拟摄像头已开启' : status.state === 'starting' ? (status.virtualCamera.state === 'stopping' ? '正在关闭摄像头…' : '正在启动摄像头…') : status.state === 'error' ? '摄像头启动失败' : '待机 · 原摄像头已释放';
  $('local-camera-toggle').textContent = status.state === 'starting' ? '取消启动 / 关闭' : status.capturing ? '关闭摄像头' : '启动摄像头';
  $('output-settings').textContent = status.output.width + ' × ' + status.output.height + ' / ' + status.output.fps + ' fps · USB 主画面 + 右下角画中画';
  $('virtual-camera-status').textContent = status.capturing ? `钉钉会议请选择 ${status.virtualCamera.device}` : status.message || '系统虚拟摄像头已停止';
  $('capture-devices').textContent = status.cameras.map(c => c.label + ' · ' + c.width + ' × ' + c.height).join(' / ');
  $('error').hidden = !status.message; $('error').textContent = status.message;
  $('pause').textContent = status.paused ? '恢复远端控制' : '暂停远端控制';
  $('participants').replaceChildren(...status.peers.map(peer => { const row = document.createElement('p'); row.textContent = peer.name + ' · 控制板已连接'; return row; }));
}
function send(message) { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message)); }
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/bridge'); bridge = ws;
  ws.onmessage = event => { if (bridge === ws) { const message = JSON.parse(event.data); if (message.type === 'host-status') render(message); } };
  ws.onclose = () => { if (bridge === ws) reconnectTimer = setTimeout(connect, 1000); };
  ws.onerror = () => {};
}
$('view-cameras').onclick = () => showView(true);
$('view-settings').onclick = () => showView(false);
$('local-camera-toggle').onclick = () => send({ type: 'control', data: { type: current?.capturing || current?.state === 'starting' ? 'camera-stop' : 'camera-start' } });
$('pause').onclick = () => send({ type: current?.paused ? 'bridge-resume' : 'bridge-pause' });
window.addEventListener('pagehide', () => { clearTimeout(reconnectTimer); const old = bridge; bridge = null; old?.close(); });
window.hostDiagnostics = () => current;
connect();
