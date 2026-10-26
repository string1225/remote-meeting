import Turn from 'node-turn';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { relayTestEnv } from './relay-fixture.mjs';

const credentials = new Proxy(Object.create(null), { get: (_, username) => typeof username === 'string' && Number(username.split(':')[0]) > Date.now() / 1000 ? createHmac('sha1', relayTestEnv.TURN_SECRET).update(username).digest('base64') : undefined });
const server = new Turn({ listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials, debugLevel: 'OFF' });
if (process.env.TURN_TEST_DEBUG) server.prependListener('message', msg => console.error(JSON.stringify({ method: msg.method, allocations: Object.keys(server.allocations).length })));
server.network.listeningPort = 0;
server.start();
const socket = server.network.sockets[0];
// node-turn 0.0.6 accepts ChannelBind but its listener only dispatches STUN.
// aioice uses ChannelData after binding; forward only within an authenticated
// allocation, existing channel binding and unexpired peer permission.
socket.on('message', (packet, from) => {
  if (packet.length < 4 || (packet[0] & 0xc0) !== 0x40) return;
  const channel = packet.readUInt16BE(0), length = packet.readUInt16BE(2);
  if (packet.length < length + 4 || packet.length > length + 7) return;
  const allocation = Object.values(server.allocations).find(a => a.transport.dst.address === from.address && a.transport.dst.port === from.port);
  const peer = allocation?.channelBindings[channel];
  if (!peer || allocation.permissions[peer.address] < Date.now() || !allocation.permissions[peer.address]) return;
  allocation.sockets[0].send(packet.subarray(4, 4 + length), peer.port, peer.address);
});
await once(socket, 'listening');
process.send({ ...relayTestEnv, TURN_URLS: `turn:127.0.0.1:${socket.address().port}?transport=udp` });
