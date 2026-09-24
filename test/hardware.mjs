// Opt-in real device acceptance: no external participants; media remains local.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, launchOptions, remotePage, connectRemote, setView } from './browser-fixture.mjs';
const stack = await localStack({ hardware: true });
const browser = await chromium.launch({ ...launchOptions, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const remote = await remotePage(browser, stack.errors);
  assert.equal(await stack.host.evaluate(() => window.testTracks.length), 0);
  await connectRemote(remote, stack.url, stack.password);
  await remote.waitForFunction(() => document.querySelectorAll('#host-videos video').length === 2 && [...document.querySelectorAll('#host-videos video')].every(v => [720,1080].includes(v.videoHeight) && v.videoWidth === v.videoHeight * 16 / 9 && v.readyState >= 2), null, { timeout: 60000 });
  const devices = await stack.host.evaluate(() => { const d = window.hostDiagnostics(); return { cameras: d.capture.sources.map(s => ({ label: s.label, actual: { width:s.settings.width,height:s.settings.height,fps:s.settings.frameRate }, capabilities: { width:s.capabilities.width,height:s.capabilities.height } })), microphone: d.capture.audio.getAudioTracks()[0].label }; });
  const received = await remote.locator('#host-videos video').evaluateAll(videos => videos.map(v => ({ width: v.videoWidth, height: v.videoHeight })));
  assert.deepEqual(received, [{width:1920,height:1080},{width:1280,height:720}]);
  console.log(JSON.stringify({ ...devices, received }, null, 2));
  await setView(remote, 0, 2, 0.25); await setView(remote, 1, 2, 0.75);
  await stack.host.waitForFunction(() => [...window.hostDiagnostics().peers.values()][0].media.filter(m=>m.kind==='video').every(m=>m.view.zoom===2));
  assert.equal(await stack.host.evaluate(() => { const d=window.hostDiagnostics(); return [...d.peers.values()].every(p=>p.pc.getSenders().filter(s=>s.track?.kind==='video').every(s=>!d.capture.sources.some(c=>c.stream.getVideoTracks().includes(s.track)))); }), true);
  await remote.locator('#leave').click();
  await stack.host.waitForFunction(() => window.hostDiagnostics().capture === null && window.testTracks.every(t=>t.readyState==='ended'));
  assert.deepEqual(stack.errors, []);
  console.log('PASS: actual dual-camera highest-resolution capture, microphone, 1080p + native 720p source crops received over WebRTC, and idle device release.');
} catch (e) { console.error(await stack.host.locator('#error').textContent()); throw e; }
finally { await browser.close(); await stack.close(); }
