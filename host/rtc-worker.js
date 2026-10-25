import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export function createRtcWorker(config, publish) {
  let child, preview, stopping, iceServers = [], settings = config.output;
  const peers = new Set();
  function ensure() {
    if (child) return;
    const process = spawn(config.pythonPath || resolve('.local/virtual-camera/Scripts/python.exe'), ['-u', fileURLToPath(new URL('./rtc-worker.py', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = process; let diagnostics = '';
    process.stdin.on('error', () => {});
    process.stdin.write(JSON.stringify({ ...config, output: settings, iceServers }) + '\n');
    createInterface({ input: process.stdout }).on('line', line => {
      if (child !== process) return;
      try {
        const data = JSON.parse(line);
        if (data.type === 'preview') preview = data.jpeg ? Buffer.from(data.jpeg, 'base64') : null;
        else publish(data.type === 'camera-state' ? { ...data, type: 'virtual-camera-state', device: 'Native WebRTC' } : data);
      } catch { /* Native diagnostics are separate from signaling. */ }
    });
    process.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-1500); });
    const fail = message => { preview = null; publish({ type: 'virtual-camera-state', state: 'error', message }); publish({ type: 'microphone-state', state: 'error', message }); };
    process.on('error', error => fail('本地媒体后端无法启动：' + error.message));
    process.on('close', () => { if (child !== process) return; child = null; if (!stopping) fail(diagnostics || '本地媒体后端已退出，请重试连接'); });
  }
  function send(data) { ensure(); if (child?.stdin.writable) child.stdin.write(JSON.stringify(data) + '\n'); }
  return {
    configure(servers) { iceServers = servers || []; },
    start(output) { settings = output; send({ type: 'camera-start' }); },
    stop() { if (child) send({ type: 'camera-stop' }); },
    microphone(enabled) { send({ type: enabled ? 'microphone-start' : 'microphone-stop' }); },
    setView(view) { send({ type: 'viewport', ...view }); },
    peerAdd(id) { if (!peers.has(id)) { peers.add(id); send({ type: 'peer-add', id }); } },
    peerRemove(id) { if (peers.delete(id) && child) send({ type: 'peer-remove', id }); },
    signal(id, data) { if (peers.has(id)) send({ type: 'signal', id, data }); },
    get preview() { return preview; },
    async shutdown() {
      stopping = true; const old = child; child = null; preview = null; if (!old) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { const killer = spawn('taskkill', ['/PID', String(old.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => old.kill()); }, 6000);
        old.once('close', () => { clearTimeout(timer); resolve(); }); old.stdin.end();
      });
    }
  };
}
