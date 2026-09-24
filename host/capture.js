export async function captureHost(config = {}) {
  const acquired = [];
  try {
    const permission = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    permission.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const available = devices.filter(d => d.kind === 'videoinput' && !/\bIR\b|infrared|红外/i.test(d.label));
    const selected = config.cameras?.length ? config.cameras.map(label => available.find(d => d.label === label)) : available.slice(0, 2);
    if (selected.length !== 2 || selected.some(d => !d) || selected[0].deviceId === selected[1].deviceId) throw new Error('需要两个独立的非红外摄像头，请检查主机设备配置');
    const sources = [];
    for (const device of selected) {
      const noResize = navigator.mediaDevices.getSupportedConstraints().resizeMode ? { resizeMode: { exact: 'none' } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { ideal: 16384 }, height: { ideal: 16384 }, frameRate: { ideal: 24 }, ...noResize }, audio: false });
      acquired.push(stream);
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities();
      if (caps.width?.max && caps.height?.max) {
        try { await track.applyConstraints({ width: { exact: caps.width.max }, height: { exact: caps.height.max }, frameRate: { ideal: 24 }, ...noResize }); }
        catch { await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max }, frameRate: { ideal: 24 }, ...noResize }); }
      }
      const video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      sources.push({ stream, video, label: device.label, settings: track.getSettings(), capabilities: caps });
    }
    const micDevice = config.microphone ? devices.find(d => d.kind === 'audioinput' && d.label === config.microphone) : null;
    if (config.microphone && !micDevice) throw new Error('配置的麦克风未连接');
    const audio = await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(micDevice ? { deviceId: { exact: micDevice.deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    acquired.push(audio);
    return { sources, audio, stop() { for (const stream of acquired) stream.getTracks().forEach(t => t.stop()); for (const s of sources) s.video.srcObject = null; } };
  } catch (error) { for (const stream of acquired) stream.getTracks().forEach(t => t.stop()); throw error; }
}
