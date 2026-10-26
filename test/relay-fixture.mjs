import { fork } from 'node:child_process';
import { once } from 'node:events';

export const relayTestEnv = { TURN_URLS: 'turn:127.0.0.1:9?transport=udp', TURN_SECRET: 'unit-test-turn-secret-at-least-32-characters', ICE_TRANSPORT_POLICY: 'relay' };

// An authenticated, loopback-only test relay. Production uses coturn on 139.
export async function testRelay() {
  const child = fork(new URL('./turn-fixture.mjs', import.meta.url), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [env] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Test TURN server failed to start'); })]);
    return { env, async close() { if (child.exitCode !== null) return; const closed = once(child, 'exit'); child.kill(); await closed; } };
  } finally { clearTimeout(timer); }
}
