import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
export async function checkAndRecover(config, { repair = true, localOnly = false, request = fetch, startGuard, restartHost, wait = delay, now = Date.now, recoveryMs = 45000, pollMs = 1500 } = {}) {
  const origin = `http://127.0.0.1:${config.port || 3034}`, actions = [];
  async function inspect() {
    let local, cloud;
    try { const r = await request(origin + '/api/status', { signal: AbortSignal.timeout(3000) }); if (r.ok) local = await r.json(); } catch {}
    if (local?.paused) return { healthy: false, localReachable: true, paused: true };
    if (localOnly && local?.service === 'remote-meeting-host' && local.online && local.renderer) return { healthy: true, localReachable: true, localOnline: true, renderer: true, cloudVerified: false };
    try { const r = await request(new URL('api/agent/status', config.serverUrl), { headers: { Authorization: 'Bearer ' + config.agentKey }, signal: AbortSignal.timeout(6000), redirect: 'error' }); if (r.ok) cloud = await r.json(); } catch {}
    const localReachable = local?.service === 'remote-meeting-host';
    const identityMatches = !local?.cloudConnection?.hostId || !cloud?.hostId || local.cloudConnection.hostId === cloud.hostId;
    return { healthy: Boolean(localReachable && local.online && local.renderer && cloud?.online && identityMatches), localReachable, localOnline: local?.online === true, renderer: local?.renderer === true, cloudReachable: Boolean(cloud), cloudOnline: cloud?.online === true, identityMatches };
  }
  let status = await inspect();
  if (status.paused) return { ...status, actions, skipped: 'Host was paused by the local operator.' };
  if (status.healthy || !repair) return { ...status, actions };
  if (!status.localReachable) { await startGuard?.(); actions.push('start-guard'); }
  else if (status.cloudReachable && (!status.localOnline || !status.cloudOnline || !status.identityMatches)) {
    const response = await request(origin + '/api/connection/reconnect', { method: 'POST', headers: { Origin: origin, 'X-Host-Console': '1' }, signal: AbortSignal.timeout(3000) });
    if (response.ok) actions.push('reconnect-cloud');
  } else if (!status.cloudReachable) return { ...status, actions, reason: 'Cloud status unavailable; local devices were kept running.' };
  async function awaitRecovery() {
    const deadline = now() + recoveryMs;
    do { await wait(pollMs); status = await inspect(); if (status.healthy) return true; } while (now() < deadline);
    return false;
  }
  if (await awaitRecovery()) return { ...status, actions };
  if (status.cloudReachable && (!status.localReachable || !status.renderer) && restartHost) {
    await restartHost(); actions.push('restart-owned-host'); await awaitRecovery();
  }
  return { ...status, actions, reason: status.healthy ? undefined : 'Service recovery did not finish; see host and supervisor logs.' };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await readFile(process.env.HOST_CONFIG || join(root, '.local/host.json'), 'utf8'));
  const run = file => execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'host', file)], { cwd: root, windowsHide: true, timeout: 60000 });
  const localOnly = process.argv.includes('--local-only');
  const result = await checkAndRecover(config, { repair: process.argv.includes('--repair'), localOnly, startGuard: () => run('ensure-started.ps1'), restartHost: () => run('restart.ps1') });
  const entry = { checkedAt: new Date().toISOString(), ...result };
  await mkdir(join(root, '.local'), { recursive: true });
  if (!localOnly || !result.healthy || result.actions.length) await appendFile(join(root, '.local/health-checks.jsonl'), JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry)); process.exitCode = result.healthy || result.skipped ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('Meeting health check failed: ' + error.message); process.exitCode = 1; });
