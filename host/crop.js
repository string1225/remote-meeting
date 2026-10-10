export function normalizeView(view) {
  if (!view || ![view.zoom, view.x, view.y].every(Number.isFinite)) throw new Error('Invalid viewport');
  const zoom = Math.min(8, Math.max(1, view.zoom)), edge = 0.5 / zoom;
  return { zoom, x: Math.min(1 - edge, Math.max(edge, view.x)), y: Math.min(1 - edge, Math.max(edge, view.y)) };
}
export function cropRect(width, height, view) {
  const v = normalizeView(view), w = width / v.zoom, h = height / v.zoom;
  return { x: v.x * width - w / 2, y: v.y * height - h / 2, width: w, height: h };
}
