export function normalizeView(view) {
  if (!view || ![view.zoom, view.x, view.y].every(Number.isFinite)) throw new Error('Invalid viewport');
  const zoom = Math.min(8, Math.max(1, view.zoom)), edge = 0.5 / zoom;
  return { zoom, x: Math.min(1 - edge, Math.max(edge, view.x)), y: Math.min(1 - edge, Math.max(edge, view.y)) };
}
export function cropRect(width, height, view) {
  const v = normalizeView(view), w = width / v.zoom, h = height / v.zoom;
  return { x: v.x * width - w / 2, y: v.y * height - h / 2, width: w, height: h };
}
export function outputSize(width, height, maximum = { width: 1920, height: 1080 }) {
  const scale = Math.min(1, width / maximum.width, height / maximum.height);
  return { width: Math.max(2, Math.floor(maximum.width * scale / 2) * 2), height: Math.max(2, Math.floor(maximum.height * scale / 2) * 2) };
}
export function createCrop(source, camera, output = { width: 1920, height: 1080, fps: 24 }) {
  const size = outputSize(source.video.videoWidth, source.video.videoHeight, output);
  const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  let view = { zoom: 1, x: 0.5, y: 0.5 }, disposed = false;
  const draw = () => {
    if (disposed || source.video.readyState < 2) return;
    const rect = cropRect(source.video.videoWidth, source.video.videoHeight, view);
    const scale = Math.min(canvas.width / rect.width, canvas.height / rect.height);
    const dw = rect.width * scale, dh = rect.height * scale;
    ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source.video, rect.x, rect.y, rect.width, rect.height, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  };
  draw();
  const stream = canvas.captureStream(output.fps);
  const timer = setInterval(draw, 1000 / output.fps);
  stream.getVideoTracks()[0].contentHint = 'detail';
  return { stream, kind: 'video', camera, label: `现场摄像头 ${camera + 1}`, canvas,
    get view() { return { ...view }; },
    setView(next) { view = normalizeView(next); draw(); return { ...view, camera, sourceWidth: source.video.videoWidth, sourceHeight: source.video.videoHeight, outputWidth: canvas.width, outputHeight: canvas.height }; },
    dispose() { disposed = true; clearInterval(timer); stream.getTracks().forEach(t => t.stop()); canvas.width = canvas.height = 1; }
  };
}
