import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createHostService } from './service.js';

const config = JSON.parse(await readFile(resolve(process.env.HOST_CONFIG || '.local/host.json'), 'utf8'));
config.deviceSettingsFile = resolve(config.deviceSettingsFile || '.local/devices.json');
config.videoSettingsFile = resolve(config.videoSettingsFile || '.local/video.json');
await mkdir('.local', { recursive: true });
async function log(message) { const line = `${new Date().toISOString()} ${message}\n`; console.log(line.trim()); await appendFile('.local/host.log', line); }
const server = createHostService(config);
server.on('cloud-state', state => void log(`Cloud ${state.state}${state.lastError ? ': ' + state.lastError : ''}`).catch(() => {}));
server.listen(config.port || 3034, '127.0.0.1'); await once(server, 'listening');
await log(`Host listener ready on 127.0.0.1:${server.address().port}`);
let stopping = false, browser;
async function stop(signal) { if (stopping) return; stopping = true; await log('Host shutting down after ' + signal).catch(() => {}); await browser?.close().catch(() => {}); await server.shutdown(); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(signal));
while (!stopping) {
  try {
    browser = await chromium.launch({ ...(config.browserPath ? { executablePath: config.browserPath } : { channel: 'msedge' }), headless: config.headless === true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ignoreDefaultArgs: ['--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', e => void log(`Renderer error: ${e.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await log('Local meeting window opened; waiting for authenticated remotes.');
    await Promise.race([once(browser, 'disconnected'), once(page, 'close'), once(page, 'crash')]);
    await browser.close().catch(() => {});
  } catch (error) { await log(`Host renderer restarting: ${error.message}`); }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, 2000));
}
