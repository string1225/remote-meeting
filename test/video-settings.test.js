import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostService } from '../host/service.js';
import { createVideoSettings, validateVideoProfile } from '../host/video-settings.js';

test('video profiles persist; switching applies video only and rejects foreign or invalid requests', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'meeting-video-')), file = join(folder, 'video.json');
  t.after(async () => { await rm(file, { force: true }); await rmdir(folder); });
  assert.equal(createVideoSettings(file).profile, '720p20');
  for (const value of ['__proto__', '1080p30', null, {}]) assert.throws(() => validateVideoProfile(value));
  const calls = [];
  const config = { serverUrl: 'http://127.0.0.1:9/', agentKey: 'video-settings-test-machine-key-32-characters', videoSettingsFile: file, output: { profile: '720p20' } };
  let server = createHostService(config, { cameraFactory: () => ({ applyVideo: output => calls.push(output), microphone: () => assert.fail('Video changes must not restart audio'), shutdown() {} }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.shutdown());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const set = (profile, requestOrigin = origin) => fetch(origin + '/api/video', { method: 'PUT', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', 'X-Host-Console': '1' }, body: JSON.stringify({ profile }) });
  assert.equal((await set('480p30', 'https://attacker.example')).status, 403);
  assert.equal((await set('1080p30')).status, 400);
  for (const profile of ['480p30', '720p20', '1080p10']) {
    assert.equal((await set(profile)).status, 200);
    assert.equal(server.hostStatus().output.profile, profile);
    assert.equal(createVideoSettings(file).profile, profile);
    assert.equal(server.hostStatus().capturing, false);
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], { width: 1920, height: 1080, fps: 10, profile: '1080p10' });
  await server.shutdown();
  server = createHostService(config, { cameraFactory: () => ({ shutdown() {} }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  assert.equal(server.hostStatus().output.profile, '1080p10');
});
