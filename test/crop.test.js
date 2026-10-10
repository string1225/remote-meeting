import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropRect, normalizeView } from '../host/crop.js';

test('crop geometry selects only the requested high-resolution region and clamps edges', () => {
  assert.deepEqual(cropRect(3840, 2160, { zoom: 2, x: 0.25, y: 0.5 }), { x: 0, y: 540, width: 1920, height: 1080 });
  assert.deepEqual(cropRect(3840, 2160, { zoom: 2, x: 0.75, y: 0.5 }), { x: 1920, y: 540, width: 1920, height: 1080 });
  assert.deepEqual(normalizeView({ zoom: 1, x: -10, y: 20 }), { zoom: 1, x: 0.5, y: 0.5 });
  assert.throws(() => normalizeView({ zoom: NaN, x: 0.5, y: 0.5 }));
  for (const width of [1920, 3840, 2592]) for (const height of [1080, 1944, 2160]) for (const zoom of [-1, 1, 2.4, 8, 100]) for (const x of [-1, 0, 0.9, 2]) {
    const r = cropRect(width, height, { zoom, x, y: x }); assert.ok(r.x >= -0.00001 && r.y >= -0.00001); assert.ok(r.x + r.width <= width + 0.00001 && r.y + r.height <= height + 0.00001);
  }
});
