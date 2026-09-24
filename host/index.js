import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createHostService } from './service.js';

const config = JSON.parse(await readFile(resolve(process.env.HOST_CONFIG || '.local/host.json'), 'utf8'));
await mkdir('.local', { recursive: true });
async function log(message) { const line = `${new Date().toISOString()} ${message}\n`; console.log(line.trim()); await appendFile('.local/host.log', line); }
const server = createHostService(config);
server.listen(config.port || 3034, '127.0.0.1'); await once(server, 'listening');
await log(`Host listener ready on 127.0.0.1:${server.address().port}`);
let stopping = false, browser;
async function stop() { stopping = true; await browser?.close().catch(() => {}); await server.shutdown(); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
while (!stopping) {
  try {
    browser = await chromium.launch({ ...(config.browserPath ? { executablePath: config.browserPath } : { channel: 'msedge' }), headless: config.headless === true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ignoreDefaultArgs: ['--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(['camera', 'microphone'], { origin: `http://127.0.0.1:${server.address().port}` });
    const page = await context.newPage();
    page.on('pageerror', e => void log(`Renderer error: ${e.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await log('Local control window opened; waiting for authenticated remotes.');
    await Promise.race([once(browser, 'disconnected'), once(page, 'close'), once(page, 'crash')]);
    await browser.close().catch(() => {});
  } catch (error) { await log(`Host renderer restarting: ${error.message}`); }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, 2000));
}
