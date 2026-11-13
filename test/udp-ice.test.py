import asyncio
import pathlib
import socket
import sys
import unittest

from aioice import stun
from aiortc import RTCPeerConnection, RTCConfiguration, RTCBundlePolicy

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'host'))
from udp_ice import UdpIceMux


class UdpIceTests(unittest.IsolatedAsyncioTestCase):
    async def test_authentication_bundle_routing_and_shared_socket_lifetime(self):
        mux = UdpIceMux('127.0.0.1', 33574)
        await mux.start(0)
        endpoint = ('127.0.0.1', mux.transport.get_extra_info('sockname')[1])
        peers, clients = [], []
        try:
            for _ in range(2):
                pc = RTCPeerConnection(RTCConfiguration(iceServers=[], bundlePolicy=RTCBundlePolicy.BALANCED))
                peers.append(pc)
                pc.addTransceiver('video'); pc.addTransceiver('audio')
                mux.configure(pc)
                gatherers = [t.sender.transport.transport.iceGatherer for t in pc.getTransceivers()]
                # Gather the secondary first to ensure registration order does
                # not decide which BUNDLE transport receives packets.
                await gatherers[1].gather(); await gatherers[0].gather()
                self.assertTrue(all(c.ip == '127.0.0.1' and c.port == 33574 for g in gatherers for c in g.getLocalCandidates()))
                connection = gatherers[0]._connection
                client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                clients.append(client); client.setblocking(False); client.bind(('127.0.0.1', 0))
                request = stun.Message(stun.Method.BINDING, stun.Class.REQUEST)
                request.attributes['USERNAME'] = connection.local_username + ':browser'
                request.attributes['PRIORITY'] = 1234
                request.add_message_integrity(b'wrong-key')
                await asyncio.get_running_loop().sock_sendto(client, bytes(request), endpoint)
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.get_running_loop().sock_recvfrom(client, 2048), 0.05)
                self.assertNotIn(client.getsockname(), mux.routes)
                request.add_message_integrity(connection.local_password.encode())
                await asyncio.get_running_loop().sock_sendto(client, bytes(request), endpoint)
                response, _ = await asyncio.wait_for(asyncio.get_running_loop().sock_recvfrom(client, 2048), 1)
                self.assertEqual(stun.parse_message(response).message_class, stun.Class.RESPONSE)
                self.assertIs(mux.routes[client.getsockname()], connection._protocols[0])
            await peers[0].close()
            self.assertNotIn(clients[0].getsockname(), mux.routes)
            self.assertIn(clients[1].getsockname(), mux.routes)
            self.assertFalse(mux.transport.is_closing())
        finally:
            await asyncio.gather(*(pc.close() for pc in peers))
            for client in clients: client.close()
            mux.close()


if __name__ == '__main__':
    unittest.main()
