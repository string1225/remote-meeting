import { initAccounts } from './accounts.js';
import { MeetingRTC } from './rtc.js';
import { cropControls } from './crop-controls.js';
import { createAudioMonitor } from './audio-meter.js';
import { createPlaybackControls } from './playback-controls.js';
const $ = id => document.getElementById(id), base = new URL('./', location.href);
let media = [], socket, ticket, active = false, joining = false, reconnectTimer, statsTimer, messageTimer, retry = 0, chain = Promise.resolve();
const controllers = new Map();
let hostCaptureState = 'offline', sharedView, cameraRequestTimer;
function notify(text, error = false) { clearTimeout(messageTimer); $('message').textContent = text; $('message').className = error ? 'error' : ''; $('message').hidden = false; messageTimer = setTimeout(() => { $('message').hidden = true; }, error ? 12000 : 5000); }
const audioMonitor = createAudioMonitor({ container: $('lobby-audio'), onError: message => notify(message, true),
  requestMicrophone: () => navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: $('microphone').value ? { exact: $('microphone').value } : undefined, echoCancellation: true, noiseSuppression: true } }) });
const playback = createPlaybackControls({ button: $('play-audio'), container: $('remote-audio'), activate: audioMonitor.activate, onError: message => notify(message, true),
  retryVideos: () => { for (const video of document.querySelectorAll('#meeting video')) if (video.srcObject) void video.play().catch(() => {}); } });
