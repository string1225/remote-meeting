"""Share one forwarded UDP port between authenticated aiortc ICE sessions.

FRP forwards each browser socket to a distinct local source address. Route ICE
by its authenticated username, then DTLS/SRTP by that source address. The
shared socket survives individual viewers and BUNDLE's discarded transports.
aiortc 1.15 / aioice 0.10.2 are pinned in rtc-requirements.txt.
"""
import asyncio
import socket
import sys

from aioice import Candidate, stun
from aioice.ice import StunProtocol, TransportPolicy, candidate_foundation, candidate_priority


class SessionTransport:
    def __init__(self, mux, protocol):
        self.mux, self.protocol = mux, protocol

    def sendto(self, data, addr):
        self.mux.transport.sendto(data, addr)

    def get_extra_info(self, name, default=None):
        return self.mux.transport.get_extra_info(name, default)

    def close(self):
        self.mux.remove(self.protocol)


class UdpIceMux(asyncio.DatagramProtocol):
    def __init__(self, address, public_port):
        self.address, self.public_port = address, public_port
        self.transport = None
        self.protocols = {}
        self.routes = {}
        self.timer = False

    async def start(self, port=20000):
        await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: self, local_addr=('0.0.0.0', port), family=socket.AF_INET)
        sock = self.transport.get_extra_info('socket')
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)

    def set_timer(self, enabled):
        if sys.platform != 'win32' or enabled == self.timer:
            return
        import ctypes
        if enabled:
            self.timer = ctypes.windll.winmm.timeBeginPeriod(1) == 0
        else:
            ctypes.windll.winmm.timeEndPeriod(1)
            self.timer = False

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        try:
            message = stun.parse_message(data)
        except ValueError:
            protocol = self.routes.get(addr)
            if protocol:
                protocol.datagram_received(data, addr)
            return
        if message.message_class == stun.Class.REQUEST:
            username = message.attributes.get('USERNAME', '')
            matches = [(order, p) for p, order in self.protocols.items()
                       if username.split(':', 1)[0] == p.receiver.local_username]
            if not matches or 'MESSAGE-INTEGRITY' not in message.attributes:
                return
            # BALANCED gatherers share credentials; route to the primary
            # video transport which survives the negotiated BUNDLE.
            protocol = min(matches, key=lambda value: value[0])[1]
            connection = protocol.receiver
            if connection.remote_username and username != f'{connection.local_username}:{connection.remote_username}':
                return
            try:
                stun.parse_message(data, integrity_key=connection.local_password.encode())
            except ValueError:
                return
            owned = [key for key, value in self.routes.items() if value is protocol]
            if addr not in self.routes and len(owned) >= 16:
                self.routes.pop(owned[0])
            self.routes[addr] = protocol
            protocol.datagram_received(data, addr)
        elif message.message_class in (stun.Class.RESPONSE, stun.Class.ERROR):
            for protocol in tuple(self.protocols):
                if message.transaction_id in protocol.transactions:
                    protocol.datagram_received(data, addr)
                    break

    def remove(self, protocol):
        if protocol not in self.protocols:
            return
        self.protocols.pop(protocol)
        self.routes = {key: value for key, value in self.routes.items() if value is not protocol}
        protocol.connection_lost(None)
        if not self.protocols:
            self.set_timer(False)

    def configure(self, pc):
        seen = set()
        for transceiver in pc.getTransceivers():
            connection = transceiver.sender.transport.transport.iceGatherer._connection
            if connection in seen:
                continue
            order = len(seen)
            seen.add(connection)
            connection._transport_policy = TransportPolicy.ALL

            async def gather(component, addresses, timeout=5, connection=connection, order=order):
                protocol = StunProtocol(connection)
                protocol.connection_made(SessionTransport(self, protocol))
                protocol.local_candidate = Candidate(
                    foundation=candidate_foundation('host', 'udp', self.address),
                    component=component, transport='udp',
                    priority=candidate_priority(component, 'host'),
                    host=self.address, port=self.public_port, type='host')
                self.protocols[protocol] = order
                self.set_timer(True)
                connection._protocols.append(protocol)
                return [protocol.local_candidate]

            connection.get_component_candidates = gather

    def close(self):
        for protocol in tuple(self.protocols):
            self.remove(protocol)
        if self.transport:
            self.transport.close()
        self.set_timer(False)
