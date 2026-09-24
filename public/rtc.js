export class MeetingRTC {
  constructor({ send, getMedia, onTrack, onPeer, onRemove, onControl, onControlOpen, onError }) {
    Object.assign(this, { send, getMedia, onTrack, onPeer, onRemove, onControl, onControlOpen, onError });
    this.peers = new Map();
    this.pending = new Map();
    this.generation = 0;
  }
  configure(self, iceServers) { this.clear(); this.self = self; this.iceServers = iceServers; }
  async add(info, initiate = false) {
    if (this.peers.has(info.id) || this.pending.has(info.id)) return;
    const request = { generation: this.generation };
    this.pending.set(info.id, request);
    let media;
    try { media = await this.getMedia(info); }
    catch (error) { if (this.pending.get(info.id) === request) this.pending.delete(info.id); throw error; }
    if (request.generation !== this.generation || this.pending.get(info.id) !== request) { for (const m of media) m.dispose?.(); return; }
    this.pending.delete(info.id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const peer = { info, pc, media, started: initiate, polite: this.self.id.localeCompare(info.id) > 0, makingOffer: false, settingAnswer: false, ignoreOffer: false, candidates: [], labels: new Map(), queue: Promise.resolve(), retries: 0 };
    this.peers.set(info.id, peer);
    const signal = data => this.send({ type: 'signal', to: info.id, data });
    peer.labelsOut = () => media.map(m => ({ id: m.stream.id, label: m.label, kind: m.kind, camera: m.camera }));
    pc.onicecandidate = ({ candidate }) => { if (candidate) signal({ candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      if (!peer.started) return;
      try { peer.makingOffer = true; await pc.setLocalDescription(); signal({ description: pc.localDescription, streams: peer.labelsOut() }); }
      catch (e) { if (pc.signalingState !== 'closed') this.onError?.(e); }
      finally { peer.makingOffer = false; }
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      this.onTrack?.(peer, stream, peer.labels.get(stream.id) || { kind: track.kind });
    };
    const attachChannel = channel => {
      if (channel.label !== 'viewport' || peer.channel) { channel.close(); return; }
      peer.channel = channel;
      let count = 0, since = Date.now();
      channel.onopen = () => this.onControlOpen?.(peer);
      channel.onmessage = event => {
        if (Date.now() - since > 1000) { count = 0; since = Date.now(); }
        if (++count > 60 || typeof event.data !== 'string' || event.data.length > 2048) return;
        try { this.onControl?.(peer, JSON.parse(event.data)); } catch { /* Ignore malformed control messages. */ }
      };
    };
    pc.ondatachannel = ({ channel }) => attachChannel(channel);
    if (this.self.role === 'remote' && info.role === 'host') attachChannel(pc.createDataChannel('viewport', { ordered: true }));
    pc.onconnectionstatechange = () => {
      this.onPeer?.(peer);
      clearTimeout(peer.restartTimer);
      if (pc.connectionState === 'connected') { peer.retries = 0; void this.limit(peer); }
      if (['failed', 'disconnected'].includes(pc.connectionState)) peer.restartTimer = setTimeout(() => {
        if (this.peers.has(info.id) && ['failed', 'disconnected'].includes(pc.connectionState) && ++peer.retries <= 3) pc.restartIce();
      }, pc.connectionState === 'failed' ? 1000 : 5000);
    };
    for (const item of media) for (const track of item.stream.getTracks()) pc.addTrack(track, item.stream);
    if (!media.length) { pc.addTransceiver('audio', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); }
    this.onPeer?.(peer);
  }
  signal(id, data) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.queue = peer.queue.then(async () => {
      const pc = peer.pc;
      if (pc.signalingState === 'closed') return;
      if (data.description) {
        const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
        peer.ignoreOffer = !peer.polite && data.description.type === 'offer' && !ready;
        if (peer.ignoreOffer) return;
        peer.started = true;
        for (const item of data.streams || []) peer.labels.set(item.id, item);
        peer.settingAnswer = data.description.type === 'answer';
        try { await pc.setRemoteDescription(data.description); } finally { peer.settingAnswer = false; }
        for (const c of peer.candidates.splice(0)) await pc.addIceCandidate(c);
        if (data.description.type === 'offer') { await pc.setLocalDescription(); this.send({ type: 'signal', to: id, data: { description: pc.localDescription, streams: peer.labelsOut() } }); }
        await this.limit(peer);
      } else if (data.candidate && !peer.ignoreOffer) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else peer.candidates.push(data.candidate);
      }
    }).catch(e => { if (this.peers.has(id)) this.onError?.(e); });
  }
  control(id, data) {
    const channel = this.peers.get(id)?.channel;
    if (channel?.readyState !== 'open' || channel.bufferedAmount > 16384) return false;
    channel.send(JSON.stringify(data)); return true;
  }
  async limit(peer) {
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      const height = sender.track.getSettings().height || 1080;
      for (const e of params.encodings) { e.maxBitrate = sender.track.kind === 'video' ? (height <= 720 ? 1_600_000 : 3_000_000) : 64_000; if (sender.track.kind === 'video') e.maxFramerate = 24; }
      try { await sender.setParameters(params); } catch { /* Browser-specific encoder limits. */ }
    }
  }
  remove(id) {
    this.pending.delete(id);
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id); clearTimeout(peer.restartTimer); peer.pc.onconnectionstatechange = null; peer.pc.close();
    for (const m of peer.media) m.dispose?.();
    this.onRemove?.(peer);
  }
  clear() { this.generation++; this.pending.clear(); for (const id of [...this.peers.keys()]) this.remove(id); }
  async stats() {
    for (const peer of this.peers.values()) {
      try {
        const reports = await peer.pc.getStats();
        let pair, bytes = 0, time = 0;
        for (const r of reports.values()) {
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = reports.get(r.selectedCandidatePairId);
          if (r.type === 'outbound-rtp') { bytes += r.bytesSent || 0; time = r.timestamp; }
        }
        if (pair) {
          const local = reports.get(pair.localCandidateId), remote = reports.get(pair.remoteCandidateId);
          peer.link = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? '独立 TURN' : 'P2P 直连';
          peer.detail = `${Math.round((pair.currentRoundTripTime || 0) * 1000)} ms`;
          if (peer.previous && time > peer.previous.time) peer.detail += ` · 上行 ${((bytes - peer.previous.bytes) * 8 / (time - peer.previous.time) / 1000).toFixed(2)} Mbps`;
          peer.previous = { bytes, time }; this.onPeer?.(peer);
        }
      } catch { /* Peer may close during collection. */ }
    }
  }
}
