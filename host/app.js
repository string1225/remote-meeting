import '/host-accounts.js';
import '/device-controls.js';
import { MeetingRTC } from '/rtc.js';
import { pageFullscreen, remotePlayers } from '/media.js';
import { createAudioMonitor } from '/audio-meter.js';
import { createPlaybackControls } from '/playback-controls.js';
const $ = id => document.getElementById(id);
let bridge, current, reconnectTimer, viewChosen = false;
function showView(camera) {
  viewChosen = true; $('camera-view').hidden = !camera; $('access-settings').hidden = camera;
  $('view-cameras').setAttribute('aria-pressed', String(camera)); $('view-settings').setAttribute('aria-pressed', String(!camera));
}
function send(message) { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message)); }
function error(message) { $('error').textContent = String(message); $('error').hidden = false; }
const monitor = createAudioMonitor({ container: $('host-audio'), onError: error, requestMicrophone: () => Promise.reject(new Error('现场话筒由本地后端管理')) });
monitor.element.querySelector('[data-audio-action="microphone"]').hidden = true;
monitor.element.querySelector('[data-audio-kind="microphone"]').hidden = true;
const playback = createPlaybackControls({ button: $('play-audio'), container: $('remote-audio'), activate: monitor.activate, onError: error });
const players = remotePlayers({ container: $('remote-media'), audioContainer: $('remote-audio'), playback, monitor, onChange: () => { $('remote-empty').hidden = players.size > 0; } });
const rtc = new MeetingRTC({ channel: 'remote-media', initiate: true, receive: true, send, onTrack: (peer, track) => players.track(peer, track), onPeer: peer => { players.update(peer); renderParticipants(); }, onRemove: peer => players.remove(peer), onError: e => error(e.message) });
pageFullscreen($('local-stage'), $('local-fullscreen'));
$('local-preview').onload = () => { if (current?.capturing) { $('local-preview').hidden = false; $('local-empty').hidden = true; } };
$('local-preview').onerror = () => { $('local-preview').hidden = true; $('local-empty').hidden = false; };
function renderParticipants() {
  $('participants').replaceChildren(...(current?.peers || []).map(info => {
    const peer = rtc.peers.get(info.id), row = document.createElement('p'); row.textContent = info.name + ' · ' + (peer?.link || ({ connected: '音视频已连接', failed: '服务器转发连接失败，请检查网络', disconnected: '连接中断，正在恢复' }[peer?.state] || '正在连接转发服务器')); return row;
  }));
}
function render(status) {
  const first = !current?.peers.length && status.peers.length; current = status;
  $('connection').textContent = status.online ? '● 远端接入在线' : status.paused ? '远端接入已暂停' : '正在连接远端…';
  $('people-count').textContent = status.peers.length + ' / 2 位远端';
  $('capture-status').textContent = status.capturing ? '现场摄像头已开启' : status.state === 'starting' ? '正在切换摄像头…' : status.state === 'error' ? '摄像头启动失败' : '待机 · 原摄像头已释放';
  $('local-camera-toggle').textContent = status.state === 'starting' ? '取消启动 / 关闭' : status.capturing ? '关闭摄像头' : '启动摄像头';
  $('host-microphone-toggle').textContent = status.microphoneStatus.state === 'starting' ? '话筒正在启动…' : status.microphone ? '关闭现场话筒' : '开启现场话筒';
  $('host-microphone-toggle').disabled = status.microphoneStatus.state === 'starting';
  const audio = status.microphoneStatus;
  $('microphone-format').textContent = status.microphone ? `${audio.device || '现场话筒'} · 采集 ${audio.captureRate / 1000} kHz / ${audio.captureChannels} 声道 → Opus ${audio.encodeRate / 1000} kHz · ${audio.packetDurationMs} ms/包${audio.packetsPerSecond ? ' · ' + audio.packetsPerSecond + ' 包/秒' : ''}` : '现场话筒已关闭';
  $('output-settings').textContent = `${status.output.width} × ${status.output.height} / ${status.output.fps} fps · USB 主画面 + 右下角画中画`;
  $('virtual-camera-status').textContent = '现场设备由本地后端直接采集 · WebRTC ?????';
  $('capture-devices').textContent = status.cameras.map(c => c.label + ' · ' + c.width + ' × ' + c.height).join(' / ');
  $('error').hidden = !status.message && !status.media.error; $('error').textContent = status.message || status.media.error;
  $('pause').textContent = status.paused ? '恢复远端接入' : '暂停远端接入';
  const previewReady = status.capturing && $('local-preview').naturalWidth > 0 && !!$('local-preview').getAttribute('src');
  $('local-empty').hidden = previewReady; $('local-preview').hidden = !previewReady;
  $('local-empty').textContent = status.capturing ? '正在读取现场合成预览…' : '远端可启动现场摄像头';
  if (!status.capturing) $('local-preview').removeAttribute('src');
  if (first && !viewChosen) showView(true); renderParticipants();
}
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/bridge'); bridge = ws;
  ws.onmessage = event => {
    if (bridge !== ws) return; const message = JSON.parse(event.data);
    if (message.type === 'host-status') render(message);
    else if (message.type === 'media-config') { rtc.configure(message.self, message.iceServers); for (const peer of message.peers) rtc.add(peer); }
    else if (message.type === 'peer-joined') rtc.add(message.peer);
    else if (message.type === 'peer-left') rtc.remove(message.id);
    else if (message.type === 'media-disconnected') rtc.clear();
    else if (message.type === 'signal') rtc.signal(message.from, message.data);
  };
  ws.onclose = () => { if (bridge === ws) { rtc.clear(); reconnectTimer = setTimeout(connect, 1000); } }; ws.onerror = () => {};
}
$('view-cameras').onclick = () => showView(true); $('view-settings').onclick = () => showView(false);
async function device(kind, enabled) {
  try { const response = await fetch('/api/devices/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Host-Console': '1' }, body: JSON.stringify({ enabled }) }); if (!response.ok) throw new Error((await response.json()).error); }
  catch (e) { error(e.message); }
}
$('local-camera-toggle').onclick = () => void device('camera', !(current?.capturing || current?.state === 'starting'));
$('host-microphone-toggle').onclick = () => void device('microphone', !current?.microphone);
$('pause').onclick = () => send({ type: current?.paused ? 'bridge-resume' : 'bridge-pause' });
$('retry-media').onclick = () => { for (const peer of [...rtc.peers.values()]) { rtc.remove(peer.info.id); rtc.add(peer.info); } };
const timer = setInterval(() => { void rtc.stats(); if (current?.capturing && !$('camera-view').hidden) $('local-preview').src = '/api/preview?t=' + Date.now(); }, 1000);
window.addEventListener('pagehide', () => { clearInterval(timer); clearTimeout(reconnectTimer); rtc.clear(); monitor.dispose(); const old = bridge; bridge = null; old?.close(); });
window.hostDiagnostics = () => ({ ...current, localMedia: { video: false, audio: false }, rtc: [...rtc.peers.values()].map(p => ({ id: p.info.id, state: p.state, media: p.media })) });
window.hostMediaStats = () => rtc.lastStats || [];
connect();
