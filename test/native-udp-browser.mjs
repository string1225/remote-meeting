import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchOptions } from './browser-fixture.mjs';

// Model FRP's public socket and its per-client local UDP forwarding sockets.
const forward = dgram.createSocket('udp4'), reserve = dgram.createSocket('udp4');
forward.bind(0, '127.0.0.1'); reserve.bind(0, '127.0.0.1');
await Promise.all([once(forward, 'listening'), once(reserve, 'listening')]);
const publicPort = forward.address().port, localPort = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const sessions = new Map();
forward.on('message', (data, addr) => {
  const key = `${addr.address}:${addr.port}`;
  let session = sessions.get(key);
  if (!session) {
    session = dgram.createSocket('udp4'); sessions.set(key, session);
    session.on('message', reply => forward.send(reply, addr.port, addr.address));
  }
  session.send(data, localPort, '127.0.0.1');
});
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', req.url === '/rtc.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/rtc.js' ? await readFile(new URL('../public/rtc.js', import.meta.url)) : '<!doctype html><video autoplay muted playsinline></video>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const worker = spawn('.local/virtual-camera/Scripts/python.exe', ['-u', 'host/rtc-worker.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const send = data => worker.stdin.write(JSON.stringify(data) + '\n');
const media = { transport: 'udp', address: '127.0.0.1', port: publicPort, bandwidthMbps: 10 };
const hardware = process.env.RTC_HARDWARE === '1';
const devices = hardware ? JSON.parse(await readFile('.local/devices.json', 'utf8')) : {};
send({ ...devices, synthetic: !hardware, diagnostics: true, encoder: 'auto', output: { profile: '1080p30', width: 1920, height: 1080, fps: 30 }, hostMedia: media, udpPort: localPort });
const pages = new Map(), messages = [], failures = [], errors = [];
worker.stderr.on('data', chunk => errors.push(chunk.toString().slice(-1000)));
createInterface({ input: worker.stdout }).on('line', line => {
  const msg = JSON.parse(line); messages.push(msg);
  if (msg.type === 'worker-error') failures.push(msg);
  if (msg.type === 'camera-state' && msg.state === 'error') failures.push(msg.message);
  if (msg.type === 'signal') void pages.get(msg.to)?.evaluate(data => window.rtc.signal('host', data), msg.data).catch(error => failures.push(error.message));
});
let browser;
async function viewer(id) {
  const page = await browser.newPage(); pages.set(id, page);
  page.on('pageerror', error => failures.push(error.message));
  await page.exposeFunction('sendNative', message => { if (message.type === 'signal') send({ type: 'signal', id, data: message.data }); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async ({ id, media }) => {
    const { MeetingRTC } = await import('/rtc.js');
    const stream = new MediaStream(), video = document.querySelector('video'); video.srcObject = stream;
    window.rtc = new MeetingRTC({ channel: 'host-media', send: window.sendNative, onTrack: (_, track) => { stream.addTrack(track); void video.play(); } });
    window.rtc.configure({ id, role: 'remote' }, [], media);
    window.rtc.add({ id: 'host', role: 'host' });
    setInterval(() => void window.rtc.stats(), 500);
    window.sample = async () => { await window.rtc.stats(); return { stats: window.rtc.lastStats, width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames, currentTime: video.currentTime, time: performance.now() }; };
  }, { id, media });
  send({ type: 'peer-add', id });
  await page.waitForFunction(hardware => { const video = document.querySelector('video'); return video.videoWidth === 1920 && video.videoHeight === 1080 && video.getVideoPlaybackQuality().totalVideoFrames > 30 && (hardware || window.rtc.lastStats?.[0]?.receivedAudio > 0); }, hardware, { timeout: 45000, polling: 250 });
  return page;
}
try {
  browser = await chromium.launch({ ...launchOptions, args: [...launchOptions.args, '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  send({ type: 'camera-start' }); if (!hardware) send({ type: 'microphone-start' });
  const first = await viewer('first');
  await first.waitForFunction(() => document.querySelector('video').currentTime > 20, null, { timeout: 35000 });
  const before = await first.evaluate(() => window.sample());
  await first.waitForFunction(start => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames >= start + 150, before.frames, { timeout: 15000 });
  const after = await first.evaluate(() => window.sample());
  const fps = (after.frames - before.frames) * 1000 / (after.time - before.time);
  assert.ok(fps >= 24, `Expected 1080p30, measured ${fps.toFixed(1)} fps: ${JSON.stringify(after.stats)}`);
  assert.equal(after.stats[0].transport, 'frp-udp');
  assert.equal(after.stats[0].remotePort, publicPort);
  const second = await viewer('second');
  send({ type: 'peer-remove', id: 'first' }); await first.close(); pages.delete('first');
  const surviving = await second.evaluate(() => window.sample());
  await second.waitForFunction(start => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames >= start + 45, surviving.frames, { timeout: 10000 });
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ check: 'native-frp-udp', hardware, dimensions: [after.width, after.height], fps: Math.round(fps * 10) / 10, selected: after.stats[0], concurrentViewers: 2, sharedPortSurvivesDisconnect: true, cameras: messages.find(m => m.type === 'camera-state' && m.state === 'ready')?.cameras, metrics: messages.filter(m => m.type === 'metrics').slice(-2) }));
} catch (error) {
  console.error(JSON.stringify({ failures, viewers: await Promise.all([...pages.values()].map(page => page.evaluate(() => window.sample()).catch(() => null))), diagnostics: errors.slice(-3), cameras: messages.filter(m => m.type === 'camera-state'), metrics: messages.filter(m => m.type === 'metrics').slice(-6), recent: messages.filter(m => m.type !== 'preview').slice(-6) }));
  throw error;
} finally {
  await browser?.close(); worker.stdin.end();
  const timer = setTimeout(() => worker.kill(), 6000); await once(worker, 'close'); clearTimeout(timer);
  for (const session of sessions.values()) session.close();
  await new Promise(resolve => forward.close(resolve)); await new Promise(resolve => server.close(resolve));
}