const mainStage = $('main-stage'), fullscreenButton = $('main-fullscreen');
function renderFullscreen() {
  const fullscreen = document.fullscreenElement === mainStage;
  fullscreenButton.textContent = fullscreen ? '退出全屏' : '全屏查看';
  fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
  fullscreenButton.disabled = !fullscreen && (!document.fullscreenEnabled || !$('host-videos').querySelector('.camera-panel:not([hidden])'));
  fullscreenButton.title = !document.fullscreenEnabled ? '当前浏览器不支持画面全屏' : fullscreen ? '退出全屏，也可按 Esc' : '全屏查看当前主摄像头';
}
fullscreenButton.onclick = async () => {
  try {
    if (document.fullscreenElement === mainStage) await document.exitFullscreen();
    else await mainStage.requestFullscreen();
  } catch { notify('无法进入全屏，请检查浏览器的全屏权限。', true); }
  renderFullscreen();
};
document.addEventListener('fullscreenchange', renderFullscreen);
renderFullscreen();
const accounts = initAccounts(notify);
function deviceError(e) { return ({ NotAllowedError: '请允许浏览器使用摄像头和麦克风。', NotFoundError: '未找到设备，请检查连接或选择旁听。', NotReadableError: '设备可能被其他程序占用，请关闭占用程序后重试。' })[e.name] || e.message; }
async function api(path, method = 'GET') { const res = await fetch(new URL(`api/${path}`, base), { method }); const data = await res.json(); if (!res.ok) throw new Error(data.error); return data; }
function setBusy(value) { joining = value; for (const e of $('setup-form').elements) e.disabled = value; }
function refreshMode() { const mode = $('mode').value; $('camera1-field').hidden = mode !== 'video'; $('mic-field').hidden = mode === 'listen'; $('devices-button').hidden = mode === 'listen'; }
async function detectDevices() {
  const sample = await navigator.mediaDevices.getUserMedia({ video: $('mode').value === 'video', audio: true }); sample.getTracks().forEach(t => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, kind] of [['camera1', 'videoinput'], ['microphone', 'audioinput']]) { const el = $(id), previous = el.value; el.replaceChildren(...devices.filter(d => d.kind === kind).map((d, i) => new Option(d.label || `设备 ${i + 1}`, d.deviceId))); if ([...el.options].some(o => o.value === previous)) el.value = previous; }
  $('device-fields').hidden = false; refreshMode();
}
function stopMedia() { audioMonitor.setMicrophone(null); for (const m of media) m.stream.getTracks().forEach(t => t.stop()); media = []; }
async function captureRemote() {
  stopMedia(); const mode = $('mode').value; if (mode === 'listen') return;
  if (!$('microphone').options.length) await detectDevices();
  try {
    if (mode === 'video') media.push({ kind: 'video', label: '摄像头', stream: await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: $('camera1').value }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } }, audio: false }) });
    media.push({ kind: 'audio', label: '麦克风', stream: await navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: $('microphone').value ? { exact: $('microphone').value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) });
    audioMonitor.setMicrophone(media.find(m => m.kind === 'audio').stream);
    for (const m of media) m.stream.getTracks().forEach(t => { t.onended = () => { if (active) notify(`${m.label}已断开，请重新连接。`, true); }; });
  } catch (e) { stopMedia(); throw e; }
}
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
const rtc = new MeetingRTC({ send, getMedia: async () => media, onTrack: addMedia, onPeer: renderParticipants,
  onRemove(peer) {
    audioMonitor.removeRemote(peer.info.id);
    for (const card of document.querySelectorAll('[data-owner]')) if (card.dataset.owner === peer.info.id) {
      const control = controllers.get(card.dataset.stream); if (control) { control.dispose(); controllers.delete(card.dataset.stream); }
      const player = card.matches('audio') ? card : card.querySelector('video'); if (player) player.srcObject = null; card.mediaStream = null; card.remove();
    }
    playback.refresh(); renderMainView(); renderParticipants();
  },
  onControlOpen: renderCameraButton,
  onControl(peer, m) {
    if (peer.info.role !== 'host') return;
    if (m?.type === 'camera-state') { hostCaptureState = m.state; renderCameraButton(); }
    else if (m?.type === 'virtual-camera-state') { $('system-camera-status').textContent = m.state === 'ready' ? '系统虚拟摄像头已输出 · OBS Virtual Camera' : m.state === 'error' ? `系统虚拟摄像头异常：${m.message}` : m.state === 'starting' ? '系统虚拟摄像头正在启动…' : ''; }
    else if (m?.type === 'viewport-applied' && m.camera === 0) { sharedView = m; for (const control of controllers.values()) control.applied(m); }
  },
  onError(e) { notify(e.message, true); }
});
function addMedia(peer, stream, metadata = {}) {
  const local = peer.info.id === 'local', host = peer.info.role === 'host';
  const container = stream.getVideoTracks().length ? (host ? $('host-videos') : $('remote-videos')) : $('remote-audio');
  if ([...container.children].some(e => e.dataset.stream === stream.id)) return;
  if (!stream.getVideoTracks().length) {
    const audio = document.createElement('audio'); audio.srcObject = stream; audio.dataset.owner = peer.info.id; audio.dataset.stream = stream.id;
    container.append(audio); audioMonitor.addRemote(peer.info.id, stream, audio); playback.add(audio); return;
  }
  const outer = document.createElement('article'); outer.className = host ? 'camera-panel' : 'remote-panel'; outer.dataset.owner = peer.info.id; outer.dataset.stream = stream.id;
  if (host) outer.mediaStream = stream;
  const card = document.createElement('div'); card.className = 'video-card';
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; if (!host) video.srcObject = stream;
  const caption = document.createElement('div'); caption.className = 'caption'; caption.textContent = host ? `现场摄像头 ${(metadata.camera ?? 0) + 1}` : `${peer.info.name}${local ? '（我）' : ''}`;
  caption.append(audioMonitor.peerMeter(peer.info.id));
  card.append(video, caption); outer.append(card); container.append(outer); if (!host) video.play().catch(() => notify('点击“播放远端声音”启用播放。'));
  if (host) {
    outer.dataset.camera = 0; caption.firstChild.textContent = '现场合成画面 · USB + 笔记本画中画';
    const c = cropControls(video, 0, sharedView, data => rtc.control(peer.info.id, data));
    controllers.set(stream.id, c); outer.append(c.element); card.append(c.overlay);
    c.setEnabled(hostCaptureState === 'capturing'); if (sharedView) c.applied(sharedView);
  }
  renderMainView();
}
function renderMainView() {
  const panels = [...$('host-videos').children];
  const selected = panels[0];
  for (const panel of panels) {
    panel.hidden = panel !== selected;
    const video = panel.querySelector('video'), stream = panel === selected ? panel.mediaStream : null;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      if (stream) video.play().catch(error => { if (error.name !== 'AbortError') notify('点击“播放远端声音”启用播放。'); });
    }
  }
  $('empty-state').hidden = !!selected;
  $('remote-empty').hidden = $('remote-videos').children.length > 0;
  renderFullscreen();
}
function renderCameraButton() {
  const host = [...rtc.peers.values()].find(p => p.info.role === 'host');
  const connected = host?.channel?.readyState === 'open', button = $('host-camera-toggle');
  button.disabled = !connected || hostCaptureState === 'starting';
  button.textContent = hostCaptureState === 'starting' ? '正在启动现场摄像头…' : hostCaptureState === 'capturing' ? '停止现场摄像头' : '启动现场摄像头';
  button.setAttribute('aria-pressed', String(hostCaptureState === 'capturing'));
  for (const control of controllers.values()) control.setEnabled(connected && hostCaptureState === 'capturing');
  clearTimeout(cameraRequestTimer);
}
$('host-camera-toggle').onclick = () => {
  const host = [...rtc.peers.values()].find(p => p.info.role === 'host');
  if (!host || !rtc.control(host.info.id, { type: hostCaptureState === 'capturing' ? 'camera-stop' : 'camera-start' })) { notify('主机控制通道尚未连接，请稍后重试。', true); renderCameraButton(); return; }
  $('host-camera-toggle').disabled = true;
  cameraRequestTimer = setTimeout(() => { renderCameraButton(); notify('暂未收到摄像头状态，请检查主机后重试。', true); }, 15000);
};
function renderParticipants() {
  $('people-count').textContent = `${1 + rtc.peers.size} / 3`;
  const names = { new: '等待连接', connecting: '正在连接', connected: '已连接', disconnected: '网络波动', failed: '直连失败：尝试热点或独立 TURN', closed: '已关闭' };
  $('participants').replaceChildren(...[...rtc.peers.values()].map(p => { const row = document.createElement('div'); row.className = 'participant'; const name = document.createElement('strong'); name.textContent = p.info.name; const status = document.createElement('small'); status.textContent = `${p.link || names[p.pc.connectionState]}${p.detail ? ' · ' + p.detail : ''}`; row.append(name, status, audioMonitor.peerMeter(p.info.id)); return row; }));
  renderCameraButton();
}
function hostStatus(data) {
  hostCaptureState = data.state;
  const labels = { offline: '主机离线 · 等待主机程序上线', idle: '主机在线 · 点击“启动现场摄像头”开启画面', starting: '主机正在开启两路摄像头…', capturing: '现场摄像头在线 · USB 主画面 + 笔记本画中画', error: `主机摄像头异常：${data.message || '请检查设备后重新启动'}` };
  $('host-status').textContent = labels[data.state] || '正在读取主机状态…';
  $('empty-state').textContent = data.state === 'offline' ? '主机已离线，等待重新连接…' : data.state === 'error' ? labels.error : '连接后点击“启动现场摄像头”';
  renderMainView();
  if (active) $('capture-info').textContent = data.cameras?.length ? `${data.output?.width || 1280} × ${data.output?.height || 720} / ${data.output?.fps || 15} fps · USB ${data.cameras[0].width} × ${data.cameras[0].height} · 画中画 ${data.cameras[1]?.width || 0} × ${data.cameras[1]?.height || 0}` : labels[data.state];
  renderCameraButton();
}
async function refreshStatus() { if (!accounts.current()) { $('host-status').textContent = '登录后查看主机状态'; return; } try { hostStatus(await api('host-status')); } catch {} }
function connect() {
  if (!active) return; const url = new URL('ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url); socket = ws;
  const timeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 12000); $('signal-status').textContent = '正在连接信令…';
  ws.onopen = () => { clearTimeout(timeout); send({ type: 'join', ticket }); };
  ws.onmessage = event => { chain = chain.then(async () => {
    if (socket !== ws || !active) return; const m = JSON.parse(event.data);
    if (m.type === 'joined') { rtc.configure(m.self, m.iceServers); retry = 0; $('signal-status').textContent = '● 信令在线 · 音视频独立直连'; hostStatus(m.hostState); for (const p of m.peers) await rtc.add(p, true); }
    else if (m.type === 'peer-joined') await rtc.add(m.peer);
    else if (m.type === 'peer-left') rtc.remove(m.id);
    else if (m.type === 'signal') rtc.signal(m.from, m.data);
    else if (m.type === 'host-state') hostStatus(m);
    else if (m.type === 'error' || m.type === 'ended') { leave(); notify(m.message, true); }
  }).catch(e => notify(e.message, true)); };
  ws.onerror = () => {};
  ws.onclose = () => { clearTimeout(timeout); if (socket !== ws || !active) return; $('signal-status').textContent = '信令断开，正在恢复…'; if (++retry > 5) { leave(); notify('连接无法恢复，请重新登录连接。', true); return; } reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** (retry - 1), 5000)); };
}
function leave() {
  if (document.fullscreenElement === mainStage) void document.exitFullscreen().catch(() => {});
  active = false; send({ type: 'leave' }); clearTimeout(reconnectTimer); clearInterval(statsTimer); const old = socket; socket = null; old?.close(); rtc.clear(); stopMedia(); ticket = null;
  audioMonitor.reset(); $('lobby-audio').append(audioMonitor.element);
  for (const c of controllers.values()) c.dispose(); controllers.clear(); $('host-videos').replaceChildren(); $('remote-videos').replaceChildren(); $('remote-audio').replaceChildren(); sharedView = undefined; clearTimeout(cameraRequestTimer); document.body.classList.remove('meeting-active'); $('meeting').hidden = true; $('lobby').hidden = false; void refreshStatus();
  playback.reset(); renderFullscreen();
}
$('setup-form').onsubmit = async e => {
  e.preventDefault(); if (joining) return; setBusy(true);
  void audioMonitor.activate(); audioMonitor.stopPreview();
  try {
    await accounts.ensureLoggedIn(); const status = await api('host-status'); hostStatus(status); if (!status.online) throw new Error('主机尚未上线，请先启动当前电脑上的常驻程序');
    await captureRemote(); ticket = (await api('connect', 'POST')).ticket;
    active = true; retry = 0; $('lobby').hidden = true; $('meeting').hidden = false; document.body.classList.add('meeting-active'); $('message').hidden = true; $('empty-state').hidden = false;
    $('meeting-audio').append(audioMonitor.element);
    for (const m of media.filter(m => m.kind === 'video')) addMedia({ info: { id: 'local', role: 'remote', name: accounts.current().displayName } }, m.stream);
    $('mute').disabled = !media.some(m => m.kind === 'audio'); $('camera-toggle').disabled = !media.some(m => m.kind === 'video'); $('mute').textContent = '关闭麦克风'; $('camera-toggle').textContent = '关闭摄像头'; connect(); statsTimer = setInterval(() => void rtc.stats(), 3000);
  } catch (error) { stopMedia(); notify(deviceError(error), true); } finally { setBusy(false); }
};
$('devices-button').onclick = async () => { setBusy(true); try { await detectDevices(); notify('设备已就绪。'); } catch (e) { notify(deviceError(e), true); } finally { setBusy(false); } };
$('mode').onchange = refreshMode; $('leave').onclick = leave;
for (const [id, kind, label] of [['mute', 'audio', '麦克风'], ['camera-toggle', 'video', '摄像头']]) $(id).onclick = () => { const tracks = media.flatMap(m => m.stream.getTracks()).filter(t => t.kind === kind); const enabled = !tracks.some(t => t.enabled); tracks.forEach(t => { t.enabled = enabled; }); $(id).textContent = `${enabled ? '关闭' : '开启'}${label}`; };
document.addEventListener('account-change', refreshStatus); window.addEventListener('pagehide', leave); setInterval(() => { if (!active) void refreshStatus(); }, 10000); refreshMode();
window.addEventListener('pagehide', () => audioMonitor.dispose());
