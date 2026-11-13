import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, startCameras } from './browser-fixture.mjs';

const stack = await localStack(), browser = await chromium.launch(mediaLaunchOptions);
try {
  const a = await remotePage(browser, stack.errors);
  await connectRemote(a, stack.url, stack.password);
  await a.locator('#video-profile').selectOption('480p30');
  assert.equal(stack.local.hostStatus().capturing, false);
  await a.locator('#host-microphone-toggle').click(); await startCameras(a);
  await a.waitForFunction(() => window.meetingStats().some(p => p.receivedAudio > 1000 && p.receivedVideo > 10));
  await stack.host.waitForFunction(() => hostDiagnostics().virtualCamera.videoCeiling === 2200000);
  // Deliberately supply a 1080p source to exercise the actual sender limit,
  // even if a browser or a replacement camera ignores capture constraints.
  await a.evaluate(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = options => capture(options.video ? { ...options, video: { width: { exact: 1920 }, height: { exact: 1080 }, frameRate: 15 } } : options);
  });
  await a.locator('#camera-toggle').click(); await a.locator('#microphone-toggle').click();
  await stack.host.waitForFunction(() => hostDiagnostics().peers.some(p => p.media?.video && p.returnReceiver?.width > 0 && p.returnReceiver?.receivedAudio > 1000));
  const reverse = await a.evaluate(() => {
    const sender = window.testPeers.flatMap(pc => pc.getSenders()).find(s => s.track?.kind === 'video');
    return { source: sender.track.getSettings(), encoding: sender.getParameters().encodings[0] };
  });
  assert.equal(reverse.source.width, 1920); assert.equal(reverse.source.height, 1080);
  assert.equal(reverse.encoding.scaleResolutionDownBy, 1.5); assert.equal(reverse.encoding.maxBitrate, 2000000);
  await stack.host.waitForFunction(() => {
    const s = hostDiagnostics(), r = s.peers[0]?.returnReceiver;
    return s.virtualCamera.videoCeiling === 1500000 && s.virtualCamera.targetBitrate <= 1500000 && r?.width > 0 && r.width <= 1280 && r.height <= 720 && r?.receivedVideo > 10;
  });
  const audioTrack = await a.evaluate(() => window.testPeers.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === 'audio').track.id);
  for (const [profile, width, height, fps] of [['720p20', 1280, 720, 20], ['1080p10', 1920, 1080, 10], ['1080p30', 1920, 1080, 30], ['480p30', 854, 480, 30]]) {
    const audioBefore = await a.evaluate(() => window.meetingStats().find(p => p.receivedAudio)?.receivedAudio || 0);
    await stack.host.locator('#video-profile').selectOption(profile);
    await a.waitForFunction(profile => document.querySelector('#video-profile').value === profile, profile);
    await stack.host.waitForFunction(({ width, height, fps }) => {
      const state = hostDiagnostics(); return state.capturing && state.virtualCamera.output.width === width && state.virtualCamera.output.height === height && state.output.fps === fps;
    }, { width, height, fps });
    await a.waitForFunction(bytes => window.meetingStats().some(p => p.receivedAudio > bytes + 1000), audioBefore);
    assert.equal(stack.local.hostStatus().microphone, true);
    assert.equal(await a.evaluate(() => window.testPeers.flatMap(pc => pc.getReceivers()).find(r => r.track.kind === 'audio').track.id), audioTrack);
  }
  await stack.host.waitForFunction(() => hostDiagnostics().peers.some(p => p.receiver?.incomingKbps > 0));
  await a.locator('#camera-toggle').click();
  await stack.host.waitForFunction(() => hostDiagnostics().peers[0]?.media?.video === false && hostDiagnostics().virtualCamera.videoCeiling === 2200000);
  assert.equal(stack.local.hostStatus().microphone, true);
  await a.locator('#camera-toggle').click();
  await stack.host.waitForFunction(() => hostDiagnostics().peers[0]?.media?.video === true && hostDiagnostics().virtualCamera.videoCeiling === 1500000);
  await a.locator('#leave').click(); await a.locator('#join-button').click();
  await a.waitForFunction(() => document.querySelector('#host-camera-toggle').textContent === '启动摄像头' && !document.querySelector('#host-camera-toggle').disabled);
  await startCameras(a);
  await stack.host.waitForFunction(() => hostDiagnostics().peers[0]?.media?.video === false && hostDiagnostics().virtualCamera.videoCeiling === 2200000);
  assert.deepEqual(stack.errors, []);
  console.log('PASS: single-viewer duplex TURN, actual 1080p source encoded within 720p/2 Mbps ceilings, live 1.5/2.2 Mbps allocation on camera toggles and rejoin, and profile changes preserve audio.');
} catch (error) {
  console.error(JSON.stringify({ qualityFailure: stack.local.hostStatus() }));
  throw error;
} finally { await browser.close(); await stack.close(); }
