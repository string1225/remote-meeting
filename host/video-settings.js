import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { videoProfiles } from './composite.js';

export function validateVideoProfile(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(videoProfiles, profile)) throw new Error('请选择 480p/30帧、720p/20帧或1080p/10帧');
  return profile;
}
export function createVideoSettings(file, fallback = '720p20') {
  let profile = validateVideoProfile(fallback);
  if (file) try { profile = validateVideoProfile(JSON.parse(readFileSync(file, 'utf8')).profile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    get profile() { return profile; },
    async save(next) {
      validateVideoProfile(next);
      if (file) {
        await mkdir(dirname(file), { recursive: true });
        const temp = file + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify({ profile: next }) + '\n', { mode: 0o600 });
        await rename(temp, file);
      }
      profile = next;
    }
  };
}
