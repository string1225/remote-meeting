import '/host-accounts.js';
import { MeetingRelay } from '/relay.js';
import { LocalMedia, pageFullscreen, preview, remotePlayers } from '/media.js';
import { createAudioMonitor } from '/audio-meter.js';
import { createPlaybackControls } from '/playback-controls.js';
const $ = id => document.getElementById(id);
let bridge, current, reconnectTimer, config = {}, videoDesired = false, audioDesired = false, micWanted = true, videoRequest = 0, audioRequest = 0, mediaError = '', viewChosen = false;
function showView(camera) {
  $('camera-view').hidden = !camera; $('access-settings').hidden = camera;
  $('view-cameras').setAttribute('aria-pressed', String(camera)); $('view-settings').setAttribute('aria-pressed', String(!camera));
}
function send(message) { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message)); }
function error(message) { mediaError = String(message); $('error').textContent = mediaError; $('error').hidden = false; report(); }
const microphoneConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const monitor = createAudioMonitor({ container: $('host-audio'), onError: error, requestMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints, video: false }) });
const playback = createPlaybackControls({ button: $('play-audio'), container: $('remote-audio'), activate: monitor.activate, onError: error });
const media = new LocalMedia(async () => {
  preview($('local-video'), media.stream.getVideoTracks()[0]);
  monitor.setMicrophone(media.has('audio') ? new MediaStream(media.stream.getAudioTracks()) : null);
  if (media.has('video') && (!current?.peers.length || media.has('audio'))) mediaError = '';
  $('local-empty').hidden = media.has('video');
  $('host-microphone-toggle').textContent = media.has('audio') ? '关闭麦克风' : '开启麦克风';
  await rtc.sync(); report();
}, error);
const players = remotePlayers({ container: $('remote-media'), audioContainer: $('remote-audio'), playback, monitor, onChange: () => { $('remote-empty').hidden = players.size > 0; } });
const rtc = new MeetingRelay({ stream: media.stream, createSocket: () => new WebSocket('ws://' + location.host + '/media-bridge'), onError: e => error('音视频连接异常：' + e.message),
  onSource: (peer, state) => players.source(peer, state),
  onPeer: peer => { players.update(peer); renderParticipants(); }, onRemove: peer => { players.remove(peer); renderParticipants(); }
});
pageFullscreen($('local-stage'), $('local-fullscreen'));
function report() { send({ type: 'media-status', video: media.has('video'), audio: media.has('audio'), error: mediaError }); }
function renderParticipants() {
  $('participants').replaceChildren(...(current?.peers || []).map(info => {
    const peer = rtc.peers.get(info.id), row = document.createElement('p'); row.textContent = info.name + ' · ' + (peer?.link || ({ connected: '音视频已连接', connecting: '正在连接音视频', failed: '中转连接失败', disconnected: '正在重连' })[peer?.state] || '等待音视频');
    if (peer?.detail) { const detail = document.createElement('small'); detail.className = 'peer-link'; detail.textContent = peer.detail; row.append(detail); } return row;
  }));
}
async function openVideo(status, request) {
  try {
    let constraints;
    if (config.mediaTest) constraints = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } };
    else {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const device = devices.find(d => d.kind === 'videoinput' && d.label === status.virtualCamera.device) || devices.find(d => d.kind === 'videoinput' && d.label.startsWith('Remote Meeting Camera') && d.label.includes('Windows'));
      if (!device) throw new Error('未找到本机合成摄像头，请检查原生摄像头安装');
      constraints = { deviceId: { exact: device.deviceId }, width: { exact: status.output.width }, height: { exact: status.output.height }, frameRate: { ideal: status.output.fps, max: status.output.fps } };
    }
    if (request === videoRequest && videoDesired) await media.set('video', true, constraints);
  } catch (e) { if (request === videoRequest) error(e.message); }
}
async function openAudio(request) {
  const constraints = { ...microphoneConstraints };
  if (config.microphone && !config.mediaTest) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mic = devices.find(d => d.kind === 'audioinput' && d.label === config.microphone);
    if (mic) constraints.deviceId = { exact: mic.deviceId };
  }
  if (request === audioRequest && audioDesired) await media.set('audio', true, constraints);
}
function reconcile() {
  if (!current) return;
  const wantVideo = current.capturing, wantAudio = current.peers.length > 0 && micWanted;
  if (wantVideo !== videoDesired) { videoDesired = wantVideo; const request = ++videoRequest; if (wantVideo) void openVideo(current, request); else { mediaError = ''; void media.set('video', false); } }
  if (wantAudio !== audioDesired) { audioDesired = wantAudio; const request = ++audioRequest; if (wantAudio) void openAudio(request).catch(e => error(e.message)); else void media.set('audio', false); }
  $('host-microphone-toggle').disabled = current.peers.length === 0;
  $('local-empty').hidden = media.has('video');
  $('local-empty').textContent = current.capturing ? '正在连接合成画面…' : current.state === 'starting' ? '正在启动现场摄像头…' : '远端可启动现场摄像头';
}
function render(status) {
  const hadPeers = current?.peers.length || 0; current = status;
  $('connection').textContent = status.online ? '● 远端接入在线' : status.paused ? '远端接入已暂停' : '正在连接远端…';
  $('people-count').textContent = status.peers.length + ' / 2 位远端';
  $('capture-status').textContent = status.capturing ? '现场摄像头已开启' : status.state === 'starting' ? '正在切换摄像头…' : status.state === 'error' ? '摄像头启动失败' : '待机 · 原摄像头已释放';
  $('local-camera-toggle').textContent = status.state === 'starting' ? '取消启动 / 关闭' : status.capturing ? '关闭摄像头' : '启动摄像头';
  $('output-settings').textContent = `${status.output.width} × ${status.output.height} / ${status.output.fps} fps · USB 主画面 + 右下角画中画`;
  $('virtual-camera-status').textContent = status.capturing ? '现场画面通过网页发送，远端可控制缩放与位置。' : status.message || '摄像头已停止';
  $('capture-devices').textContent = status.cameras.map(c => c.label + ' · ' + c.width + ' × ' + c.height).join(' / ');
  $('error').hidden = !status.message && !mediaError; $('error').textContent = status.message || mediaError;
  $('pause').textContent = status.paused ? '恢复远端接入' : '暂停远端接入';
  if (!viewChosen && !hadPeers && status.peers.length) showView(true);
  reconcile(); renderParticipants();
}
function configure(message) {
  rtc.configure(message.self);
  for (const info of message.peers || []) rtc.add(info);
}
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/bridge'); bridge = ws;
  ws.onmessage = event => {
    if (bridge !== ws) return; const message = JSON.parse(event.data);
    if (message.type === 'host-status') render(message);
    else if (message.type === 'config') config = message.config;
    else if (message.type === 'media-config') configure(message);
    else if (message.type === 'peer-joined') rtc.add(message.peer);
    else if (message.type === 'peer-left') rtc.remove(message.id);
    else if (message.type === 'media-disconnected') rtc.clear();
  };
  ws.onclose = () => { if (bridge === ws) { rtc.clear(); reconnectTimer = setTimeout(connect, 1000); } }; ws.onerror = () => {};
}
$('view-cameras').onclick = () => { viewChosen = true; showView(true); }; $('view-settings').onclick = () => { viewChosen = true; showView(false); };
$('local-camera-toggle').onclick = () => send({ type: 'control', data: { type: current?.capturing || current?.state === 'starting' ? 'camera-stop' : 'camera-start' } });
$('pause').onclick = () => send({ type: current?.paused ? 'bridge-resume' : 'bridge-pause' });
$('retry-media').onclick = () => { mediaError = ''; videoDesired = false; reconcile(); };
$('host-microphone-toggle').onclick = () => { micWanted = !media.has('audio'); audioDesired = !micWanted; reconcile(); void monitor.activate(); };
const statsTimer = setInterval(() => void rtc.stats(), 3000);
window.addEventListener('pagehide', () => { clearInterval(statsTimer); clearTimeout(reconnectTimer); rtc.clear(); void media.stop(); monitor.dispose(); const old = bridge; bridge = null; old?.close(); });
window.hostDiagnostics = () => ({ ...current, localMedia: rtc.flags(), rtc: [...rtc.peers.values()].map(peer => ({ id: peer.info.id, state: peer.state, media: peer.media })) });
window.hostMediaStats = () => rtc.stats();
connect();
