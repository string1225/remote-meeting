import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { launchOptions } from './browser-fixture.mjs';

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', req.url === '/rtc.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/rtc.js' ? await readFile(new URL('../public/rtc.js', import.meta.url)) : '<!doctype html><title>Relay unavailable acceptance</title>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const { MeetingRTC } = await import('/rtc.js');
    const host = { id: 'host', role: 'host' }, remote = { id: 'remote', role: 'remote' };
    const servers = [{ urls: 'turn:127.0.0.1:9?transport=udp', username: 'test', credential: 'test' }];
    const a = new MeetingRTC({ channel: 'remote-media', initiate: true, send: msg => b.signal(host.id, msg.data) });
    const b = new MeetingRTC({ channel: 'remote-media', receive: false, send: msg => a.signal(remote.id, msg.data) });
    a.configure(host, servers); b.configure(remote, servers);
    const first = a.add(remote), second = b.add(host);
    try {
      await first.queue;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 60000);
        first.pc.addEventListener('icegatheringstatechange', () => { if (first.pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
      });
      return [first, second].map(({ pc }) => ({ policy: pc.getConfiguration().iceTransportPolicy, state: pc.connectionState, candidates: (pc.localDescription?.sdp || '').split('\r\n').filter(line => line.startsWith('a=candidate:')) }));
    } finally { a.clear(); b.clear(); }
  });
  for (const peer of result) { assert.equal(peer.policy, 'relay'); assert.notEqual(peer.state, 'connected'); assert.deepEqual(peer.candidates, []); }
  console.log('PASS: unreachable TURN on the same LAN produces no direct browser ICE candidates and no P2P connection.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
