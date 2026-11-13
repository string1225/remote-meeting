// The native backend sends host-media; the local page only receives remote-media.
export const remoteVideoConstraints = { facingMode: 'user', width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 15, max: 20 } };
export const remoteVideoBitrate = 2000000;
export class MeetingRTC {
  constructor({ send, stream = new MediaStream(), channel, initiate = false, receive = true, onTrack, onPeer, onRemove, onError = () => {} }) {
    Object.assign(this, { send, stream, channel, initiate, receive, onTrack, onPeer, onRemove, onError }); this.peers = new Map();
  }
  configure(self, iceServers = [], hostMedia) { if (self.id !== this.self?.id) this.clear(); this.self = self; this.iceServers = iceServers; this.udp = this.channel === 'host-media' && hostMedia?.transport === 'udp'; }
  add(info) {
    if (!this.self || info.id === this.self.id || info.role === this.self.role) return;
    if (this.peers.has(info.id)) return this.peers.get(info.id);
    if (!this.udp && !this.iceServers?.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/.test(url)) && server.username && server.credential)) throw new Error('缺少服务器转发配置，请检查 TURN 服务');
    const pc = new RTCPeerConnection({ iceServers: this.udp ? [] : this.iceServers, iceTransportPolicy: this.udp ? 'all' : 'relay', bundlePolicy: 'max-bundle' });
    const peer = { info, pc, state: 'connecting', media: { audio: false, video: false }, candidates: [], queue: Promise.resolve(), senders: {}, snapshot: {} }; this.peers.set(info.id, peer);
    const signal = data => this.send({ type: 'signal', to: info.id, channel: this.channel, data }); peer.signal = signal;
    pc.onicecandidate = ({ candidate }) => { if (candidate) signal({ candidate: candidate.toJSON() }); };
    pc.ontrack = ({ track, receiver }) => {
      if (track.kind === 'video') try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0; if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0; } catch {}
      peer.media[track.kind] = true; this.onTrack?.(peer, track); this.onPeer?.(peer);
    };
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
          await peer.pc.setLocalDescription(await peer.pc.createAnswer()); await this.limit(peer); peer.signal({ description: peer.pc.localDescription });
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
      for (const e of params.encodings) {
        const video = sender.track.kind === 'video';
        e.maxBitrate = video ? remoteVideoBitrate : 48000; e.priority = video ? 'low' : 'high';
        if (video) { const { width = 1280, height = 720 } = sender.track.getSettings(); e.maxFramerate = 20; e.scaleResolutionDownBy = Math.max(1, width / 1280, height / 720); }
      }
      try { await sender.setParameters(params); } catch { /* Encoder parameters vary by browser. */ }
    }
  }
  remove(id) { const peer = this.peers.get(id); if (!peer) return; this.peers.delete(id); clearTimeout(peer.reconnect); peer.pc.onconnectionstatechange = null; peer.pc.close(); this.onRemove?.(peer); }
  clear() { for (const id of [...this.peers.keys()]) this.remove(id); this.lastStats = []; }
  async stats() {
    const output = [];
    for (const peer of this.peers.values()) {
      try {
        const reports = await peer.pc.getStats(); let pair, video, receivedAudio = 0, receivedVideo = 0, bytes = 0;
        for (const r of reports.values()) {
          if (r.type === 'transport') pair = reports.get(r.selectedCandidatePairId);
          if (r.type === 'inbound-rtp') { bytes += r.bytesReceived || 0; if (r.kind === 'audio') receivedAudio += r.bytesReceived || 0; else { receivedVideo += r.framesDecoded || 0; video = r; } }
        }
        const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
        const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        peer.link = pair ? this.udp ? 'UDP 转发' : relay ? '服务器转发' : '异常：未使用转发' : ''; this.onPeer?.(peer);
        const now = performance.now(), previous = peer.snapshot.metrics;
        const elapsed = previous ? (now - previous.now) / 1000 : 0;
        const diff = key => Math.max(0, (video?.[key] || 0) - (previous?.video?.[key] || 0));
        const decoded = diff('framesDecoded'), emitted = diff('jitterBufferEmittedCount');
        const receiver = peer.pc.getReceivers().find(r => r.track.kind === 'video');
        const sync = receiver?.getSynchronizationSources?.()[0];
        const arrivalLagMs = previous && sync && previous.rtpTimestamp != null && decoded > 0 ? Math.max(0, previous.arrivalLagMs + now - previous.now - ((sync.rtpTimestamp - previous.rtpTimestamp) >>> 0) / 90) : previous?.arrivalLagMs || 0;
        const metrics = {
          width: video?.frameWidth || 0, height: video?.frameHeight || 0,
          incomingKbps: elapsed ? Math.max(0, bytes - previous.bytes) * 8 / elapsed / 1000 : 0,
          videoFps: elapsed ? decoded / elapsed : video?.framesPerSecond || 0,
          jitterBufferMs: emitted ? diff('jitterBufferDelay') / emitted * 1000 : 0,
          arrivalLagMs, decodeMs: decoded ? diff('totalDecodeTime') / decoded * 1000 : 0,
          lossPercent: diff('packetsReceived') + diff('packetsLost') ? diff('packetsLost') * 100 / (diff('packetsReceived') + diff('packetsLost')) : 0,
          rttMs: (pair?.currentRoundTripTime || 0) * 1000
        };
        peer.snapshot.metrics = { now, video, bytes, rtpTimestamp: sync?.rtpTimestamp, arrivalLagMs };
        if (this.channel === 'host-media' && this.receive && video) this.send({ type: 'media-stats', data: metrics });
        output.push({ id: peer.info.id, state: peer.pc.connectionState, transport: pair ? this.udp ? 'frp-udp' : relay ? 'relay' : 'p2p' : 'connecting', localCandidate: local?.candidateType, remoteCandidate: remote?.candidateType, remoteAddress: remote?.address, remotePort: remote?.port, relayProtocol: local?.relayProtocol, receivedAudio, receivedVideo, receivedBytes: bytes, rtt: pair?.currentRoundTripTime, ...metrics });
      } catch { /* The connection may close during collection. */ }
    }
    this.lastStats = output; return output;
  }
}
