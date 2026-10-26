// The native backend sends host-media; the local page only receives remote-media.
export class MeetingRTC {
  constructor({ send, stream = new MediaStream(), channel, initiate = false, receive = true, onTrack, onPeer, onRemove, onError = () => {} }) {
    Object.assign(this, { send, stream, channel, initiate, receive, onTrack, onPeer, onRemove, onError }); this.peers = new Map();
  }
  configure(self, iceServers = []) { if (self.id !== this.self?.id) this.clear(); this.self = self; this.iceServers = iceServers; }
  add(info) {
    if (!this.self || info.id === this.self.id || info.role === this.self.role) return;
    if (this.peers.has(info.id)) return this.peers.get(info.id);
    if (!this.iceServers?.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/.test(url)) && server.username && server.credential)) throw new Error('缺少服务器转发配置，请检查 TURN 服务');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: 'relay', bundlePolicy: 'max-bundle' });
    const peer = { info, pc, state: 'connecting', media: { audio: false, video: false }, candidates: [], queue: Promise.resolve(), senders: {}, snapshot: {} }; this.peers.set(info.id, peer);
    const signal = data => this.send({ type: 'signal', to: info.id, channel: this.channel, data }); peer.signal = signal;
    pc.onicecandidate = ({ candidate }) => { if (candidate) signal({ candidate: candidate.toJSON() }); };
    pc.ontrack = ({ track }) => { peer.media[track.kind] = true; this.onTrack?.(peer, track); this.onPeer?.(peer); };
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState; this.onPeer?.(peer); clearTimeout(peer.reconnect);
      if (['failed', 'disconnected'].includes(peer.state)) peer.reconnect = setTimeout(() => {
        if (this.peers.get(info.id) !== peer) return;
        if (this.initiate) { this.remove(info.id); this.add(info); }
        else signal({ restart: true });
      }, peer.state === 'failed' ? 1000 : 5000);
    };
    this.onPeer?.(peer);
    if (this.initiate) {
      for (const kind of ['video', 'audio']) pc.addTransceiver(kind, { direction: 'recvonly' });
      peer.queue = pc.createOffer().then(async offer => { await pc.setLocalDescription(offer); signal({ description: pc.localDescription }); }).catch(this.onError);
    }
    return peer;
  }
  signal(id, data) {
    const peer = this.peers.get(id); if (!peer) return;
    peer.queue = peer.queue.then(async () => {
      if (peer.pc.signalingState === 'closed') return;
      if (data.description) {
        await peer.pc.setRemoteDescription(data.description);
        for (const c of peer.candidates.splice(0)) await peer.pc.addIceCandidate(c);
        if (data.description.type === 'offer') {
          for (const t of peer.pc.getTransceivers()) {
            t.direction = this.receive ? 'recvonly' : 'sendonly';
            if (!this.receive) { peer.senders[t.receiver.track.kind] = t.sender; await t.sender.replaceTrack(this.stream.getTracks().find(track => track.kind === t.receiver.track.kind) || null); }
          }
          await peer.pc.setLocalDescription(await peer.pc.createAnswer()); peer.signal({ description: peer.pc.localDescription }); await this.limit(peer);
          if (!this.receive) peer.signal({ media: this.flags() });
        }
      } else if (data.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate); else peer.candidates.push(data.candidate);
      } else if (data.media) { peer.media = data.media; this.onPeer?.(peer); }
      else if (data.restart && this.initiate) { this.remove(id); this.add(peer.info); }
    }).catch(error => { if (peer.pc.signalingState !== 'closed') this.onError(error); });
  }
  flags() { return Object.fromEntries(['audio', 'video'].map(kind => [kind, this.stream.getTracks().some(t => t.kind === kind && t.readyState === 'live')])); }
  async sync() {
    for (const peer of this.peers.values()) {
      for (const [kind, sender] of Object.entries(peer.senders)) await sender.replaceTrack(this.stream.getTracks().find(t => t.kind === kind && t.readyState === 'live') || null);
      if (!this.receive) { peer.signal({ media: this.flags() }); await this.limit(peer); }
    }
  }
  async limit(peer) {
    for (const sender of Object.values(peer.senders)) {
      if (!sender.track) continue; const params = sender.getParameters(); if (!params.encodings?.length) continue;
      for (const e of params.encodings) { e.maxBitrate = sender.track.kind === 'video' ? 600000 : 48000; if (sender.track.kind === 'video') e.maxFramerate = 15; }
      try { await sender.setParameters(params); } catch { /* Encoder parameters vary by browser. */ }
    }
  }
  remove(id) { const peer = this.peers.get(id); if (!peer) return; this.peers.delete(id); clearTimeout(peer.reconnect); peer.pc.onconnectionstatechange = null; peer.pc.close(); this.onRemove?.(peer); }
  clear() { for (const id of [...this.peers.keys()]) this.remove(id); this.lastStats = []; }
  async stats() {
    const output = [];
    for (const peer of this.peers.values()) {
      try {
        const reports = await peer.pc.getStats(); let pair, receivedAudio = 0, receivedVideo = 0, bytes = 0;
        for (const r of reports.values()) {
          if (r.type === 'transport') pair = reports.get(r.selectedCandidatePairId);
          if (r.type === 'inbound-rtp') { bytes += r.bytesReceived || 0; if (r.kind === 'audio') receivedAudio += r.bytesReceived || 0; else receivedVideo += r.framesDecoded || 0; }
        }
        const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
        const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        peer.link = pair ? relay ? '服务器转发' : '异常：未使用转发' : ''; this.onPeer?.(peer);
        output.push({ id: peer.info.id, state: peer.pc.connectionState, transport: pair ? relay ? 'relay' : 'p2p' : 'connecting', localCandidate: local?.candidateType, remoteCandidate: remote?.candidateType, receivedAudio, receivedVideo, receivedBytes: bytes, rtt: pair?.currentRoundTripTime });
      } catch { /* The connection may close during collection. */ }
    }
    this.lastStats = output; return output;
  }
}
