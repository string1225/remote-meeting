import { createHmac, randomBytes } from 'node:crypto';

// Coturn REST credentials expire after the longest web session (8 hours), with
// an hour of margin. The shared secret never leaves the signaling service.
export function createRelayConfig(env) {
  const urls = (env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!urls.length || urls.some(url => !/^turns?:[a-zA-Z0-9.[\]:-]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/.test(url))) throw new Error('TURN_URLS must contain authenticated TURN relay URLs');
  if (typeof env.TURN_SECRET !== 'string' || env.TURN_SECRET.length < 32 || env.TURN_SECRET.startsWith('replace-')) throw new Error('TURN_SECRET must contain at least 32 random characters shared with coturn');
  if (env.ICE_TRANSPORT_POLICY && env.ICE_TRANSPORT_POLICY !== 'relay') throw new Error('Only ICE_TRANSPORT_POLICY=relay is supported');
  return () => {
    const username = `${Math.floor(Date.now() / 1000) + 9 * 3600}:${randomBytes(12).toString('hex')}`;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    return { mediaTransport: 'relay', iceTransportPolicy: 'relay', iceServers: [{ urls, username, credential }] };
  };
}

export const isRelayCandidate = candidate => /\styp relay(?:\s|$)/.test(candidate);
export const relaySdp = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || isRelayCandidate(line)).join('\r\n');
