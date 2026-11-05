import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const fakeHost = `
import http from 'node:http';
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync('.local/host.json', 'utf8'));
try { fs.unlinkSync('.local/hang'); } catch {}
fs.appendFileSync('.local/starts', process.pid + '\\n');
http.createServer((req, res) => {
  if (req.url === '/exit') { res.end('exiting'); setTimeout(() => process.exit(7), 20); return; }
  if (fs.existsSync('.local/hang')) return;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ service: 'remote-meeting-host', processId: process.pid, online: false, renderer: true, output: {} }));
}).listen(config.port, '127.0.0.1');
`;

async function poll(check, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  assert.fail('Timed out waiting for the isolated supervisor fixture');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'meeting-supervisor-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await mkdir(join(root, 'host')); await mkdir(join(root, '.local'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'host/index.js'), fakeHost);
  await copyFile(new URL('../host/run.ps1', import.meta.url), join(root, 'host/run.ps1'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const children = [];
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
  };
  t.after(async () => {
    for (const child of children.reverse()) await stop(child);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  function startGuard() {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'host/run.ps1'), '-HealthCheckSeconds', '1', '-RestartDelaySeconds', '1', '-HealthFailureLimit', '2'], { cwd: root, windowsHide: true, stdio: 'ignore' });
    children.push(child); return child;
  }
  return {
    root, startGuard,
    async configure() { await writeFile(join(root, '.local/host.json'), JSON.stringify({ port, nodePath: process.execPath })); },
    async log() { return readFile(join(root, '.local/supervisor.log'), 'utf8'); },
    async status() { return (await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(400) })).json(); },
    async starts() { return (await readFile(join(root, '.local/starts'), 'utf8')).trim().split('\n'); },
    async crash() { await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(1000) }); },
    async hang() { await writeFile(join(root, '.local/hang'), '1'); },
    startExternal() { const child = spawn(process.execPath, ['host/index.js'], { cwd: root, windowsHide: true, stdio: 'ignore' }); children.push(child); return child; },
    stop
  };
}

test('login guard retries startup failures, avoids duplicates and recovers crashed or hung owned hosts', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const f = await fixture(t);
  f.startGuard();
  await poll(async () => (await f.log()).includes('Supervisor retry:'));
  await f.configure();
  const first = await poll(() => f.status());
  const duplicate = f.startGuard();
  const [exitCode] = await once(duplicate, 'exit');
  assert.equal(exitCode, 0);
  assert.equal((await f.starts()).length, 1);
  // An ordinary cloud outage is not a reason to restart working local devices.
  await delay(2500);
  assert.equal((await f.status()).processId, first.processId);
  await f.crash();
  const second = await poll(async () => { const s = await f.status(); return s.processId !== first.processId && s; });
  assert.ok((await f.log()).includes('exitCode=7'), (await f.log()).slice(-1800));
  await f.hang();
  const third = await poll(async () => { const s = await f.status(); return s.processId !== second.processId && s; }, 15000);
  assert.notEqual(third.processId, second.processId);
  assert.ok((await f.log()).includes('Restarting unresponsive owned host'));
});

test('a login guard adopts an existing listener and starts a host when that listener exits', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = await fixture(t); await f.configure();
  const external = f.startExternal();
  const first = await poll(() => f.status());
  f.startGuard();
  await poll(async () => (await f.log()).includes('Existing host found'));
  assert.equal((await f.starts()).length, 1);
  await f.stop(external);
  await poll(async () => { const s = await f.status(); return s.processId !== first.processId; });
  assert.equal((await f.starts()).length, 2);
});
