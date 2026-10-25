import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateDeviceSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['cameras', 'microphone', 'mirrorMain', 'mirrorSecondary'].includes(key))) throw new Error('无效的设备配置');
  if (!Array.isArray(data.cameras) || ![0, 2].includes(data.cameras.length) || data.cameras.some(name => typeof name !== 'string' || !name || name.length > 256)
    || data.cameras.length === 2 && data.cameras[0] === data.cameras[1]) throw new Error('主摄像头和画中画摄像头必须选择不同设备');
  if (typeof data.microphone !== 'string' || data.microphone.length > 512 || typeof data.mirrorMain !== 'boolean' || typeof data.mirrorSecondary !== 'boolean') throw new Error('无效的麦克风或镜像配置');
  const cameras = data.cameras.map(name => name.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''));
  if (cameras.length === 2 && cameras[0] === cameras[1]) throw new Error('主摄像头和画中画摄像头必须选择不同设备');
  return { cameras, microphone: data.microphone, mirrorMain: data.mirrorMain, mirrorSecondary: data.mirrorSecondary };
}
export function createDeviceSettings({ file, fallback }) {
  let value = validateDeviceSettings({ cameras: fallback.cameras || [], microphone: fallback.microphone || '', mirrorMain: false, mirrorSecondary: true });
  if (file) { try { value = validateDeviceSettings(JSON.parse(readFileSync(file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本机设备配置：' + error.message); } }
  return {
    get value() { return structuredClone(value); },
    file,
    async save(next) {
      next = validateDeviceSettings(next);
      if (file) { await mkdir(dirname(file), { recursive: true }); const temp = file + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file); }
      value = next; return structuredClone(value);
    }
  };
}
