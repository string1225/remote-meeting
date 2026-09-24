import { initAccounts } from './accounts.js';
import { MeetingRTC } from './rtc.js';
import { cropControls } from './crop-controls.js';
const $ = id => document.getElementById(id), base = new URL('./', location.href);
let media = [], socket, ticket, active = false, joining = false, reconnectTimer, statsTimer, messageTimer, retry = 0, chain = Promise.resolve();
const controllers = new Map(), views = new Map();
function notify(text, error = false) { clearTimeout(messageTimer); $('message').textContent = text; $('message').className = error ? 'error' : ''; $('message').hidden = false; messageTimer = setTimeout(() => { $('message').hidden = true; }, error ? 12000 : 5000); }
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
function stopMedia() { for (const m of media) m.stream.getTracks().forEach(t => t.stop()); media = []; }
async function captureRemote() {
  stopMedia(); const mode = $('mode').value; if (mode === 'listen') return;
  if (!$('microphone').options.length) await detectDevices();
  try {
    if (mode === 'video') media.push({ kind: 'video', label: '摄像头', stream: await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: $('camera1').value }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } }, audio: false }) });
    media.push({ kind: 'audio', label: '麦克风', stream: await navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: $('microphone').value ? { exact: $('microphone').value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) });
    for (const m of media) m.stream.getTracks().forEach(t => { t.onended = () => { if (active) notify(`${m.label}已断开，请重新连接。`, true); }; });
  } catch (e) { stopMedia(); throw e; }
}
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
const rtc = new MeetingRTC({ send, getMedia: async () => media, onTrack: addMedia, onPeer: renderParticipants,
  onRemove(peer) {
    for (const card of document.querySelectorAll('[data-owner]')) if (card.dataset.owner === peer.info.id) {
      const control = controllers.get(card.dataset.stream); if (control) { views.set(Number(card.dataset.camera), control.view); control.dispose(); controllers.delete(card.dataset.stream); }
      const player = card.matches('audio') ? card : card.querySelector('video'); if (player) player.srcObject = null; card.remove();
    }
    renderParticipants();
  },
  onControlOpen() { for (const c of controllers.values()) c.resend(); },
  onControl(peer, m) { if (peer.info.role !== 'host' || m?.type !== 'viewport-applied') return; for (const [id, control] of controllers) { const card = [...$('host-videos').children].find(c => c.dataset.stream === id); if (Number(card?.dataset.camera) === m.camera) control.applied(m); } },
  onError(e) { notify(e.message, true); }
});
function addMedia(peer, stream, metadata = {}) {
  const local = peer.info.id === 'local', host = peer.info.role === 'host';
  const container = stream.getVideoTracks().length ? (host ? $('host-videos') : $('remote-videos')) : $('remote-audio');
  if ([...container.children].some(e => e.dataset.stream === stream.id)) return;
  if (!stream.getVideoTracks().length) { const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = stream; audio.dataset.owner = peer.info.id; audio.dataset.stream = stream.id; container.append(audio); audio.play().catch(() => notify('点击“播放远端声音”启用声音。')); return; }
  const outer = document.createElement('article'); outer.className = host ? 'camera-panel' : 'remote-panel'; outer.dataset.owner = peer.info.id; outer.dataset.stream = stream.id;
  const card = document.createElement('div'); card.className = 'video-card';
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = local; video.srcObject = stream;
  const caption = document.createElement('div'); caption.className = 'caption'; caption.textContent = host ? `现场摄像头 ${(metadata.camera ?? 0) + 1}` : `${peer.info.name}${local ? '（我）' : ''}`;
  card.append(video, caption); outer.append(card); container.append(outer); video.play().catch(() => notify('点击“播放远端声音”启用播放。'));
  if (host && [0, 1].includes(metadata.camera)) {
    outer.dataset.camera = metadata.camera;
    const c = cropControls(video, metadata.camera, views.get(metadata.camera), data => { views.set(metadata.camera, { zoom: data.zoom, x: data.x, y: data.y }); return rtc.control(peer.info.id, data); }); controllers.set(stream.id, c); outer.append(c.element); c.resend();
  }
  $('empty-state').hidden = $('host-videos').children.length > 0;
}
function renderParticipants() {
  $('people-count').textContent = `${1 + rtc.peers.size} / 3`;
  const names = { new: '等待连接', connecting: '正在连接', connected: '已连接', disconnected: '网络波动', failed: '直连失败：尝试热点或独立 TURN', closed: '已关闭' };
  $('participants').replaceChildren(...[...rtc.peers.values()].map(p => { const row = document.createElement('div'); row.className = 'participant'; const name = document.createElement('strong'); name.textContent = p.info.name; const status = document.createElement('small'); status.textContent = `${p.link || names[p.pc.connectionState]}${p.detail ? ' · ' + p.detail : ''}`; row.append(name, status); return row; }));
}
function hostStatus(data) {
  const labels = { offline: '主机离线 · 等待主机程序上线', idle: '主机在线 · 连接后自动开启设备', starting: '主机正在开启摄像头和麦克风…', capturing: '主机采集中 · 两路摄像头与麦克风在线', error: `主机设备异常：${data.message || '请检查设备'}` };
  $('host-status').textContent = labels[data.state] || '正在读取主机状态…';
  if (active) $('capture-info').textContent = data.cameras?.length ? data.cameras.map((c, i) => `摄像头 ${i + 1}：${c.width} × ${c.height}`).join(' · ') : labels[data.state];
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
  active = false; send({ type: 'leave' }); clearTimeout(reconnectTimer); clearInterval(statsTimer); const old = socket; socket = null; old?.close(); rtc.clear(); stopMedia(); ticket = null;
  for (const c of controllers.values()) c.dispose(); controllers.clear(); $('host-videos').replaceChildren(); $('remote-videos').replaceChildren(); $('remote-audio').replaceChildren(); $('meeting').hidden = true; $('lobby').hidden = false; void refreshStatus();
}
$('setup-form').onsubmit = async e => {
  e.preventDefault(); if (joining) return; setBusy(true);
  try {
    await accounts.ensureLoggedIn(); const status = await api('host-status'); hostStatus(status); if (!status.online) throw new Error('主机尚未上线，请先启动当前电脑上的常驻程序');
    await captureRemote(); ticket = (await api('connect', 'POST')).ticket;
    active = true; retry = 0; $('lobby').hidden = true; $('meeting').hidden = false; $('message').hidden = true; $('empty-state').hidden = false;
    for (const m of media.filter(m => m.kind === 'video')) addMedia({ info: { id: 'local', role: 'remote', name: accounts.current().displayName } }, m.stream);
    $('mute').disabled = !media.some(m => m.kind === 'audio'); $('camera-toggle').disabled = !media.some(m => m.kind === 'video'); $('mute').textContent = '关闭麦克风'; $('camera-toggle').textContent = '关闭摄像头'; connect(); statsTimer = setInterval(() => void rtc.stats(), 3000);
  } catch (error) { stopMedia(); notify(deviceError(error), true); } finally { setBusy(false); }
};
$('devices-button').onclick = async () => { setBusy(true); try { await detectDevices(); notify('设备已就绪。'); } catch (e) { notify(deviceError(e), true); } finally { setBusy(false); } };
$('mode').onchange = refreshMode; $('leave').onclick = leave;
for (const [id, kind, label] of [['mute', 'audio', '麦克风'], ['camera-toggle', 'video', '摄像头']]) $(id).onclick = () => { const tracks = media.flatMap(m => m.stream.getTracks()).filter(t => t.kind === kind); const enabled = !tracks.some(t => t.enabled); tracks.forEach(t => { t.enabled = enabled; }); $(id).textContent = `${enabled ? '关闭' : '开启'}${label}`; };
$('play-audio').onclick = () => { for (const p of document.querySelectorAll('#meeting video,#meeting audio')) p.play().catch(() => {}); };
document.addEventListener('account-change', refreshStatus); window.addEventListener('pagehide', leave); setInterval(() => { if (!active) void refreshStatus(); }, 10000); refreshMode();
