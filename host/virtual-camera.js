import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { compositeSettings } from './composite.js';

export function createVirtualCamera(config = {}, publish = () => {}) {
  config ||= {};
  let child, timer, state, version = 0, closing = Promise.resolve();
  const update = (next, message = '', extra = {}) => { state = next; publish({ type: 'virtual-camera-state', state: next, message, ...extra }); };
  async function closeChild() {
    clearTimeout(timer);
    const old = child; child = null;
    if (!old) return closing;
    const released = new Promise(resolve => {
      if (old.exitCode !== null || old.signalCode !== null) { resolve(); return; }
      let forced;
      const kill = setTimeout(() => {
        if (process.platform === 'win32') {
          // A Windows venv uses a launcher process; release its entire owned tree.
          const killer = spawn('taskkill', ['/PID', String(old.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          forced = new Promise(done => { killer.once('close', done); killer.once('error', () => { old.kill(); done(); }); });
        } else old.kill('SIGKILL');
      }, 2000);
      old.once('close', () => { clearTimeout(kill); Promise.resolve(forced).then(resolve); });
      old.stdin.end();
    });
    closing = Promise.all([closing, released]).then(() => {});
    return closing;
  }
  return {
    async start(output) {
      const generation = ++version;
      update('starting'); await closeChild();
      if (version !== generation) return;
      if (config.enabled === false) { update('disabled'); return; }
      const settings = compositeSettings(output);
      const process = spawn(config.pythonPath || resolve('.local/virtual-camera/Scripts/python.exe'),
        ['-u', fileURLToPath(new URL('./virtual-camera.py', import.meta.url)), String(settings.width), String(settings.height), String(settings.fps)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = process;
      let diagnostics = '';
      createInterface({ input: process.stdout }).on('line', line => {
        if (child !== process) return;
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') { clearTimeout(timer); update('ready', '', { device: message.device, cameras: message.cameras }); }
          else if (message.type === 'viewport-applied' || message.type === 'metrics') publish(message);
          else if (message.type === 'error') { clearTimeout(timer); update('error', message.message); }
        } catch { /* Ignore non-structured diagnostics. */ }
      });
      process.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-1000); });
      process.stdin.on('error', () => {});
      process.on('error', error => { if (child === process) { clearTimeout(timer); update('error', '无法启动虚拟摄像头：' + error.message); } });
      process.on('close', code => {
        if (child !== process) return;
        clearTimeout(timer); child = null;
        if (state !== 'error') update('error', diagnostics || '虚拟摄像头进程退出 (' + code + ')');
      });
      process.stdin.write(JSON.stringify({ cameras: config.cameras || [], synthetic: config.synthetic === true }) + '\n');
      timer = setTimeout(() => {
        if (child !== process || state !== 'starting') return;
        void closeChild().then(() => { if (version === generation) update('error', '摄像头启动超时，请检查设备占用和 Windows 原生虚拟摄像头安装'); });
      }, 30000);
    },
    setView(view) {
      if (!child || state !== 'ready') return false;
      child.stdin.write(JSON.stringify({ type: 'viewport', ...view }) + '\n'); return true;
    },
    async stop() {
      const generation = ++version; update('stopping'); await closeChild();
      if (version === generation) update('stopped');
    }
  };
}
