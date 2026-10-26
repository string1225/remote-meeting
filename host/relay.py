"""Relay-only ICE for pinned aiortc 1.15 / aioice 0.10.

aiortc has no public iceTransportPolicy setting. Set aioice's policy on every
gatherer before gathering, and reject missing TURN config rather than use STUN.
"""
from aioice.ice import TransportPolicy
from aiortc import RTCIceServer


def ice_servers(config):
    servers = config.get('iceServers', [])
    if not servers:
        raise ValueError('Missing authenticated TURN relay configuration')
    for server in servers:
        urls = server.get('urls', [])
        if isinstance(urls, str):
            urls = [urls]
        if not urls or not all(url.startswith(('turn:', 'turns:')) for url in urls) or not server.get('username') or not server.get('credential'):
            raise ValueError('Only authenticated TURN relay servers are supported')
    return [RTCIceServer(**server) for server in servers]


def enforce_relay(pc):
    seen = set()
    for transceiver in pc.getTransceivers():
        connection = transceiver.sender.transport.transport.iceGatherer._connection
        if connection in seen:
            continue
        seen.add(connection)
        if not connection.turn_server:
            raise ValueError('Missing TURN server on native ICE transport')
        connection._transport_policy = TransportPolicy.RELAY
        # aioice's RELAY policy hides host candidates from SDP but retains
        # their sockets for connectivity checks. Do not create those sockets.
        gather = connection.get_component_candidates

        async def relay_candidates(component, addresses, timeout=5, original=gather):
            return await original(component=component, addresses=[], timeout=timeout)

        connection.get_component_candidates = relay_candidates
