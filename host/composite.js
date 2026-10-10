import { cropRect, normalizeView } from './crop.js';

export function compositeSettings(output = {}) {
  return { width: output.width === 1920 ? 1920 : 1280, height: output.width === 1920 ? 1080 : 720, fps: Math.max(5, Math.min(24, Math.round(Number(output.fps) || 15))) };
}
export function coverRect(width, height, view, aspect) {
  const rect = cropRect(width, height, view);
  if (rect.width / rect.height > aspect) { const w = rect.height * aspect; rect.x += (rect.width - w) / 2; rect.width = w; }
  else { const h = rect.width / aspect; rect.y += (rect.height - h) / 2; rect.height = h; }
  return rect;
}
export function pipRect(width, height) {
  const w = Math.round(width * 0.26), h = Math.round(w * 9 / 16), margin = Math.round(width * 0.02);
  return { x: width - w - margin, y: height - h - margin, width: w, height: h };
}
export function createComposite(output) {
  const settings = compositeSettings(output), canvas = document.createElement('canvas');
  canvas.width = settings.width; canvas.height = settings.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  let sources = [], view = { zoom: 1, x: 0.5, y: 0.5 }, disposed = false;
  function drawVideo(video, destination, viewport) {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const rect = coverRect(video.videoWidth, video.videoHeight, viewport, destination.width / destination.height);
    ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, destination.x, destination.y, destination.width, destination.height);
  }
  function draw() {
    if (disposed) return;
    ctx.fillStyle = '#142028'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!sources.length) {
      ctx.fillStyle = '#c5d4dd'; ctx.textAlign = 'center'; ctx.font = `${Math.round(canvas.width / 40)}px sans-serif`;
      ctx.fillText('现场摄像头未启动', canvas.width / 2, canvas.height / 2); return;
    }
    drawVideo(sources[0].video, { x: 0, y: 0, width: canvas.width, height: canvas.height }, view);
    const pip = pipRect(canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(pip.x - 2, pip.y - 2, pip.width + 4, pip.height + 4);
    drawVideo(sources[1].video, pip, { zoom: 1, x: 0.5, y: 0.5 });
  }
  draw();
  const stream = canvas.captureStream(settings.fps), timer = setInterval(draw, 1000 / settings.fps);
  stream.getVideoTracks()[0].contentHint = 'detail';
  const composite = { stream, kind: 'video', camera: 0, label: '现场合成画面 · USB + 画中画', canvas, settings,
    get view() { return { ...view }; },
    snapshot() { return { ...view, camera: 0, sourceWidth: sources[0]?.video.videoWidth || 0, sourceHeight: sources[0]?.video.videoHeight || 0, outputWidth: canvas.width, outputHeight: canvas.height }; },
    setView(next) { view = normalizeView(next); draw(); return composite.snapshot(); },
    setSources(next = []) { sources = next; draw(); },
    dispose() { disposed = true; clearInterval(timer); stream.getTracks().forEach(t => t.stop()); sources = []; canvas.width = canvas.height = 1; }
  };
  return composite;
}
