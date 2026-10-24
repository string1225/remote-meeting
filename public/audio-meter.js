function levelMeter(label, compact = false) {
  const element = document.createElement('div'); element.className = `audio-level${compact ? ' audio-level-compact' : ''}`;
  const title = document.createElement('span'); title.className = 'audio-level-label'; title.textContent = label;
  const bar = document.createElement('div'); bar.className = 'audio-level-bar'; bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('i'), reading = document.createElement('small'); bar.append(fill); element.append(title, bar, reading);
  let previous = 0;
  function render(rms = 0, state = '') {
    const measured = rms > 0.001 ? Math.max(0, Math.min(100, (20 * Math.log10(rms) + 60) / 60 * 100)) : 0;
    previous = state ? 0 : Math.max(measured, previous * 0.65);
    const value = Math.round(previous);
    fill.style.width = `${value}%`; bar.setAttribute('aria-valuenow', String(value));
    bar.setAttribute('aria-valuetext', state || (value ? `音量 ${value}%` : '无声'));
    reading.textContent = state || (value ? `${value}%` : '无声');
    element.classList.toggle('audio-level-high', value >= 90);
  }
  render(0, '未开启');
  return { element, render };
}

// Analyser branches end in a silent gain: microphone monitoring never plays
// back locally, and received streams are played only by their media elements.
export function createAudioMonitor({ container, requestMicrophone, onError = () => {} }) {
  let context, silent, mic, preview, micRequest = 0, speakerRequest = 0, requesting = false, tone;
  const remotes = new Map(), peerMeters = new Set();
  const element = document.createElement('section'); element.className = 'audio-monitor'; element.setAttribute('aria-label', '本机声音检测');
  const levels = document.createElement('div'); levels.className = 'audio-local-levels';
  const microphone = levelMeter('本机麦克风'), speaker = levelMeter('扬声器播放');
  microphone.element.dataset.audioKind = 'microphone'; speaker.element.dataset.audioKind = 'speaker';
  levels.append(microphone.element, speaker.element);
  const actions = document.createElement('div'); actions.className = 'audio-test-actions';
  const testMic = document.createElement('button'), testSpeaker = document.createElement('button');
  for (const button of [testMic, testSpeaker]) { button.type = 'button'; button.className = 'secondary'; }
  testMic.textContent = '检测麦克风'; testMic.dataset.audioAction = 'microphone';
  testSpeaker.textContent = '试听扬声器'; testSpeaker.dataset.audioAction = 'speaker';
  testSpeaker.title = '播放短提示音，确认系统音量和扬声器';
  actions.append(testMic, testSpeaker); element.append(levels, actions); container.append(element);
  function ensureContext() {
    if (!context || context.state === 'closed') {
      context = new AudioContext(); silent = context.createGain(); silent.gain.value = 0; silent.connect(context.destination);
    }
    return context;
  }
  async function activate() { try { await ensureContext().resume(); } catch { onError('请点击“播放远端声音”或“试听扬声器”启用声音。'); } }
  function analyse(stream) {
    const ctx = ensureContext(), source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())), analyser = ctx.createAnalyser();
    analyser.fftSize = 512; source.connect(analyser); analyser.connect(silent);
    return { stream, source, analyser, samples: new Float32Array(analyser.fftSize) };
  }
  function detach(item) { item?.source.disconnect(); item?.analyser.disconnect(); }
  function sample(item) {
    if (!item || context?.state !== 'running') return 0;
    if (item.stream && !item.stream.getAudioTracks().some(track => track.readyState === 'live' && track.enabled && !track.muted)) return 0;
    item.analyser.getFloatTimeDomainData(item.samples);
    return Math.sqrt(item.samples.reduce((sum, value) => sum + value * value, 0) / item.samples.length);
  }
  function stopPreview() {
    micRequest++; requesting = false;
    if (preview) { preview.getTracks().forEach(track => track.stop()); preview = null; detach(mic); mic = null; }
  }
  function setMicrophone(stream) {
    if (mic?.stream === stream) return;
    stopPreview(); detach(mic); mic = stream?.getAudioTracks().length ? analyse(stream) : null; update();
  }
  testMic.onclick = async () => {
    if (mic && !preview) return;
    if (preview || requesting) { stopPreview(); update(); return; }
    const request = ++micRequest; requesting = true; update();
    void activate();
    try {
      const stream = await requestMicrophone();
      if (request !== micRequest) { stream.getTracks().forEach(track => track.stop()); return; }
      preview = stream; detach(mic); mic = analyse(stream);
    } catch { if (request === micRequest) { stopPreview(); onError('无法开启麦克风，请检查设备及浏览器权限。'); } }
    finally { if (request === micRequest) requesting = false; update(); }
  };
  function stopTone() { speakerRequest++; if (tone) { clearTimeout(tone.timer); tone.oscillator.stop(); tone.oscillator.disconnect(); tone.gain.disconnect(); tone.analyser.disconnect(); tone = null; } }
  testSpeaker.onclick = async () => {
    if (tone) { stopTone(); update(); return; }
    const request = ++speakerRequest;
    await activate();
    if (request !== speakerRequest || !context || context.state !== 'running') return;
    const oscillator = context.createOscillator(), gain = context.createGain(), analyser = context.createAnalyser(); analyser.fftSize = 512;
    oscillator.frequency.value = 440; gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(0.12, context.currentTime + 0.05);
    gain.gain.setValueAtTime(0.12, context.currentTime + 1.1); gain.gain.linearRampToValueAtTime(0, context.currentTime + 1.3);
    oscillator.connect(gain); gain.connect(analyser); analyser.connect(context.destination); oscillator.start();
    tone = { oscillator, gain, analyser, samples: new Float32Array(analyser.fftSize), timer: setTimeout(() => { stopTone(); update(); }, 1400) }; update();
  };
  function micState() {
    const tracks = mic?.stream.getAudioTracks() || [];
    if (!tracks.some(track => track.readyState === 'live')) return requesting ? '申请中' : '未开启';
    if (!tracks.some(track => track.enabled)) return '已静音';
    if (context?.state !== 'running') return '待启用';
    return '';
  }
  function update() {
    const micLevel = sample(mic), micStatus = micState();
    microphone.render(micLevel, micStatus);
    testMic.textContent = preview || requesting ? '停止检测' : '检测麦克风'; testMic.disabled = !!mic && !preview;
    testSpeaker.textContent = tone ? '停止试听' : '试听扬声器';
    const values = new Map(); let output = sample(tone) ** 2, playing = !!tone;
    for (const remote of remotes.values()) {
      const level = sample(remote); values.set(remote.owner, (values.get(remote.owner) || 0) + level ** 2);
      if (!remote.player.paused && !remote.player.muted && remote.player.volume > 0) { output += (level * remote.player.volume) ** 2; playing = true; }
    }
    const muted = remotes.size > 0 && [...remotes.values()].every(remote => remote.player.muted || remote.player.volume === 0);
    speaker.render(Math.min(1, Math.sqrt(output)), !tone && muted ? '已静音' : context?.state !== 'running' && remotes.size ? '待启用' : !playing ? remotes.size ? '待播放' : '无播放' : '');
    for (const meter of peerMeters) {
      if (!meter.element.isConnected) { peerMeters.delete(meter); continue; }
      meter.render(meter.owner === 'local' ? micLevel : Math.sqrt(values.get(meter.owner) || 0), meter.owner === 'local' ? micStatus : !values.has(meter.owner) ? '待接收' : context?.state !== 'running' ? '待启用' : '');
    }
  }
  const interval = setInterval(update, 100); update();
  function reset() {
    stopPreview(); stopTone(); detach(mic); mic = null;
    for (const remote of remotes.values()) detach(remote); remotes.clear();
    if (context) { void context.close().catch(() => {}); context = null; silent = null; }
    update();
  }
  return {
    element, activate, stopPreview, setMicrophone, reset,
    addRemote(owner, stream, player) { if (!stream.getAudioTracks().length || remotes.has(stream.id)) return; remotes.set(stream.id, { ...analyse(stream), owner, player }); },
    removeRemote(owner) { for (const [id, remote] of remotes) if (remote.owner === owner) { detach(remote); remotes.delete(id); } update(); },
    peerMeter(owner, label = '麦克风') { const meter = { ...levelMeter(label, true), owner }; peerMeters.add(meter); return meter.element; },
    dispose() { clearInterval(interval); reset(); peerMeters.clear(); }
  };
}
