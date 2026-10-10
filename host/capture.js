const integrated = /surface|integrated|built.?in|internal|内置|笔记本/i;
export function selectCameras(devices, labels = []) {
  const available = devices.filter(d => d.kind === 'videoinput' && !/\bIR\b|infrared|红外|virtual|\bOBS\b|unity|虚拟/i.test(d.label));
  if (labels.length) {
    const selected = labels.map(label => available.find(d => d.label === label));
    if (selected.length !== 2 || selected.some(d => !d) || selected[0].deviceId === selected[1].deviceId) throw new Error('请按 USB 主摄像头、笔记本画中画的顺序配置两个独立摄像头');
    return selected;
  }
  const main = available.find(d => /usb|pc camera/i.test(d.label)) || available.find(d => !integrated.test(d.label)) || available[0];
  const pip = available.find(d => d !== main && integrated.test(d.label) && /front|前/i.test(d.label)) || available.find(d => d !== main && integrated.test(d.label)) || available.find(d => d !== main);
  if (!main || !pip) throw new Error('需要 USB 摄像头和笔记本摄像头，请检查设备连接');
  return [main, pip];
}
export async function captureHost(config = {}) {
  const acquired = [], sources = [];
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some(d => d.kind === 'videoinput' && d.label)) {
      const permission = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permission.getTracks().forEach(t => t.stop()); devices = await navigator.mediaDevices.enumerateDevices();
    }
    const selected = selectCameras(devices, config.cameras);
    for (const [index, device] of selected.entries()) {
      // Hard ceilings and no driver resizing avoid accidentally opening the 8K mode.
      const fps = config.output?.fps || 30;
      const size = index === 0 ? { width: 1920, height: 1080 } : { width: 640, height: 480 };
      const stream = await navigator.mediaDevices.getUserMedia({ video: {
        deviceId: { exact: device.deviceId }, width: { ideal: size.width, max: size.width }, height: { ideal: size.height, max: size.height },
        frameRate: { ideal: fps, max: fps }, ...(navigator.mediaDevices.getSupportedConstraints().resizeMode ? { resizeMode: { exact: 'none' } } : {})
      }, audio: false });
      acquired.push(stream);
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = stream;
      sources.push({ stream, video, label: device.label, settings: track.getSettings(), capabilities: track.getCapabilities() });
      await video.play();
    }
    return { sources, stop() { for (const s of sources) { s.stream.getTracks().forEach(t => t.stop()); s.video.srcObject = null; } } };
  } catch (error) { for (const stream of acquired) stream.getTracks().forEach(t => t.stop()); for (const s of sources) s.video.srcObject = null; throw error; }
}
export async function captureMicrophone(config = {}) {
  let device;
  if (config.microphone) {
    const permission = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    permission.getTracks().forEach(t => t.stop());
    device = (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && d.label === config.microphone);
    if (!device) throw new Error('配置的麦克风未连接');
  }
  return navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(device ? { deviceId: { exact: device.deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}
