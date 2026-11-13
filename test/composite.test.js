import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositeSettings, coverRect, pipRect } from '../host/composite.js';


test('720p/30 cap also clamps legacy settings and preserves smaller output and aspect ratio', () => {
  assert.deepEqual(compositeSettings(), { width: 1280, height: 720, fps: 30 });
  assert.deepEqual(compositeSettings({ width: 1920, fps: 120 }), { width: 1280, height: 720, fps: 30 });
  assert.deepEqual(compositeSettings({ width: 8160, fps: -1 }), { width: 1280, height: 720, fps: 5 });
  assert.deepEqual(compositeSettings({ width: 1280, fps: 15 }), { width: 1280, height: 720, fps: 15 });
  assert.deepEqual(compositeSettings({ width: 640, height: 480 }), { width: 640, height: 480, fps: 30 });
  assert.deepEqual(compositeSettings({ width: 1600, height: 1200 }), { width: 960, height: 720, fps: 30 });
});
test('main covers the canvas without stretching; PIP stays inside the lower right corner', () => {
  assert.deepEqual(coverRect(1600, 1200, { zoom: 1, x: 0.5, y: 0.5 }, 16 / 9), { x: 0, y: 150, width: 1600, height: 900 });
  for (const zoom of [1, 2, 8]) for (const x of [0, 0.5, 1]) {
    const rect = coverRect(1600, 1200, { zoom, x, y: x }, 16 / 9);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1600 && rect.y + rect.height <= 1200);
    assert.ok(Math.abs(rect.width / rect.height - 16 / 9) < 0.001);
  }
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    const p = pipRect(w, h);
    assert.ok(p.x > w / 2 && p.y > h / 2 && p.x + p.width < w && p.y + p.height < h);
  }
});

test('explicit profiles include 1080p30 while legacy settings keep their cap', () => {
  for (const [profile, width, height, fps] of [['480p30', 854, 480, 30], ['720p20', 1280, 720, 20], ['1080p10', 1920, 1080, 10], ['1080p30', 1920, 1080, 30]]) assert.deepEqual(compositeSettings({ profile }), { width, height, fps, profile });
});
