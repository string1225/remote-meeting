import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostService } from '../host/service.js';
import { createDeviceSettings } from '../host/device-settings.js';

test('device choices persist separately from machine secrets and reload after restarting the local service', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'meeting-devices-')), file = join(folder, 'devices.json');
  t.after(async () => { await rm(file, { force: true }); await rmdir(folder); });
  const key = 'device-preferences-test-machine-key-32-characters';
  const catalog = { cameras: ['USB', 'Front'], microphones: [{ id: 'Windows WASAPI|Mic', name: 'Mic', sampleRate: 48000, channels: 2 }] };
  const applied = [], start = async () => {
    const server = createHostService({ agentKey: key, serverUrl: 'http://127.0.0.1:9/', deviceSettingsFile: file }, { cameraFactory: () => ({ listDevices: async () => catalog, applyDevices: async next => applied.push(next), shutdown: async () => {} }) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (method = 'GET', data, headers = {}) => fetch(origin + (method === 'GET' ? '/api/devices' : '/api/devices/config'), { method, headers: { Origin: origin, 'X-Host-Console': '1', 'Content-Type': 'application/json', ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { server, request };
  };
  let service = await start();
  try {
    assert.equal((await service.request('GET', undefined, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await service.request('GET', undefined, { 'X-Host-Console': '' })).status, 403);
    const initial = await (await service.request()).json(); assert.deepEqual(initial.settings, { cameras: [], microphone: '', mirrorMain: false, mirrorSecondary: true });
    const settings = { cameras: ['Front', 'USB'], microphone: 'Windows WASAPI|Mic', mirrorMain: false, mirrorSecondary: true };
    for (const invalid of [{ ...settings, cameras: ['USB', 'USB'] }, { ...settings, cameras: ['Missing', 'USB'] }, { ...settings, microphone: 'missing' }, { ...settings, agentKey: 'overwrite' }]) assert.equal((await service.request('PUT', invalid)).status, 400);
    assert.equal((await service.request('PUT', settings)).status, 200);
    assert.deepEqual(applied, [settings]); assert.equal(service.server.hostStatus().capturing, false); assert.equal(service.server.hostStatus().microphone, false);
    const content = await readFile(file, 'utf8'); assert.equal(content.includes(key), false); assert.deepEqual(JSON.parse(content), settings);
    await service.server.shutdown(); service = await start();
    assert.deepEqual((await (await service.request()).json()).settings, settings);
  } finally { await service.server.shutdown(); }
});

test('legacy browser labels normalize to native device names without allowing duplicate cameras', () => {
  assert.deepEqual(createDeviceSettings({ fallback: { cameras: ['USB (abcd:1234)', 'Front (abcd:5678)'] } }).value.cameras, ['USB', 'Front']);
  assert.throws(() => createDeviceSettings({ fallback: { cameras: ['USB', 'USB (abcd:1234)'] } }), /不同/);
});
