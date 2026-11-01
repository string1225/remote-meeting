import { cropRect, normalizeView } from './crop.js';

export const videoProfiles = Object.freeze({
  '480p30': { width: 854, height: 480, fps: 30 },
  '720p20': { width: 1280, height: 720, fps: 20 },
  '1080p10': { width: 1920, height: 1080, fps: 10 }
});

export function compositeSettings(output = {}) {
  if (Object.hasOwn(videoProfiles, output.profile)) return { ...videoProfiles[output.profile], profile: output.profile };
  const width = Number.isFinite(output.width) && output.width > 0 ? output.width : 1280;
  const height = Number.isFinite(output.height) && output.height > 0 ? output.height : width * 9 / 16;
  const scale = Math.min(1, 1280 / width, 720 / height);
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2), fps: Math.max(5, Math.min(30, Math.round(Number(output.fps) || 30))) };
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
