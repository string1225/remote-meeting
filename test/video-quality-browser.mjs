import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, startCameras } from './browser-fixture.mjs';

const stack = await localStack(), browser = await chromium.launch(mediaLaunchOptions);
try {
  const a = await remotePage(browser, stack.errors), b = await remotePage(browser, stack.errors);
  await connectRemote(a, stack.url, stack.password); await connectRemote(b, stack.url, stack.password);
  await a.locator('#video-profile').selectOption('480p30');
  await b.waitForFunction(() => document.querySelector('#video-profile').value === '480p30');
  assert.equal(stack.local.hostStatus().capturing, false);
  await a.locator('#host-microphone-toggle').click(); await startCameras(a);
  await a.waitForFunction(() => window.meetingStats().some(p => p.receivedAudio > 1000 && p.receivedVideo > 10));
  const audioTrack = await a.evaluate(() => window.testPeers.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === 'audio').track.id);
  for (const [profile, width, height, fps] of [['720p20', 1280, 720, 20], ['1080p10', 1920, 1080, 10], ['480p30', 854, 480, 30]]) {
    const audioBefore = await a.evaluate(() => window.meetingStats().find(p => p.receivedAudio)?.receivedAudio || 0);
    await stack.host.locator('#video-profile').selectOption(profile);
    await a.waitForFunction(profile => document.querySelector('#video-profile').value === profile, profile);
    await b.waitForFunction(profile => document.querySelector('#video-profile').value === profile, profile);
    await stack.host.waitForFunction(({ width, height, fps }) => {
      const state = hostDiagnostics(); return state.capturing && state.virtualCamera.output.width === width && state.virtualCamera.output.height === height && state.output.fps === fps;
    }, { width, height, fps });
    await a.waitForFunction(bytes => window.meetingStats().some(p => p.receivedAudio > bytes + 1000), audioBefore);
    assert.equal(stack.local.hostStatus().microphone, true);
    assert.equal(await a.evaluate(() => window.testPeers.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === 'audio').track.id), audioTrack);
  }
  await stack.host.waitForFunction(() => hostDiagnostics().peers.some(p => p.receiver?.incomingKbps > 0));
  assert.ok(stack.local.hostStatus().virtualCamera.targetBitrate <= 600000);
  assert.deepEqual(stack.errors, []);
  console.log('PASS: three quality profiles synchronize across host and two viewers; live resolution switches preserve the audio track and continuous audio packets; shared video budget and receiver metrics are active.');
} catch (error) {
  console.error(JSON.stringify({ qualityFailure: stack.local.hostStatus() }));
  throw error;
} finally { await browser.close(); await stack.close(); }
