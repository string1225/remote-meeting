import { cropRect, normalizeView } from './crop.js';

export function compositeSettings(output = {}) {
  return { width: output.width === 1280 ? 1280 : 1920, height: output.width === 1280 ? 720 : 1080, fps: Math.max(5, Math.min(30, Math.round(Number(output.fps) || 30))) };
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
