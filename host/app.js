import { MeetingRTC } from '/rtc.js';
import { captureHost } from '/capture.js';
import { createCrop } from '/crop.js';
import '/host-accounts.js';
import { createAudioMonitor } from '/audio-meter.js';
import { createPlaybackControls } from '/playback-controls.js';

const $ = id => document.getElementById(id);
let bridge, config = {}, capture, capturing, idleTimer, paused = false, chain = Promise.resolve();
let hadPeers = false;
function showView(cameras) {
  $('camera-view').hidden = !cameras; $('access-settings').hidden = cameras;
  $('view-cameras').setAttribute('aria-pressed', String(cameras)); $('view-settings').setAttribute('aria-pressed', String(!cameras));
  document.body.classList.toggle('host-camera-view', cameras);
  window.scrollTo(0, 0);
}
$('view-cameras').onclick = () => showView(true);
$('view-settings').onclick = () => showView(false);
const send = message => { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message)); };
function error(message) { $('error').hidden = !message; $('error').textContent = message; }
const audioMonitor = createAudioMonitor({ container: $('host-audio'), onError: error, requestMicrophone: async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mic = config.microphone && devices.find(device => device.kind === 'audioinput' && device.label === config.microphone);
  if (config.microphone && !mic) throw new Error('配置的麦克风未连接');
  return navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(mic ? { deviceId: { exact: mic.deviceId } } : {}), echoCancellation: true, noiseSuppression: true } });
} });
const playback = createPlaybackControls({ button: $('play-audio'), container: $('remote-audio'), activate: audioMonitor.activate, onError: error,
  retryVideos: () => { for (const video of $('remote-media').querySelectorAll('video')) void video.play().catch(() => {}); } });
