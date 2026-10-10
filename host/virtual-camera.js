import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { compositeSettings } from './composite.js';

export function createVirtualCamera(config = {}, publish = () => {}, acknowledge = () => {}) {
  config ||= {};
  let child, settings, ready = false, busy = false, timer, state;
  function update(next, message = '', device = '') { state = next; publish({ type: 'virtual-camera-state', state: next, message, device }); }
  function stop() {
    clearTimeout(timer); const old = child; child = null; ready = busy = false;
    old?.stdin.destroy(); old?.kill(); update('stopped');
  }
  return {
    start(output) {
      stop(); settings = compositeSettings(output);
      if (config.enabled === false) { update('disabled'); return; }
      update('starting');
      const process = spawn(config.pythonPath || resolve('.local/virtual-camera/Scripts/python.exe'),
        ['-u', fileURLToPath(new URL('./virtual-camera.py', import.meta.url)), String(settings.width), String(settings.height), String(settings.fps)],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = process;
      const lines = createInterface({ input: process.stdout });
      lines.on('line', line => {
        if (child !== process) return;
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') { clearTimeout(timer); ready = true; update('ready', '', message.device); acknowledge(); }
          else if (message.type === 'frame') { busy = false; acknowledge(); }
          else if (message.type === 'error') { ready = false; update('error', message.message); }
        } catch { /* Only structured worker status is used. */ }
      });
      let diagnostics = '';
      process.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-1000); });
      process.stdin.on('error', () => {});
      process.on('error', error => { if (child === process) { clearTimeout(timer); ready = false; update('error', `无法启动虚拟摄像头：${error.message}`); } });
      process.on('exit', code => { if (child === process) { clearTimeout(timer); child = null; ready = false; if (state !== 'error') update('error', diagnostics || `虚拟摄像头进程退出 (${code})`); } });
      timer = setTimeout(() => { if (child === process && !ready) { stop(); update('error', '虚拟摄像头启动超时，请检查 Python 和 OBS 驱动'); } }, 10000);
    },
    frame(data) {
      if (!ready || busy || data.length !== settings.width * settings.height * 4) return false;
      busy = true; child.stdin.write(data); return true;
    },
    stop
  };
}
