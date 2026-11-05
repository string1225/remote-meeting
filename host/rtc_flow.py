"""Bound latency on the pinned aiortc/aioice TURN-over-TCP transport."""
import asyncio
import socket
import time

SINGLE_VIDEO_BITRATE = 1_500_000
# Keep two viewers plus reverse video/audio inside the recorded 3 Mbps egress.
SHARED_VIDEO_BITRATE = 900_000
MIN_VIDEO_BITRATE = 250_000
MAX_FRAME_AGE = 0.25
MAX_VIDEO_SEND_DELAY = 0.25


def capture_ntp(pts, time_base):
    age = time.monotonic() - float(pts * time_base)
    return int((time.time() - age + 2208988800) * (1 << 32))


def video_budget(peers, estimates=()):
    ceiling = SHARED_VIDEO_BITRATE if peers > 1 else SINGLE_VIDEO_BITRATE
    estimates = [int(value * 0.85) for value in estimates if value and 0 < value < ceiling]
    return max(MIN_VIDEO_BITRATE, min([ceiling, *estimates]))


def video_framerate(requested, current, drops):
    return max(5, int(current * 0.75)) if drops else min(requested, current + 1)


class TransportPacer:
    def __init__(self, transport, bitrate, audio_ssrcs=()):
        self.transport, self.bitrate = transport, bitrate
        self.audio_ssrcs = set(audio_ssrcs)
        self.lock = asyncio.Lock()
        self.deadline = 0
        self.configured = set()
        self.expired = set()
        self.dropped_frames = 0

    def buffers(self):
        # aiortc/aioice versions are pinned in rtc-requirements.txt. The public
        # datagram facade hides the TCP stream, so inspect the nominated relay.
        connection = self.transport.transport.iceGatherer._connection
        streams = []
        for pair in connection._nominated.values():
            inner = getattr(pair.protocol.transport, '_TurnTransport__inner_protocol', None)
            stream = getattr(inner, 'transport', None)
            if stream and hasattr(stream, 'get_write_buffer_size'):
                if stream not in self.configured:
                    sock = stream.get_extra_info('socket')
                    if sock:
                        try: sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16384)
                        except OSError: pass
                    self.configured.add(stream)
                streams.append(stream)
        return streams

    def queued_bytes(self):
        return sum(stream.get_write_buffer_size() for stream in self.buffers())

    async def send(self, data, original, captured_at=None, discard=None):
        # Audio and RTCP bypass the video pacer; a large video access unit must
        # never leave a 20 ms Opus packet waiting behind all its fragments.
        if len(data) < 12 or 192 <= data[1] <= 223 or int.from_bytes(data[8:12], 'big') in self.audio_ssrcs:
            await original(data)
            return True
        key = (int.from_bytes(data[8:12], 'big'), int.from_bytes(data[4:8], 'big'))
        if key in self.expired: return False
        expires = (captured_at if captured_at is not None else time.monotonic()) + MAX_VIDEO_SEND_DELAY
        def stale():
            if time.monotonic() < expires: return False
            if key not in self.expired:
                if len(self.expired) >= 128: self.expired.clear()
                self.expired.add(key); self.dropped_frames += 1
                if discard: discard()
            return True
        # Leave room for RTP/TURN/TLS overhead and audio. Spread access units
        # over time instead of dumping every I-frame into TCP in one burst.
        async with self.lock:
            if stale(): return False
            rate = self.bitrate() * 1.2 + 64_000
            while self.queued_bytes() > max(8192, rate * 0.06 / 8):
                if stale(): return False
                await asyncio.sleep(0.01)
            now = time.monotonic()
            await asyncio.sleep(max(0, self.deadline - now))
            if stale(): return False
            self.deadline = max(self.deadline, time.monotonic()) + len(data) * 8 / rate
            await original(data)
            return True


def pace_peer(pc, bitrate):
    pacers = []
    samples = {}
    captures = {}
    tracks = {t.sender._ssrc: t.sender.track for t in pc.getTransceivers()}
    audio_ssrcs = [t.sender._ssrc for t in pc.getTransceivers() if t.kind == 'audio']
    for transceiver in pc.getTransceivers():
        transport = transceiver.sender.transport
        if any(pacer.transport is transport for pacer in pacers): continue
        pacer = TransportPacer(transport, bitrate, audio_ssrcs)
        original = transport._send_rtp

        async def send(data, original=original, pacer=pacer):
            sample, track, captured_at = None, None, None
            if len(data) >= 12 and not 192 <= data[1] <= 223:
                ssrc, timestamp = int.from_bytes(data[8:12], 'big'), int.from_bytes(data[4:8], 'big')
                track = tracks.get(ssrc)
                ntp = getattr(track, 'capture_ntp', None)
                key = (ssrc, timestamp)
                if key not in captures:
                    captures[key] = (ntp, getattr(track, 'capture_monotonic', None))
                    while len(captures) > 1024: captures.pop(next(iter(captures)))
                ntp, captured_at = captures[key]
                if ntp: sample = ((ssrc, timestamp), ntp)
            sent = await pacer.send(data, original, captured_at, getattr(track, 'discard_video', None))
            if sample and sent:
                samples[sample[0]] = sample[1]
                while len(samples) > 128: samples.pop(next(iter(samples)))

        transport._send_rtp = send
        pacers.append(pacer)
    for sender in pc.getSenders():
        receive_rtcp = getattr(sender, '_handle_rtcp_packet', None)
        if receive_rtcp:
            async def receive(packet, sender=sender, original=receive_rtcp):
                from aiortc.rtp import RtcpPsfbPacket, RTCP_PSFB_APP, unpack_remb_fci
                if isinstance(packet, RtcpPsfbPacket) and packet.fmt == RTCP_PSFB_APP:
                    try:
                        estimate, ssrcs = unpack_remb_fci(packet.fci)
                        if sender._ssrc in ssrcs: sender._meeting_bandwidth = (time.monotonic(), estimate)
                    except ValueError: pass
                await original(packet)
            sender._handle_rtcp_packet = receive
        original = sender._send_rtcp

        async def send_rtcp(packets, sender=sender, original=original):
            for packet in packets:
                info = getattr(packet, 'sender_info', None)
                if info:
                    ntp = samples.get((packet.ssrc, info.rtp_timestamp))
                    if ntp:
                        # RTCP maps capture time to RTP time. Mapping it to the
                        # end of a paced send makes Chrome add video delay to
                        # synchronize with audio as packet sizes fluctuate.
                        info.ntp_timestamp = ntp
                        sender._RTCRtpSender__lsr = (ntp >> 16) & 0xffffffff
            await original(packets)

        sender._send_rtcp = send_rtcp
    return pacers
