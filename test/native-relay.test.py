import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'host'))
from aiortc import RTCConfiguration, RTCPeerConnection
from relay import enforce_relay, ice_servers


class NativeRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_unavailable_turn_never_gathers_direct_candidates(self):
        pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers({'iceServers': [dict(urls='turn:127.0.0.1:9?transport=udp', username='test', credential='test')]})))
        try:
            pc.addTransceiver('video', direction='sendonly')
            pc.addTransceiver('audio', direction='sendonly')
            enforce_relay(pc)
            await pc.setLocalDescription(await pc.createOffer())
            self.assertNotIn('a=candidate:', pc.localDescription.sdp)
            for transceiver in pc.getTransceivers():
                connection = transceiver.sender.transport.transport.iceGatherer._connection
                self.assertEqual(connection._protocols, [], 'No direct ICE sockets may remain when TURN is unavailable')
        finally:
            await pc.close()

    async def test_missing_or_stun_only_configuration_is_rejected(self):
        for servers in [[], [dict(urls='stun:127.0.0.1:3478')], [dict(urls='turn:127.0.0.1:3478')]]:
            with self.assertRaises(ValueError):
                ice_servers(dict(iceServers=servers))


if __name__ == '__main__':
    unittest.main()
