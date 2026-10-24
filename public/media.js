export class LocalMedia {
  constructor(onChange, onError = () => {}) { this.stream = new MediaStream(); this.onChange = onChange; this.onError = onError; this.tokens = { audio: 0, video: 0 }; this.pending = {}; }
  has(kind) { return this.stream.getTracks().some(t => t.kind === kind && t.readyState === 'live'); }
  async set(kind, enabled, constraints = true) {
    if (!enabled) {
      this.tokens[kind]++;
      delete this.pending[kind];
      for (const track of this.stream.getTracks().filter(t => t.kind === kind)) { this.stream.removeTrack(track); track.stop(); }
      await this.onChange?.(); return false;
    }
    if (this.has(kind)) return true;
    if (this.pending[kind]) return this.pending[kind];
    const token = ++this.tokens[kind];
    const request = (async () => {
      try {
        const result = await navigator.mediaDevices.getUserMedia({ audio: kind === 'audio' ? constraints : false, video: kind === 'video' ? constraints : false });
        if (token !== this.tokens[kind]) { result.getTracks().forEach(t => t.stop()); return false; }
        for (const track of result.getTracks()) {
          this.stream.addTrack(track);
          track.onended = () => { this.stream.removeTrack(track); void this.onChange?.(); };
        }
        await this.onChange?.(); return true;
      } catch (error) {
        if (token === this.tokens[kind]) this.onError(`${kind === 'audio' ? '麦克风' : '摄像头'}未能打开：${error.name === 'NotAllowedError' ? '请允许浏览器权限' : error.message}`);
        return false;
      }
    })();
    this.pending[kind] = request;
    try { return await request; } finally { if (this.pending[kind] === request) delete this.pending[kind]; }
  }
  async stop() { await Promise.all(['audio', 'video'].map(kind => this.set(kind, false))); }
}

let fullscreen;
export function pageFullscreen(stage, button) {
  const close = () => { stage.classList.remove('is-page-fullscreen'); document.body.classList.remove('has-page-fullscreen'); button.textContent = '网页内全屏'; button.setAttribute('aria-pressed', 'false'); if (fullscreen?.stage === stage) fullscreen = null; };
  button.type = 'button'; button.textContent = '网页内全屏'; button.setAttribute('aria-pressed', 'false');
  button.onclick = () => {
    if (fullscreen?.stage === stage) { close(); return; }
    fullscreen?.close(); fullscreen = { stage, close }; stage.classList.add('is-page-fullscreen'); document.body.classList.add('has-page-fullscreen'); button.textContent = '退出网页全屏'; button.setAttribute('aria-pressed', 'true');
  };
  return close;
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') fullscreen?.close(); });

export function preview(video, track) {
  if (video.srcObject?.getVideoTracks()[0] === track) return;
  video.srcObject = track ? new MediaStream([track]) : null;
  if (track) void video.play().catch(() => {});
}

export function remotePlayers({ container, audioContainer, playback, monitor, mainVideo, onChange = () => {} }) {
  const peers = new Map();
  function ensure(peer) {
    if (peers.has(peer.info.id)) return peers.get(peer.info.id);
    let video = mainVideo, card, empty, closeFullscreen;
    if (!video) {
      card = document.createElement('article'); card.className = 'remote-person'; card.dataset.peer = peer.info.id;
      const heading = document.createElement('div'); heading.className = 'panel-heading';
      const name = document.createElement('h3'); name.textContent = peer.info.name;
      const full = document.createElement('button'); full.className = 'secondary'; heading.append(name, full);
      const stage = document.createElement('div'); stage.className = 'video-stage';
      video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
      empty = document.createElement('p'); empty.className = 'video-empty'; empty.textContent = '等待远端开启摄像头…'; stage.append(video, empty, heading); card.append(stage); container.append(card);
      closeFullscreen = pageFullscreen(stage, full);
    }
    const entry = { video, audio: null, card, empty, closeFullscreen }; peers.set(peer.info.id, entry); return entry;
  }
  return {
    source(peer, state) {
      const entry = ensure(peer); monitor?.removeRemote(peer.info.id);
      if (entry.loadedPlayer && entry.onLoaded) entry.loadedPlayer.removeEventListener('loadeddata', entry.onLoaded);
      let player;
      if (state.video) {
        player = entry.video; player.hidden = false;
        if (entry.audio) { entry.audio.removeAttribute('src'); entry.audio.load(); entry.audio.remove(); entry.audio = null; }
        if (state.audio) player.dataset.remoteAudio = 'true'; else delete player.dataset.remoteAudio;
      } else {
        entry.video.removeAttribute('src'); entry.video.load(); entry.video.hidden = true; delete entry.video.dataset.remoteAudio;
        if (!entry.audio) { entry.audio = document.createElement('audio'); entry.audio.autoplay = true; entry.audio.dataset.peer = peer.info.id; audioContainer.append(entry.audio); }
        player = entry.audio;
      }
      if (state.audio) playback.add(player); else { player.muted = true; void player.play().catch(() => {}); }
      entry.onLoaded = () => {
        try { const stream = player.captureStream?.(); if (state.audio && stream?.getAudioTracks().length) monitor?.addRemote(peer.info.id, stream, player); } catch { /* Playback remains available without meter capture support. */ }
        onChange();
      };
      entry.loadedPlayer = player; player.addEventListener('loadeddata', entry.onLoaded, { once: true });
      if (entry.empty) entry.empty.hidden = state.video; onChange(); return player;
    },
    track(peer, track) {
      const entry = ensure(peer);
      if (track.kind === 'video') { preview(entry.video, track); if (entry.empty) entry.empty.hidden = true; }
      else {
        if (!entry.audio) { entry.audio = document.createElement('audio'); entry.audio.autoplay = true; audioContainer.append(entry.audio); }
        entry.audio.srcObject = new MediaStream([track]); playback.add(entry.audio); monitor?.removeRemote(peer.info.id); monitor?.addRemote(peer.info.id, entry.audio.srcObject, entry.audio);
      }
      track.onmute = track.onunmute = () => onChange(); onChange();
    },
    update(peer) { const entry = peers.get(peer.info.id); if (entry?.empty) entry.empty.hidden = peer.media.video && !!(entry.video.srcObject || entry.video.getAttribute('src')); onChange(); },
    remove(peer) {
      const entry = peers.get(peer.info.id); if (!entry) return;
      entry.closeFullscreen?.(); entry.video.srcObject = null; entry.video.removeAttribute('src'); delete entry.video.dataset.remoteAudio;
      if (entry.audio) { entry.audio.srcObject = null; entry.audio.removeAttribute('src'); entry.audio.remove(); }
      entry.card?.remove(); monitor?.removeRemote(peer.info.id); peers.delete(peer.info.id); playback.refresh(); onChange();
    },
    get size() { return peers.size; }
  };
}
