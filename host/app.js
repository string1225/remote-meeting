import { MeetingRTC } from '/rtc.js';
import { captureHost, captureMicrophone } from '/capture.js';
import { createComposite, compositeSettings } from '/composite.js';
import { createVirtualOutput } from '/virtual-output.js';
import '/host-accounts.js';
import { createAudioMonitor } from '/audio-meter.js';
import { createPlaybackControls } from '/playback-controls.js';

const $ = id => document.getElementById(id);
let bridge, config = {}, capture = null, capturing, session = null, creatingSession, acquiringAudio, idleTimer, paused = false, chain = Promise.resolve();
let captureState = 'idle', captureMessage = '', captureGeneration = 0, sessionGeneration = 0;
let cameraRequested = false, virtualState = { type: 'virtual-camera-state', state: 'stopped' };
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
  captureState = value; captureMessage = message;
  const cameras = capture?.sources.map(s => ({ label: s.label, width: s.settings.width, height: s.settings.height, frameRate: s.settings.frameRate })) || [];
  send({ type: 'host-state', state: value, cameras, output: session?.composite.settings || compositeSettings(config.output), message });
  $('capture-status').textContent = ({ idle: session?.audio ? '摄像头已停止 · 麦克风在线' : '待机 · 设备已关闭', starting: '正在开启两路摄像头…', capturing: '采集中 · USB 主画面 + 笔记本画中画', error: '摄像头开启失败' })[value];
  $('local-camera-toggle').textContent = value === 'starting' ? '取消启动' : capture ? '停止摄像头' : '启动摄像头';
  $('local-camera-toggle').disabled = paused;
  $('sources-empty').hidden = !!session;
  $('sources-empty').textContent = '远端连接后点击“启动现场摄像头”';
  broadcastControl({ type: 'camera-state', state: value, message });
  report();
}
function broadcastControl(message) { for (const peer of rtc.peers.values()) rtc.control(peer.info.id, message); }
function virtualStatus(message) {
  virtualState = message;
  $('virtual-camera-status').textContent = message.state === 'ready' ? '系统摄像头：OBS Virtual Camera · 已输出' : message.state === 'error' ? `系统摄像头输出失败：${message.message}` : message.state === 'starting' ? '系统虚拟摄像头正在启动…' : message.state === 'disabled' ? '系统虚拟摄像头输出已禁用' : '系统虚拟摄像头已停止';
  broadcastControl(message);
}
async function ensureSession(withAudio = true) {
  clearTimeout(idleTimer);
  if (!session && !creatingSession) creatingSession = Promise.resolve().then(() => {
    const composite = createComposite(config.output);
    session = { composite, audio: null };
    const item = document.createElement('div'), label = document.createElement('p'); item.className = 'video-card'; label.className = 'caption';
    label.textContent = `共享合成画面 · ${composite.settings.width} × ${composite.settings.height} / ${composite.settings.fps} fps`;
    item.append(composite.canvas, label); $('sources').replaceChildren(item);
    state(captureState, captureMessage); return session;
  }).finally(() => { creatingSession = null; scheduleIdle(); });
  const owner = session || await creatingSession;
  if (withAudio && !owner.audio) {
    if (!acquiringAudio || acquiringAudio.owner !== owner) {
      const generation = sessionGeneration;
      audioMonitor.stopPreview(); void audioMonitor.activate();
      const request = { owner }; acquiringAudio = request;
      request.promise = captureMicrophone(config).then(audio => {
        if (generation !== sessionGeneration || owner !== session || paused) { audio.getTracks().forEach(t => t.stop()); throw new Error('接入已结束'); }
        owner.audio = audio; audioMonitor.setMicrophone(audio);
        audio.getTracks().forEach(track => { track.onended = () => { error('麦克风已断开，请检查设备。'); rtc.clear(); stopSession(); send({ type: 'bridge-reconnect' }); }; });
        return audio;
      }).finally(() => { if (acquiringAudio === request) acquiringAudio = null; scheduleIdle(); });
    }
    await acquiringAudio.promise;
  }
  return owner;
}
async function ensureCapture() {
  clearTimeout(idleTimer);
  if (capture) return capture;
  if (capturing) {
    if (cameraRequested) return capturing;
    const generation = captureGeneration; cameraRequested = true; state('starting');
    return capturing.then(() => { if (generation === captureGeneration && cameraRequested) return ensureCapture(); });
  }
  const generation = captureGeneration;
  if (paused) return;
  cameraRequested = true;
  showView(true); state('starting'); error('');
  capturing = (async () => {
    const owner = await ensureSession(false);
    const result = await captureHost({ ...config, output: owner.composite.settings });
    if (generation !== captureGeneration || owner !== session || paused || !cameraRequested) { result.stop(); return; }
    capture = result;
    owner.composite.setSources(capture.sources);
    for (const s of capture.sources) for (const track of s.stream.getTracks()) track.onended = () => {
      stopCapture(); error('摄像头已断开，请检查连接后重新启动。'); state('error', '摄像头已断开');
    };
    owner.virtualOutput = createVirtualOutput(owner.composite, config.virtualCamera, virtualStatus);
    broadcastControl({ type: 'viewport-applied', ...owner.composite.snapshot(), shared: true });
    state('capturing'); return capture;
  })().catch(e => { if (generation === captureGeneration) { cameraRequested = false; state('error', e.message); error(e.message); } }).finally(() => { capturing = null; scheduleIdle(); });
  return capturing;
}
function stopCapture(release = true) { cameraRequested = false; captureGeneration++; session?.virtualOutput?.dispose(); if (session) session.virtualOutput = null; virtualStatus({ type: 'virtual-camera-state', state: 'stopped' }); capture?.stop(); capture = null; session?.composite.setSources(); state('idle'); if (release) scheduleIdle(); }
function stopSession() {
  clearTimeout(idleTimer); sessionGeneration++; stopCapture(false); audioMonitor.setMicrophone(null);
  session?.audio?.getTracks().forEach(t => t.stop()); session?.composite.dispose(); session = null;
  $('sources').replaceChildren(); state('idle');
}
function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!rtc.peers.size && !rtc.pending.size) idleTimer = setTimeout(() => {
    if (rtc.peers.size || rtc.pending.size) return;
    if (cameraRequested) { audioMonitor.setMicrophone(null); session?.audio?.getTracks().forEach(t => t.stop()); if (session) session.audio = null; state(captureState, captureMessage); }
    else stopSession();
  }, config.idleMs ?? 3000);
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
  send({ type: 'local-status', capturing: !!capture, microphone: !!session?.audio, paused, output: session?.composite.settings, cameras: capture?.sources.map(s => ({ label: s.label, ...s.settings, deviceId: undefined, groupId: undefined })) || [], peers: [...rtc.peers.values()].map(p => ({ name: p.info.name, state: p.pc.connectionState, views: session ? [{ camera: 0, ...session.composite.view, ...session.composite.settings }] : [] })) });
}
const rtc = new MeetingRTC({
  send,
  async getMedia() {
    const source = await ensureSession();
    // Shared tracks belong to the session; disconnecting one peer must not stop them.
    return [{ kind: 'video', camera: 0, label: source.composite.label, stream: source.composite.stream }, { kind: 'audio', label: '现场麦克风', stream: source.audio }];
  },
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
  onControlOpen(peer) {
    rtc.control(peer.info.id, { type: 'camera-state', state: captureState, message: captureMessage });
    rtc.control(peer.info.id, virtualState);
    if (session) rtc.control(peer.info.id, { type: 'viewport-applied', ...session.composite.snapshot(), shared: true });
  },
  onControl(peer, message) {
    if (message?.type === 'camera-start' || message?.type === 'camera-stop') {
      if (paused || rtc.peers.get(peer.info.id) !== peer) return;
      if (message.type === 'camera-start') void ensureCapture().then(() => state(captureState, captureMessage));
      else stopCapture();
      return;
    }
    if (message?.type !== 'viewport' || message.camera !== 0 || !capture || !session) return;
    const view = session.composite.setView(message);
    broadcastControl({ type: 'viewport-applied', ...view, shared: true }); report();
  },
  onError(e) { error(e.message); }
});
async function handle(message) {
  if (message.type === 'config') { config = message.config; return; }
  if (message.type === 'cloud-status') { $('connection').textContent = message.online ? '● 云端信令在线' : paused ? '接入已暂停' : '正在重连云端…'; return; }
  if (message.type === 'joined') {
    rtc.configure(message.self, message.iceServers);
    for (const peer of message.peers) await rtc.add(peer, true);
    state(captureState, captureMessage); renderParticipants();
  } else if (message.type === 'peer-joined') await rtc.add(message.peer);
  else if (message.type === 'peer-left') rtc.remove(message.id);
  else if (message.type === 'signal') rtc.signal(message.from, message.data);
  else if (message.type === 'error') error(message.message);
}
function connect() {
  bridge = new WebSocket(`ws://${location.host}/bridge`);
  bridge.onmessage = event => { chain = chain.then(() => handle(JSON.parse(event.data))).catch(e => { error(e.message); scheduleIdle(); }); };
  bridge.onclose = () => { rtc.clear(); stopSession(); $('connection').textContent = '本机服务断开，正在恢复…'; setTimeout(connect, 1500); };
  bridge.onerror = () => {};
}
$('pause').onclick = async () => {
  paused = !paused;
  if (paused) { send({ type: 'bridge-pause' }); rtc.clear(); stopSession(); }
  else send({ type: 'bridge-resume' });
  $('pause').textContent = paused ? '恢复远端接入' : '暂停远端接入';
};
$('local-camera-toggle').onclick = () => { if (cameraRequested || capture) stopCapture(); else void ensureCapture(); };
setInterval(() => { void rtc.stats(); report(); }, 3000);
window.hostDiagnostics = () => ({ capture, session, peers: rtc.peers });
connect();
window.addEventListener('pagehide', () => audioMonitor.dispose());
