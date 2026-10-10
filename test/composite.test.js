import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositeSettings, coverRect, pipRect } from '../host/composite.js';
import { selectCameras } from '../host/capture.js';

test('1080p/30 defaults and bounded configurable output', () => {
  assert.deepEqual(compositeSettings(), { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(compositeSettings({ width: 1920, fps: 120 }), { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(compositeSettings({ width: 8160, fps: -1 }), { width: 1920, height: 1080, fps: 5 });
  assert.deepEqual(compositeSettings({ width: 1280, fps: 15 }), { width: 1280, height: 720, fps: 15 });
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
test('USB precedes the integrated front camera regardless of enumeration order', () => {
  const device = (label, deviceId) => ({ label, deviceId, kind: 'videoinput' });
  const devices = [device('Surface Camera Rear', 'rear'), device('Surface IR', 'ir'), device('Surface Camera Front', 'front'), device('PC Camera (USB)', 'usb')];
  assert.deepEqual(selectCameras(devices).map(d => d.deviceId), ['usb', 'front']);
  assert.deepEqual(selectCameras(devices, ['PC Camera (USB)', 'Surface Camera Rear']).map(d => d.deviceId), ['usb', 'rear']);
  assert.throws(() => selectCameras(devices, ['PC Camera (USB)', 'PC Camera (USB)']));
  assert.throws(() => selectCameras([devices[2]]));
});
