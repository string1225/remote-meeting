import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { localStack, mediaLaunchOptions, remotePage, connectRemote, startCameras, duplex } from './browser-fixture.mjs';

const folder = await mkdtemp(join(tmpdir(), 'meeting-device-ui-')), file = join(folder, 'devices.json');
const stack = await localStack({ deviceSettingsFile: file }), browser = await chromium.launch(mediaLaunchOptions);
const openSettings = async () => { await stack.host.locator('#view-cameras').click(); await stack.host.locator('#device-settings summary').click(); await stack.host.waitForFunction(() => !document.querySelector('#device-fields').disabled); };
const save = async () => { await stack.host.locator('#save-devices').click(); await stack.host.waitForFunction(() => !document.querySelector('#device-fields').disabled && document.querySelector('#device-message').textContent.includes('已保存')); };
try {
  await openSettings(); assert.equal(stack.local.hostStatus().capturing, false); assert.equal(stack.local.hostStatus().microphone, false);
  assert.equal(await stack.host.locator('#mirror-main').isChecked(), false); assert.equal(await stack.host.locator('#mirror-secondary').isChecked(), true);
  await stack.host.locator('#main-camera').selectOption('Synthetic camera 1'); await stack.host.locator('#secondary-camera').selectOption('Synthetic camera 0');
  await stack.host.locator('#microphone-device').selectOption('synthetic-440'); await save();
  const saved = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(saved.cameras, ['Synthetic camera 1', 'Synthetic camera 0']);
  assert.equal(stack.local.hostStatus().capturing, false); assert.equal(stack.local.hostStatus().microphone, false);
  await stack.host.reload(); await openSettings();
  assert.equal(await stack.host.locator('#main-camera').inputValue(), 'Synthetic camera 1'); assert.equal(await stack.host.locator('#microphone-device').inputValue(), 'synthetic-440');
  const remote = await remotePage(browser, stack.errors); await connectRemote(remote, stack.url, stack.password); await startCameras(remote); await remote.locator('#host-microphone-toggle').click(); await duplex(remote);
  const pitch = await remote.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    const source = context.createMediaStreamSource(document.querySelector('#remote-audio audio').srcObject), analyser = context.createAnalyser();
    analyser.fftSize = 8192; source.connect(analyser); await new Promise(resolve => setTimeout(resolve, 500));
    const values = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(values);
    let peak = 1; for (let i = 2; i < values.length; i++) if (values[i] > values[peak]) peak = i;
    const frequency = peak * context.sampleRate / analyser.fftSize; source.disconnect(); await context.close(); return frequency;
  }); assert.ok(Math.abs(pitch - 440) < 10, `440 Hz test tone changed to ${pitch} Hz`);
  await stack.host.locator('#main-camera').selectOption('Synthetic camera 0'); await stack.host.locator('#secondary-camera').selectOption('Synthetic camera 1'); await save();
  await stack.host.waitForFunction(() => hostDiagnostics().capturing && hostDiagnostics().microphone); await duplex(remote);
  assert.deepEqual(await stack.host.evaluate(() => testMediaRequests), []);
  assert.equal(stack.local.hostStatus().microphoneStatus.captureRate, 44100); assert.equal(stack.local.hostStatus().microphoneStatus.encodeRate, 48000);
  await stack.host.waitForFunction(() => document.querySelector('#local-preview').naturalWidth > 0 && !document.querySelector('#local-preview').hidden);
  await mkdir('test-results', { recursive: true }); await stack.host.screenshot({ path: 'test-results/device-settings.png', fullPage: true });
  await stack.host.setViewportSize({ width: 390, height: 844 }); assert.equal(await stack.host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await stack.host.screenshot({ path: 'test-results/device-settings-mobile.png', fullPage: true }); assert.deepEqual(stack.errors, []);
  console.log(JSON.stringify({ passed: 'device choices persist, reload, apply live without auto-start; native 44.1kHz stereo -> 48kHz Opus; receive pitch preserved; host never captures in browser', receivedToneHz: pitch }));
} finally { await browser.close(); await stack.close(); await rm(file, { force: true }); await rmdir(folder); }
