import { initAccounts } from './accounts.js';

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let invitation = fragment.has('room') && fragment.has('token') ? { room: fragment.get('room'), token: fragment.get('token') } : null;
let hostRole = !invitation || fragment.get('role') === 'host';
let media = [], socket, self, iceServers = [], active = false, joining = false, reconnectTimer, statsTimer, messageTimer;
let reconnectAttempt = 0, guestToken;
const peers = new Map();
const base = new URL('./', location.href);
const accounts = initAccounts(notify);

function notify(text, error = false, persistent = false) {
  clearTimeout(messageTimer);
  $('message').textContent = text;
  $('message').className = error ? 'error' : '';
  $('message').hidden = false;
  if (!persistent) messageTimer = setTimeout(() => { $('message').hidden = true; }, error ? 12000 : 5000);
}
function errorText(error) {
  return ({ NotAllowedError: '请允许浏览器使用摄像头和麦克风，并检查 Windows 设备权限。', NotFoundError: '未找到所选设备，请检查摄像头 / 麦克风连接。', NotReadableError: '设备可能正在被其他程序占用，请关闭占用它的程序后重试。', OverconstrainedError: '所选设备不可用或不支持当前画质，请重新检测设备。' })[error.name] || error.message || String(error);
}
function setupRole() {
  $('admin-field').hidden = !!invitation;
  $('guest-hint').hidden = hostRole;
  $('name').value = hostRole ? '现场主持人' : '远端访客';
  $('setup-title').textContent = invitation ? '准备加入会议' : '开始一场会议';
  $('join-button').textContent = invitation ? '加入会议 ↗' : '创建并进入会议 ↗';
  $('mode').querySelector('[value="host"]').hidden = !hostRole;
  $('mode').value = hostRole ? 'host' : 'video';
  refreshMode();
}
function refreshMode() {
  const mode = $('mode').value;
  $('camera1-field').hidden = !['host', 'video'].includes(mode);
  $('camera2-field').hidden = mode !== 'host';
  $('quality-field').hidden = !['host', 'video'].includes(mode);
  $('mic-field').hidden = mode === 'listen';
  $('devices-button').hidden = mode === 'listen';
  $('preview').replaceChildren();
}
function stopMedia() { for (const item of media) item.stream.getTracks().forEach(t => t.stop()); media = []; }
async function detectDevices() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('摄像头和麦克风需要 HTTPS 安全连接（本机 localhost 除外）。');
  const mode = $('mode').value;
  const stream = await navigator.mediaDevices.getUserMedia({ video: ['host', 'video'].includes(mode), audio: true });
  stream.getTracks().forEach(track => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, kind] of [['camera1', 'videoinput'], ['camera2', 'videoinput'], ['microphone', 'audioinput']]) {
    const select = $(id), previous = select.value;
    select.replaceChildren();
    devices.filter(d => d.kind === kind).forEach((device, index) => {
      select.add(new Option(device.label || `${kind === 'videoinput' ? '摄像头' : '麦克风'} ${index + 1}`, device.deviceId));
    });
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    else if (id === 'camera2' && select.options.length > 1) select.selectedIndex = 1;
  }
  $('device-fields').hidden = false;
  refreshMode();
  if (mode === 'host' && $('camera1').options.length < 2) notify('只检测到一个摄像头。现场双摄模式需要两个独立设备，也可以切换为单摄模式。', true);
  else notify('设备已就绪。选择设备后进入会议。');
}
async function captureMedia() {
  stopMedia();
  const mode = $('mode').value;
  if (mode === 'listen') return;
  if (!$('microphone').options.length) await detectDevices();
  if (mode === 'host' && (!$('camera2').value || $('camera1').value === $('camera2').value)) throw new Error('请选择两个不同的摄像头，或切换为单摄模式。');
  const height = Number($('quality').value);
  try {
    if (mode === 'host' || mode === 'video') {
      for (const id of (mode === 'host' ? ['camera1', 'camera2'] : ['camera1'])) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: $(id).value }, height: { ideal: height }, width: { ideal: Math.round(height * 16 / 9) }, frameRate: { ideal: height === 360 ? 20 : 24, max: 30 } }, audio: false });
        media.push({ stream, label: id === 'camera1' ? '摄像头 1' : '摄像头 2', kind: 'video' });
      }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: $('microphone').value ? { exact: $('microphone').value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    media.push({ stream, label: '麦克风', kind: 'audio' });
    for (const item of media) item.stream.getTracks().forEach(track => { track.onended = () => { if (active) notify(`${item.label}已断开。请重新连接设备并重新入会。`, true, true); }; });
  } catch (error) { stopMedia(); throw error; }
}
function roomLink(token, role) {
  const link = new URL(base);
  link.hash = new URLSearchParams({ room: invitation.room, token, ...(role ? { role } : {}) });
  return link.href;
}
function setBusy(busy) {
  joining = busy;
  for (const element of $('setup-form').elements) element.disabled = busy;
}
$('devices-button').onclick = async () => {
  setBusy(true);
  try { await detectDevices(); } catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
};
$('mode').onchange = refreshMode;
$('setup-form').onsubmit = async event => {
  event.preventDefault();
  if (joining) return;
  setBusy(true);
  try {
    if (!invitation) await accounts.ensureLoggedIn();
    await captureMedia();
    if (!invitation) {
      const response = await fetch(new URL('api/rooms', base), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '创建会议失败');
      invitation = { room: data.room, token: data.hostToken };
      guestToken = data.guestToken;
      $('admin-key').value = '';
      history.replaceState(null, '', roomLink(data.hostToken, 'host'));
    }
    active = true;
    $('lobby').hidden = true;
    $('meeting').hidden = false;
    $('message').hidden = true;
    $('video-grid').replaceChildren();
    for (const item of media.filter(m => m.kind === 'video')) addMediaCard('local', item.stream, `我 · ${item.label}`, true);
    $('mute').disabled = !media.some(m => m.kind === 'audio');
    $('camera-toggle').disabled = !media.some(m => m.kind === 'video');
    $('mute').textContent = '关闭麦克风';
    $('camera-toggle').textContent = '关闭摄像头';
    $('invite').hidden = !hostRole;
    $('end-room').hidden = !hostRole;
    updateParticipants();
    connect();
    statsTimer = setInterval(updateStats, 3000);
  } catch (error) { stopMedia(); notify(errorText(error), true); }
  finally { setBusy(false); }
};
function addMediaCard(owner, stream, label, local = false) {
  const id = `${owner}:${stream.id}`;
  if ([...$('video-grid').children].some(e => e.dataset.stream === id)) return;
  if (stream.getVideoTracks().length) {
    const card = document.createElement('div');
    card.className = 'video-card'; card.dataset.owner = owner; card.dataset.stream = id;
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = local; video.srcObject = stream;
    const caption = document.createElement('div'); caption.className = 'caption'; caption.textContent = label;
    card.append(video, caption);
    if (local) { const tag = document.createElement('span'); tag.className = 'local-label'; tag.textContent = '本机画面'; card.append(tag); }
    $('video-grid').append(card);
    video.play().catch(() => { if (!local) notify('点击“播放远端声音”以启用播放。'); });
  } else {
    const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = stream; audio.dataset.owner = owner; audio.dataset.stream = id;
    $('video-grid').append(audio);
    audio.play().catch(() => notify('浏览器暂停了自动播放，请点击“播放远端声音”。'));
  }
  updateParticipants();
}
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function signal(id, data) { send({ type: 'signal', to: id, data }); }
function connect() {
  if (!active) return;
  const url = new URL('ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url); socket = ws;
  $('signal-status').textContent = reconnectAttempt ? '信令断开，正在重连…' : '正在连接信令…';
  const timeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 12000);
  ws.onopen = () => { clearTimeout(timeout); send({ type: 'join', ...invitation, name: $('name').value.trim() }); };
  ws.onmessage = async event => {
    if (socket !== ws || !active) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'joined') {
        for (const id of [...peers.keys()]) removePeer(id);
        self = message.self; hostRole = self.role === 'host'; iceServers = message.iceServers;
        guestToken = message.guestToken || guestToken;
        reconnectAttempt = 0;
        $('signal-status').textContent = '● 信令在线 · 音视频独立传输';
        $('expiry').textContent = `会议有效至 ${new Date(message.expiresAt).toLocaleString()}`;
        for (const info of message.peers) createPeer(info, true);
        updateParticipants();
      } else if (message.type === 'peer-joined') createPeer(message.peer);
      else if (message.type === 'peer-left') removePeer(message.id);
      else if (message.type === 'signal') {
        const peer = peers.get(message.from);
        if (peer) peer.queue = peer.queue.then(() => receiveSignal(peer, message.data)).catch(error => notify(`连接 ${peer.info.name} 失败：${error.message}`, true));
      } else if (message.type === 'error') { leave(); notify(message.message, true, true); }
      else if (message.type === 'room-ended') { leave(); invitation = null; guestToken = null; history.replaceState(null, '', base); hostRole = true; setupRole(); notify('会议已结束或已过期。'); }
    } catch (error) { notify(`连接消息处理失败：${error.message}`, true); }
  };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (socket !== ws || !active) return;
    $('signal-status').textContent = '信令断开 · 正在恢复（已连接媒体可继续）';
    if (++reconnectAttempt > 8) { leave(); notify('信令连接无法恢复，请检查网络后重新入会。', true, true); return; }
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** (reconnectAttempt - 1), 10000));
  };
  ws.onerror = () => {};
}
function createPeer(info, initiate = false) {
  if (peers.has(info.id)) return peers.get(info.id);
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' });
  const peer = { pc, info, started: initiate, polite: self.id.localeCompare(info.id) > 0, makingOffer: false, ignoreOffer: false, settingAnswer: false, queue: Promise.resolve(), candidates: [], labels: new Map(), streams: new Map(), status: '正在建立点对点连接', retries: 0 };
  peers.set(info.id, peer);
  pc.onicecandidate = ({ candidate }) => { if (candidate) signal(info.id, { candidate: candidate.toJSON() }); };
  pc.onnegotiationneeded = async () => {
    // The newcomer starts each initial exchange. This avoids simultaneous initial
    // offers (and ICE rollback bugs) while keeping perfect negotiation for changes.
    if (!peer.started) return;
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal(info.id, { description: pc.localDescription, streams: streamLabels() });
    } catch (error) { if (active && pc.signalingState !== 'closed') notify(error.message, true); }
    finally { peer.makingOffer = false; }
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] || new MediaStream([track]);
    peer.streams.set(stream.id, stream);
    addMediaCard(info.id, stream, `${info.name} · ${peer.labels.get(stream.id) || (track.kind === 'video' ? '摄像头' : '麦克风')}`);
    track.onended = () => { for (const el of [...$('video-grid').children]) if (el.dataset.stream === `${info.id}:${stream.id}`) el.remove(); };
  };
  pc.onconnectionstatechange = () => {
    const labels = { new: '等待连接', connecting: '正在协商直连', connected: '已连接 · 正在检测链路', disconnected: '网络波动，正在恢复', failed: '直连失败：尝试热点或配置独立 TURN', closed: '连接已关闭' };
    peer.status = labels[pc.connectionState]; updateParticipants();
    if (pc.connectionState === 'connected') { peer.retries = 0; limitBitrate(peer); }
    clearTimeout(peer.restartTimer);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') peer.restartTimer = setTimeout(() => {
      if (active && ['failed', 'disconnected'].includes(pc.connectionState) && ++peer.retries <= 3) pc.restartIce();
    }, pc.connectionState === 'failed' ? 1000 : 5000);
  };
  for (const item of media) for (const track of item.stream.getTracks()) pc.addTrack(track, item.stream);
  // A receive-only participant still needs media sections to start negotiation.
  if (!media.length) { pc.addTransceiver('audio', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); }
  updateParticipants();
  return peer;
}
function streamLabels() { return media.map(m => ({ id: m.stream.id, label: m.label, kind: m.kind })); }
async function receiveSignal(peer, data) {
  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  if (data.description) {
    const description = data.description;
    const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
    const collision = description.type === 'offer' && !readyForOffer;
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    peer.started = true;
    for (const item of data.streams || []) peer.labels.set(item.id, item.label);
    peer.settingAnswer = description.type === 'answer';
    try { await pc.setRemoteDescription(description); } finally { peer.settingAnswer = false; }
    for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
    if (description.type === 'offer') { await pc.setLocalDescription(); signal(peer.info.id, { description: pc.localDescription, streams: streamLabels() }); }
    await limitBitrate(peer);
  } else if (data.candidate && !peer.ignoreOffer) {
    if (!pc.remoteDescription) peer.candidates.push(data.candidate);
    else await pc.addIceCandidate(data.candidate);
  }
}
async function limitBitrate(peer) {
  const maximum = { 360: 350_000, 720: 1_000_000, 1080: 1_800_000 }[$('quality').value];
  for (const sender of peer.pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    for (const encoding of params.encodings) encoding.maxBitrate = sender.track.kind === 'video' ? maximum : 48_000;
    try { await sender.setParameters(params); } catch { /* Some browsers do not expose sender bitrate controls. */ }
  }
}
function removePeer(id) {
  const peer = peers.get(id);
  if (peer) { clearTimeout(peer.restartTimer); peer.pc.onconnectionstatechange = null; peer.pc.close(); peers.delete(id); }
  for (const element of [...$('video-grid').children]) if (element.dataset.owner === id) { const player = element.matches('audio') ? element : element.querySelector('video'); if (player) player.srcObject = null; element.remove(); }
  updateParticipants();
}
function updateParticipants() {
  $('people-count').textContent = `${1 + peers.size} / 3`;
  $('empty-state').hidden = peers.size > 0;
  $('participants').replaceChildren();
  const entries = [{ name: `${$('name').value}（我）`, status: hostRole ? '现场主持人' : '远端伙伴' }, ...[...peers.values()].map(p => ({ name: p.info.name, status: p.status, details: p.details }))];
  for (const entry of entries) {
    const card = document.createElement('div'); card.className = 'participant';
    const name = document.createElement('strong'); name.textContent = entry.name;
    const status = document.createElement('small'); status.textContent = entry.status;
    card.append(name, status);
    if (entry.details) { const details = document.createElement('small'); details.textContent = entry.details; card.append(details); }
    $('participants').append(card);
  }
}
async function updateStats() {
  await Promise.all([...peers.values()].map(async peer => {
    try {
      const stats = await peer.pc.getStats();
      let selected, bytes = 0, timestamp = 0;
      for (const report of stats.values()) {
        if (report.type === 'transport' && report.selectedCandidatePairId) selected = stats.get(report.selectedCandidatePairId);
        if (report.type === 'outbound-rtp' && !report.isRemote) { bytes += report.bytesSent || 0; timestamp = report.timestamp; }
      }
      if (!selected) selected = [...stats.values()].find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
      if (selected && peer.pc.connectionState === 'connected') {
        const local = stats.get(selected.localCandidateId), remote = stats.get(selected.remoteCandidateId);
        const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        peer.status = relay ? '已连接 · 独立 TURN 中继' : '已连接 · P2P 直连';
        const rate = peer.last && timestamp > peer.last.timestamp ? Math.max(0, (bytes - peer.last.bytes) * 8 / (timestamp - peer.last.timestamp) / 1000).toFixed(2) : '0.00';
        const rtt = selected.currentRoundTripTime == null ? '—' : Math.round(selected.currentRoundTripTime * 1000);
        peer.details = `延迟 ${rtt} ms · 发送 ${rate} Mbps · ${local?.protocol || 'UDP'}`;
      }
      peer.last = { bytes, timestamp };
    } catch { /* Peer may close while a stats request is in flight. */ }
  }));
  if (active) updateParticipants();
}
function leave() {
  active = false;
  clearTimeout(reconnectTimer); clearInterval(statsTimer);
  socket?.close(); socket = null;
  for (const id of [...peers.keys()]) removePeer(id);
  stopMedia();
  $('video-grid').replaceChildren();
  $('meeting').hidden = true; $('lobby').hidden = false;
  reconnectAttempt = 0;
  setupRole();
}
$('leave').onclick = () => { leave(); notify('已离开会议，摄像头和麦克风已释放。'); };
$('end-room').onclick = () => { if (confirm('结束会议后，所有人都将断开，邀请链接将失效。确定结束？')) send({ type: 'end-room' }); };
$('invite').onclick = async () => {
  if (!guestToken) return notify('请等待信令连接成功后再邀请。', true);
  const link = roomLink(guestToken);
  try { await navigator.clipboard.writeText(link); notify('邀请链接已复制。请发送给两位伙伴。'); }
  catch { prompt('请复制邀请链接（仅分享给参会者）', link); }
};
$('play-audio').onclick = async () => {
  const results = await Promise.allSettled([...document.querySelectorAll('#video-grid video, #video-grid audio')].map(player => player.play()));
  notify(results.some(r => r.status === 'rejected') ? '部分媒体尚未就绪，请连接后再试。' : '已启用播放。');
};
for (const [button, kind, label] of [['mute', 'audio', '麦克风'], ['camera-toggle', 'video', '摄像头']]) $(button).onclick = () => {
  const tracks = media.flatMap(m => m.stream.getTracks()).filter(t => t.kind === kind);
  const enabled = !tracks.some(t => t.enabled);
  tracks.forEach(t => { t.enabled = enabled; });
  $(button).textContent = `${enabled ? '关闭' : '开启'}${label}`;
  $(button).setAttribute('aria-pressed', String(!enabled));
};
window.addEventListener('pagehide', () => { active = false; socket?.close(); stopMedia(); for (const peer of peers.values()) peer.pc.close(); });
setupRole();
if (!window.isSecureContext) notify('请使用 HTTPS 地址访问；普通 HTTP 无法使用摄像头和麦克风。', true, true);
