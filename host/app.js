import { MeetingRTC } from '/rtc.js';
import { captureHost } from '/capture.js';
import { createCrop } from '/crop.js';
import '/host-accounts.js';

const $ = id => document.getElementById(id);
let bridge, config = {}, capture, capturing, idleTimer, paused = false, chain = Promise.resolve();
const send = message => { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(message)); };
function error(message) { $('error').hidden = !message; $('error').textContent = message; }
function state(value, message = '') {
  const cameras = capture?.sources.map(s => ({ label: s.label, width: s.settings.width, height: s.settings.height, frameRate: s.settings.frameRate })) || [];
  send({ type: 'host-state', state: value, cameras, message });
  $('capture-status').textContent = ({ idle: '待机 · 摄像头和麦克风已关闭', starting: '正在开启主机摄像头和麦克风…', capturing: '采集中 · 两路摄像头和麦克风已开启', error: '设备开启失败' })[value];
  report();
}
async function ensureCapture() {
  clearTimeout(idleTimer);
  if (capture) return capture;
  if (capturing) return capturing;
  state('starting'); error('');
  capturing = captureHost(config).then(result => {
    capture = result;
    $('sources').replaceChildren(...capture.sources.map((s, i) => {
      const item = document.createElement('div'), label = document.createElement('p');
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
function stopCapture() { clearTimeout(idleTimer); capture?.stop(); capture = null; $('sources').replaceChildren(); state('idle'); }
function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!rtc.peers.size) idleTimer = setTimeout(() => { if (!rtc.peers.size && !capturing) stopCapture(); }, config.idleMs ?? 3000);
}
function renderParticipants() {
  $('people-count').textContent = `${rtc.peers.size} / 2 位远端`;
  $('participants').replaceChildren(...[...rtc.peers.values()].map(p => {
    const row = document.createElement('p'); row.textContent = `${p.info.name} · ${p.link || p.pc.connectionState}${p.detail ? ' · ' + p.detail : ''}`; return row;
  }));
  report();
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
    const player = document.createElement(stream.getVideoTracks().length ? 'video' : 'audio'); player.autoplay = true; player.playsInline = true; player.srcObject = stream;
    const title = document.createElement('div'); title.className = 'caption'; title.textContent = peer.info.name;
    card.append(player, title); container.append(card); player.play().catch(() => error('请点击“播放远端声音”以启用声音。'));
  },
  onPeer: renderParticipants,
  onRemove(peer) { for (const el of document.querySelectorAll('[data-owner]')) if (el.dataset.owner === peer.info.id) { const media = el.querySelector('video,audio'); if (media) media.srcObject = null; el.remove(); } renderParticipants(); scheduleIdle(); },
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
$('play-audio').onclick = () => { for (const player of document.querySelectorAll('#remote-media video,#remote-audio audio')) player.play().catch(e => error(e.message)); };
setInterval(() => { void rtc.stats(); report(); }, 3000);
window.hostDiagnostics = () => ({ capture, peers: rtc.peers });
connect();
