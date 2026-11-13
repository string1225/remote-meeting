import { createHmac, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';

// Coturn REST credentials expire after the longest web session (8 hours), with
// an hour of margin. The shared secret never leaves the signaling service.
export function createRelayConfig(env) {
  const urls = (env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!urls.length || urls.some(url => !/^turns?:[a-zA-Z0-9.[\]:-]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/.test(url))) throw new Error('TURN_URLS must contain authenticated TURN relay URLs');
  if (typeof env.TURN_SECRET !== 'string' || env.TURN_SECRET.length < 32 || env.TURN_SECRET.startsWith('replace-')) throw new Error('TURN_SECRET must contain at least 32 random characters shared with coturn');
  if (env.ICE_TRANSPORT_POLICY && env.ICE_TRANSPORT_POLICY !== 'relay') throw new Error('Only ICE_TRANSPORT_POLICY=relay is supported');
  let hostMedia;
  if (env.HOST_MEDIA_UDP_ADDRESS) {
    const address = env.HOST_MEDIA_UDP_ADDRESS, port = Number(env.HOST_MEDIA_UDP_PORT), bandwidthMbps = Number(env.HOST_MEDIA_BANDWIDTH_MBPS || 10);
    if (!isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(bandwidthMbps) || bandwidthMbps < 1 || bandwidthMbps > 1000) throw new Error('Invalid HOST_MEDIA_UDP configuration');
    hostMedia = { transport: 'udp', address, port, bandwidthMbps };
  }
  return () => {
    const username = `${Math.floor(Date.now() / 1000) + 9 * 3600}:${randomBytes(12).toString('hex')}`;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    return { mediaTransport: 'relay', iceTransportPolicy: 'relay', iceServers: [{ urls, username, credential }], ...(hostMedia ? { hostMedia } : {}) };
  };
}

export const isRelayCandidate = candidate => /\styp relay(?:\s|$)/.test(candidate);
export const relaySdp = sdp => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || isRelayCandidate(line)).join('\r\n');

export function mediaCandidate(candidate, hostMedia, agent = false) {
  if (!hostMedia || hostMedia.transport !== 'udp') return isRelayCandidate(candidate);
  const parts = candidate.trim().split(/\s+/);
  if (parts[2]?.toLowerCase() !== 'udp' || !['host', 'srflx', 'prflx'].includes(parts[7])) return false;
  return !agent || parts[4] === hostMedia.address && Number(parts[5]) === hostMedia.port && parts[7] === 'host';
}
export const mediaSdp = (sdp, hostMedia, agent) => sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || mediaCandidate(line, hostMedia, agent)).join('\r\n');
