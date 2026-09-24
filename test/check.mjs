import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const dir of ['server', 'public', 'host', 'test']) for (const name of await readdir(dir)) {
  if (!/\.(js|mjs)$/.test(name)) continue;
  const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log('PASS: JavaScript syntax checks.');
