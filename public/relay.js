// One encoder per sender. Encrypted WSS carries the same live chunks to viewers.
export class MeetingRelay {
  constructor({ stream, createSocket, join, onSource, onPeer, onRemove, onError = () => {} }) {
    Object.assign(this, { stream, createSocket, join, onSource, onPeer, onRemove, onError });
    this.peers = new Map(); this.generation = 0; this.bytesSent = 0;
  }
  configure(self) {
    if (this.self?.id !== self.id) this.clear();
    this.self = self; this.active = true; if (!this.socket) this.open();
  }
  open() {
    if (!this.active || this.socket) return;
    const ws = this.createSocket(); ws.binaryType = 'arraybuffer'; this.socket = ws;
    ws.onopen = () => { const message = this.join?.(); if (message) ws.send(JSON.stringify(message)); };
    ws.onmessage = event => {
      if (ws !== this.socket) return;
      if (typeof event.data !== 'string') { this.receive(event.data); return; }
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'media-joined') { this.joined = true; this.restart(); }
        else if (message.type === 'media-request') this.restart();
        else if (message.type === 'source-start') this.source(message);
        else if (message.type === 'source-ended') this.remove(message.from);
      } catch (error) { this.onError(error); }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.socket !== ws) return; this.socket = null; this.joined = false; this.stopEncoder();
      for (const peer of this.peers.values()) { peer.state = 'disconnected'; this.onPeer?.(peer); }
      if (this.active) this.reconnectTimer = setTimeout(() => this.open(), 1000);
    };
  }
  add(info) {
    if (!this.self || info.id === this.self.id || info.role === this.self.role) return;
    if (!this.peers.has(info.id)) { const peer = { info, state: 'connecting', media: { video: false, audio: false }, received: 0 }; this.peers.set(info.id, peer); this.onPeer?.(peer); }
    return this.peers.get(info.id);
  }
  flags() { return Object.fromEntries(['audio', 'video'].map(kind => [kind, this.stream.getTracks().some(t => t.kind === kind && t.readyState === 'live' && t.enabled)])); }
  signature() { return this.stream.getTracks().filter(t => t.readyState === 'live' && t.enabled).map(t => t.id).sort().join(','); }
  async sync() { if (this.encodingSignature !== this.signature()) this.restart(); }
  stopEncoder() {
    this.generation++; const old = this.recorder; this.recorder = null; this.encodingSignature = '';
    if (old && old.state !== 'inactive') old.stop();
  }
  restart() {
    if (!this.joined || this.socket?.readyState !== WebSocket.OPEN) return;
    this.stopEncoder(); const flags = this.flags();
    if (!flags.audio && !flags.video) { this.socket.send(JSON.stringify({ type: 'source-ended' })); return; }
    const candidates = flags.video ? flags.audio
      ? ['video/webm;codecs=vp8,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2']
      : ['video/webm;codecs=vp8', 'video/mp4;codecs=avc1.42E01E']
      : ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'];
    const mimeType = candidates.find(mime => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) { this.onError(new Error('浏览器不支持实时音视频编码，请使用新版 Edge 或 Chrome')); return; }
    try {
      const recorder = new MediaRecorder(new MediaStream(this.stream.getTracks().filter(t => t.readyState === 'live' && t.enabled)), { mimeType, videoBitsPerSecond: this.self.role === 'host' ? 2500000 : 600000, audioBitsPerSecond: 48000, videoKeyFrameIntervalDuration: 1000 });
      this.recorder = recorder; this.encodingSignature = this.signature(); const generation = this.generation;
      this.socket.send(JSON.stringify({ type: 'source-start', mime: recorder.mimeType, ...flags }));
      recorder.ondataavailable = ({ data }) => {
        if (generation !== this.generation || !data.size || this.socket?.readyState !== WebSocket.OPEN) return;
        if (this.socket.bufferedAmount > 2 * 1024 * 1024) { this.socket.close(); return; }
        this.socket.send(data); this.bytesSent += data.size;
      };
      recorder.onerror = event => this.onError(event.error || new Error('音视频编码失败'));
      recorder.start(150);
    } catch (error) { this.onError(error); }
  }
  source(message) {
    const peer = this.add(message.source); if (!peer) return;
    this.disposeSource(peer); peer.requesting = false; peer.media = { audio: message.audio, video: message.video }; peer.epoch = message.epoch; peer.received = 0;
    const Source = window.MediaSource || window.ManagedMediaSource;
    if (!Source?.isTypeSupported(message.mime)) { this.onError(new Error('浏览器不支持当前音视频播放格式，请使用新版 Edge 或 Chrome')); return; }
    peer.player = this.onSource?.(peer, message); if (!peer.player) return;
    const player = peer.player, source = new Source(); peer.source = source; peer.queue = []; peer.queuedBytes = 0;
    peer.url = URL.createObjectURL(source); player.disableRemotePlayback = true; player.srcObject = null; player.src = peer.url;
    source.addEventListener('sourceopen', () => {
      if (peer.source !== source) return;
      try { peer.buffer = source.addSourceBuffer(message.mime); peer.buffer.addEventListener('updateend', () => this.pump(peer)); peer.buffer.addEventListener('error', () => this.requestSource(peer)); this.pump(peer); }
      catch (error) { this.onError(error); }
    });
    player.onloadedmetadata = () => { void player.play().catch(() => {}); this.onPeer?.(peer); };
    peer.state = 'connected'; peer.link = '139 音视频中转'; this.onPeer?.(peer);
    void player.play().catch(() => {});
  }
  receive(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 41) return;
    const id = new TextDecoder().decode(new Uint8Array(data, 0, 36)), epoch = new DataView(data).getUint32(36), peer = this.peers.get(id);
    if (!peer?.source || peer.epoch !== epoch) return;
    const bytes = new Uint8Array(data, 40); peer.received += bytes.byteLength; peer.queuedBytes += bytes.byteLength;
    if (peer.queuedBytes > 3 * 1024 * 1024) { this.requestSource(peer); return; }
    peer.queue.push(bytes); this.pump(peer);
  }
  requestSource(peer) {
    if (peer.requesting) return; peer.requesting = true; this.disposeSource(peer);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'media-request' }));
  }
  pump(peer) {
    const buffer = peer.buffer, player = peer.player;
    if (!buffer || buffer.updating || peer.source?.readyState !== 'open') return;
    try {
      if (buffer.buffered.length) {
        const start = buffer.buffered.start(0), end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end - player.currentTime > 1.4) player.currentTime = Math.max(start, end - 0.4);
        if (player.currentTime - start > 8) { buffer.remove(start, player.currentTime - 4); return; }
      }
      const bytes = peer.queue.shift(); if (bytes) { peer.queuedBytes -= bytes.byteLength; buffer.appendBuffer(bytes); }
    } catch { this.requestSource(peer); }
  }
  disposeSource(peer) {
    if (peer.player) { peer.player.onloadedmetadata = null; peer.player.removeAttribute('src'); peer.player.load(); }
    if (peer.url) URL.revokeObjectURL(peer.url);
    peer.url = null; peer.source = null; peer.buffer = null; peer.queue = []; peer.queuedBytes = 0;
  }
  remove(id) { const peer = this.peers.get(id); if (!peer) return; this.peers.delete(id); this.disposeSource(peer); this.onRemove?.(peer); }
  clear() {
    this.active = false; clearTimeout(this.reconnectTimer); this.stopEncoder(); this.joined = false;
    const old = this.socket; this.socket = null; old?.close(); for (const id of [...this.peers.keys()]) this.remove(id);
  }
  stats() {
    return [...this.peers.values()].map(peer => ({ id: peer.info.id, state: peer.state, transport: 'wss-relay', relayAddress: '139.224.12.141', receivedAudio: peer.media.audio ? peer.received : 0, receivedVideo: peer.player?.getVideoPlaybackQuality?.().totalVideoFrames || 0, receivedBytes: peer.received, bufferedSeconds: peer.player?.buffered.length ? peer.player.buffered.end(peer.player.buffered.length - 1) - peer.player.currentTime : 0 }));
  }
}
