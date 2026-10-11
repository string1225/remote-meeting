import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualCamera } from '../host/virtual-camera.js';

test('missing native camera runtime surfaces an error; stop remains safe', async () => {
  const events = []; let camera;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing worker failure status')), 3000);
    camera = createVirtualCamera({ pythonPath: 'missing-remote-meeting-python-runtime' }, message => {
      events.push(message); if (message.state === 'error') { clearTimeout(timeout); resolve(); }
    });
    camera.start({ width: 1280, fps: 15 });
    assert.equal(camera.setView({ zoom: 1, x: 0.5, y: 0.5 }), false);
  });
  assert.match(events.at(-1).message, /无法启动/);
  await camera.stop(); assert.equal(events.at(-1).state, 'stopped');
});