function state(value, message = '') {
  const cameras = capture?.sources.map(s => ({ label: s.label, width: s.settings.width, height: s.settings.height, frameRate: s.settings.frameRate })) || [];
  send({ type: 'host-state', state: value, cameras, message });
  $('capture-status').textContent = ({ idle: '待机 · 摄像头和麦克风已关闭', starting: '正在开启主机摄像头和麦克风…', capturing: '采集中 · 两路摄像头和麦克风已开启', error: '设备开启失败' })[value];
  $('sources-empty').hidden = !!capture;
  $('sources-empty').textContent = value === 'starting' ? '正在开启本机摄像头…' : value === 'error' ? '设备开启失败，请检查摄像头连接与权限' : '远端接入后自动开启本机摄像头';
  report();
}
async function ensureCapture() {
  clearTimeout(idleTimer);
  if (capture) return capture;
  if (capturing) return capturing;
  showView(true); state('starting'); error('');
  audioMonitor.stopPreview(); void audioMonitor.activate();
  capturing = captureHost(config).then(result => {
    capture = result;
    audioMonitor.setMicrophone(capture.audio);
    $('sources').replaceChildren(...capture.sources.map((s, i) => {
      const item = document.createElement('div'), label = document.createElement('p'); item.className = 'video-card'; label.className = 'caption';
      label.textContent = `摄像头 ${i + 1} · ${s.label} · ${s.settings.width} × ${s.settings.height} / ${Math.round(s.settings.frameRate)} fps`;
      item.append(s.video, label); return item;
    }));
    for (const stream of [...capture.sources.map(s => s.stream), capture.audio]) for (const track of stream.getTracks()) track.onended = () => {
      error('采集设备已断开，正在重新初始化。'); rtc.clear(); stopCapture(); send({ type: 'bridge-reconnect' });
    };
    state('capturing'); return capture;
  }).catch(e => { state('error', e.message); error(e.message); throw e; }).finally(() => { capturing = null; });
  return capturing;
}
function stopCapture() { clearTimeout(idleTimer); audioMonitor.setMicrophone(null); capture?.stop(); capture = null; $('sources').replaceChildren(); state('idle'); }
function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!rtc.peers.size) idleTimer = setTimeout(() => { if (!rtc.peers.size && !capturing) stopCapture(); }, config.idleMs ?? 3000);
}
function renderParticipants() {
  const hasPeers = rtc.peers.size > 0;
  if (hasPeers && !hadPeers) showView(true);
  hadPeers = hasPeers;
  $('people-count').textContent = `${rtc.peers.size} / 2 位远端`;
  renderRemoteEmpty();
  $('participants').replaceChildren(...[...rtc.peers.values()].map(p => {
    const row = document.createElement('p'); row.textContent = `${p.info.name} · ${p.link || p.pc.connectionState}${p.detail ? ' · ' + p.detail : ''}`; return row;
  }));
  report();
}
function renderRemoteEmpty() {
  $('remote-empty').hidden = $('remote-media').children.length > 0;
  $('remote-empty').textContent = rtc.peers.size ? '远端已接入 · 等待画面，对方也可能未开启摄像头' : '等待远端接入';
}
function report() {
  send({ type: 'local-status', capturing: !!capture, paused, cameras: capture?.sources.map(s => ({ label: s.label, ...s.settings, deviceId: undefined, groupId: undefined })) || [], peers: [...(rtc?.peers?.values() || [])].map(p => ({ name: p.info.name, state: p.pc.connectionState, views: p.media.filter(m => m.kind === 'video').map(m => ({ camera: m.camera, ...m.view, width: m.canvas.width, height: m.canvas.height })) })) });
}
const rtc = new MeetingRTC({
  send,
  async getMedia() { const source = await ensureCapture(); return [...source.sources.map((s, i) => createCrop(s, i)), { kind: 'audio', label: '现场麦克风', stream: source.audio }]; },
  onTrack(peer, stream) {
    const container = stream.getVideoTracks().length ? $('remote-media') : $('remote-audio');
    if ([...container.children].some(e => e.dataset.stream === stream.id)) return;
    const card = document.createElement('div'); card.dataset.owner = peer.info.id; card.dataset.stream = stream.id; card.className = 'video-card';
    const video = stream.getVideoTracks().length > 0;
    const player = document.createElement(video ? 'video' : 'audio'); player.autoplay = video; player.muted = video; player.playsInline = true; player.srcObject = stream;
    const title = document.createElement('div'); title.className = 'caption'; title.textContent = peer.info.name;
    if (stream.getVideoTracks().length) title.append(audioMonitor.peerMeter(peer.info.id));
    else audioMonitor.addRemote(peer.info.id, stream, player);
    card.append(player, title); container.append(card);
    if (video) player.play().catch(() => error('请点击声音按钮以启用播放。')); else playback.add(player);
    renderRemoteEmpty();
  },
  onPeer: renderParticipants,
  onRemove(peer) { audioMonitor.removeRemote(peer.info.id); for (const el of document.querySelectorAll('[data-owner]')) if (el.dataset.owner === peer.info.id) { const media = el.querySelector('video,audio'); if (media) media.srcObject = null; el.remove(); } playback.refresh(); renderParticipants(); scheduleIdle(); },
  onControl(peer, message) {
    if (message?.type !== 'viewport' || ![0, 1].includes(message.camera)) return;
    const crop = peer.media.find(m => m.camera === message.camera);
    if (!crop) return;
    const view = crop.setView(message);
    rtc.control(peer.info.id, { type: 'viewport-applied', ...view }); report();
  },
  onError(e) { error(e.message); }
});
async function handle(message) {
  if (message.type === 'config') { config = message.config; return; }
  if (message.type === 'cloud-status') { $('connection').textContent = message.online ? '● 云端信令在线' : paused ? '接入已暂停' : '正在重连云端…'; return; }
  if (message.type === 'joined') {
    rtc.configure(message.self, message.iceServers);
    for (const peer of message.peers) await rtc.add(peer, true);
    state(capture ? 'capturing' : 'idle'); renderParticipants();
  } else if (message.type === 'peer-joined') await rtc.add(message.peer);
  else if (message.type === 'peer-left') rtc.remove(message.id);
  else if (message.type === 'signal') rtc.signal(message.from, message.data);
  else if (message.type === 'error') error(message.message);
}
function connect() {
  bridge = new WebSocket(`ws://${location.host}/bridge`);
  bridge.onmessage = event => { chain = chain.then(() => handle(JSON.parse(event.data))).catch(e => { error(e.message); scheduleIdle(); }); };
  bridge.onclose = () => { rtc.clear(); stopCapture(); $('connection').textContent = '本机服务断开，正在恢复…'; setTimeout(connect, 1500); };
  bridge.onerror = () => {};
}
$('pause').onclick = async () => {
  paused = !paused;
  if (paused) { send({ type: 'bridge-pause' }); rtc.clear(); if (capturing) await capturing.catch(() => {}); stopCapture(); }
  else send({ type: 'bridge-resume' });
  $('pause').textContent = paused ? '恢复远端接入' : '暂停远端接入';
};
setInterval(() => { void rtc.stats(); report(); }, 3000);
window.hostDiagnostics = () => ({ capture, peers: rtc.peers });
connect();
window.addEventListener('pagehide', () => audioMonitor.dispose());
