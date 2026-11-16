import importlib.util
import pathlib
import sys
import unittest
import asyncio
import time
from fractions import Fraction
from types import SimpleNamespace
from unittest.mock import patch

import av

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'host'))
spec = importlib.util.spec_from_file_location('rtc_worker', pathlib.Path(__file__).parent.parent / 'host' / 'rtc-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RtcVideoTests(unittest.TestCase):
    def test_actual_source_is_bounded_even_with_legacy_1080p_config(self):
        settings = dict(width=1920, height=1080)
        for source, expected in [((1920, 1080), (1280, 720)),
                                 ((3840, 2160), (1280, 720)),
                                 ((1600, 1200), (960, 720)),
                                 ((640, 480), (640, 480)),
                                 ((320, 180), (320, 180)),
                                 ((1080, 1920), (404, 720))]:
            self.assertEqual(worker.output_dimensions(*source, settings), expected)
        self.assertEqual(worker.output_dimensions(1920, 1080, dict(width=640, height=360)), (640, 360))

    def test_h264_bitstream_uses_bounded_canvas_and_lower_encoder_target(self):
        for width, height in [(1280, 720), (960, 720), (640, 360)]:
            codec, name = worker.video_encoder(width, height, 15, 'libx264')
            self.assertEqual(codec.bit_rate, 1500000)
            self.assertEqual(name, 'libx264')
            frame = av.VideoFrame(width, height, 'yuv420p')
            frame.pts, frame.time_base = 90000, codec.time_base
            frame.pict_type = av.video.frame.PictureType.I
            decoder = av.CodecContext.create('h264', 'r')
            decoded = [image for packet in codec.encode(frame) for image in decoder.decode(packet)]
            self.assertTrue(decoded)
            self.assertEqual((decoded[0].width, decoded[0].height), (width, height))

    def test_1080p_requires_explicit_profile(self):
        self.assertEqual(worker.output_dimensions(1920, 1080, dict(width=1920, height=1080, fps=10, profile='1080p10')), (1920, 1080))
        self.assertEqual(worker.output_dimensions(1920, 1080, dict(width=1920, height=1080, fps=30, profile='1080p30')), (1920, 1080))
        self.assertEqual(worker.output_dimensions(1920, 1080, dict(width=854, height=480, fps=30, profile='480p30')), (854, 480))

    def test_buffered_hardware_recovers_with_a_fresh_decodable_keyframe(self):
        delayed = av.Packet(b'old hardware frame')
        delayed.pts, delayed.time_base = 8964000, Fraction(1, 90000)
        fake = SimpleNamespace(bit_rate=1500000, encode=lambda frame: [delayed])
        real_factory = worker.video_encoder
        def factory(width, height, fps, preferred, bitrate):
            if preferred == 'auto': return fake, 'h264_mf'
            return real_factory(width, height, fps, preferred, bitrate)
        with patch.object(worker, 'video_encoder', side_effect=factory), patch.object(worker.time, 'monotonic', return_value=100):
            encoder = worker.LiveVideoEncoder(640, 360, 30, 'auto', 1500000)
            frame = av.VideoFrame(640, 360, 'yuv420p')
            frame.pts, frame.time_base = 9000000, Fraction(1, 90000)
            packets = encoder.encode(frame, 1500000, 30)
            self.assertEqual(encoder.name, 'libx264')
            self.assertEqual(encoder.fallback_reason, 'mf-frame-buffer')
            self.assertTrue(packets[0].is_keyframe)
            self.assertEqual(packets[0].pts, frame.pts)
            decoder = av.CodecContext.create('h264', 'r')
            self.assertTrue([image for packet in packets for image in decoder.decode(packet)])

    def test_hardware_rate_or_framerate_changes_do_not_keep_a_stale_encoder(self):
        real_factory = worker.video_encoder
        for bitrate, fps, reason in [(250000, 30, 'mf-rate-change'), (1500000, 5, 'mf-frame-buffer')]:
            fake = SimpleNamespace(bit_rate=1500000, encode=lambda frame: self.fail('Buffered MFT must not be fed at the new rate'))
            def factory(width, height, fps, preferred, bitrate):
                if preferred == 'auto': return fake, 'h264_mf'
                return real_factory(width, height, fps, preferred, bitrate)
            with patch.object(worker, 'video_encoder', side_effect=factory):
                encoder = worker.LiveVideoEncoder(640, 360, 30, 'auto', 1500000)
                frame = av.VideoFrame(640, 360, 'yuv420p')
                frame.pts, frame.time_base = 9000000, Fraction(1, 90000)
                packets = encoder.encode(frame, bitrate, fps)
                self.assertEqual(encoder.fallback_reason, reason)
                self.assertEqual(encoder.codec.bit_rate, bitrate)
                self.assertTrue(packets[0].is_keyframe)


class RtcFlowTests(unittest.IsolatedAsyncioTestCase):
    async def test_overflow_and_stale_video_wait_for_a_fresh_keyframe(self):
        requests = []
        source = worker.Broadcast('video', asyncio.get_running_loop(), lambda: requests.append(True))
        sub = worker.Subscription(source)
        sub.queue = asyncio.Queue(maxsize=3)
        def frame(pts, key=False, age=0): return (b'encoded', pts, Fraction(1, 90000), time.monotonic()-age, key)
        sub.deliver(frame(1))
        self.assertTrue(sub.queue.empty())
        for pts in range(2, 6): sub.deliver(frame(pts, pts == 2))
        self.assertTrue(sub.queue.empty())
        sub.deliver(frame(6, True))
        self.assertEqual((await sub.recv()).pts, 6)
        sub.deliver(frame(7, True, age=1))
        pending = asyncio.create_task(sub.recv()); await asyncio.sleep(0)
        self.assertFalse(pending.done())
        sub.deliver(frame(8)); self.assertTrue(sub.queue.empty())
        sub.deliver(frame(9, True))
        self.assertEqual((await asyncio.wait_for(pending, 1)).pts, 9)
        self.assertGreaterEqual(len(requests), 2)
        sub.stop()

    async def test_audio_bypasses_a_waiting_video_pacer(self):
        from rtc_flow import TransportPacer, video_budget, video_framerate
        self.assertEqual(video_budget(1), 1500000)
        self.assertEqual(video_budget(1, remote_video=False), 2200000)
        self.assertEqual(video_budget(1, [1800000], remote_video=False), 1530000)
        self.assertEqual(video_budget(2, remote_video=False), 900000)
        self.assertEqual(video_budget(2), 900000)
        self.assertEqual(video_budget(2, [400000]), 340000)
        self.assertEqual(video_budget(1, [100000]), 250000)
        self.assertEqual(video_budget(1, bandwidth_mbps=10), 7200000)
        self.assertEqual(video_budget(2, bandwidth_mbps=10), 3600000)
        self.assertEqual(video_budget(1, [2000000], bandwidth_mbps=10), 1700000)
        self.assertEqual(video_framerate(30, 30, 2), 22)
        self.assertEqual(video_framerate(30, 22, 0), 23)
        self.assertEqual(video_framerate(10, 10, 0), 10)
        self.assertEqual(video_framerate(10, 5, 8), 5)
        pacer = TransportPacer(None, lambda: 600000, audio_ssrcs=[22])
        pacer.queued_bytes = lambda: 0
        pacer.deadline = time.monotonic() + 0.15
        sent = []
        async def send(data): sent.append(int.from_bytes(data[8:12], 'big'))
        def rtp(ssrc): return b'\x80\x60' + b'\0'*6 + ssrc.to_bytes(4, 'big') + b'payload'
        video = asyncio.create_task(pacer.send(rtp(11), send)); await asyncio.sleep(0)
        await asyncio.wait_for(pacer.send(rtp(22), send), 0.05)
        self.assertEqual(sent, [22])
        await video
        self.assertEqual(sent, [22, 11])

    async def test_stalled_video_is_discarded_without_blocking_audio(self):
        from rtc_flow import TransportPacer
        pacer = TransportPacer(None, lambda: 1500000, audio_ssrcs=[22])
        pacer.queued_bytes = lambda: 100000
        sent, discarded = [], []
        async def send(data): sent.append(int.from_bytes(data[8:12], 'big'))
        def rtp(ssrc): return b'\x80\x60' + b'\0'*6 + ssrc.to_bytes(4, 'big') + b'payload'
        with patch('rtc_flow.MAX_VIDEO_SEND_DELAY', 0.05):
            video = asyncio.create_task(pacer.send(rtp(11), send, discard=lambda: discarded.append(True)))
            await asyncio.sleep(0)
            await asyncio.wait_for(pacer.send(rtp(22), send), 0.03)
            self.assertFalse(await asyncio.wait_for(video, 0.15))
        self.assertEqual(sent, [22])
        self.assertEqual(discarded, [True])
        self.assertFalse(await pacer.send(rtp(11), send))
        self.assertEqual(pacer.dropped_frames, 1)

    async def test_short_rtcp_feedback_bypasses_a_congested_video_pacer(self):
        from rtc_flow import TransportPacer
        pacer = TransportPacer(None, lambda: 1500000)
        pacer.queued_bytes = lambda: 100000
        packet = b'\x80\xce\x00\x01' + (11).to_bytes(4, 'big')
        sent = []
        async def send(data): sent.append(data)
        await asyncio.wait_for(pacer.send(packet, send), 0.03)
        self.assertEqual(sent, [packet])

    async def test_sender_reports_use_capture_time_and_keep_rtt_matching(self):
        from rtc_flow import capture_ntp, pace_peer
        with patch('rtc_flow.time.monotonic', return_value=100), patch('rtc_flow.time.time', return_value=1000):
            timestamp = capture_ntp(8982000, Fraction(1, 90000))
        self.assertAlmostEqual(timestamp / (1 << 32), 2208989799.8, places=5)
        sent = []
        async def send(data): sent.append(data)
        transport = SimpleNamespace(_send_rtp=send, transport=SimpleNamespace(iceGatherer=SimpleNamespace(_connection=SimpleNamespace(_nominated={}))))
        sender = SimpleNamespace(_ssrc=11, track=SimpleNamespace(capture_ntp=timestamp), transport=transport, _send_rtcp=send)
        transceiver = SimpleNamespace(sender=sender, kind='video')
        pc = SimpleNamespace(getTransceivers=lambda: [transceiver], getSenders=lambda: [sender])
        pace_peer(pc, lambda: 900000)
        data = b'\x80\x60\0\0' + (1234).to_bytes(4, 'big') + (11).to_bytes(4, 'big')
        await transport._send_rtp(data)
        sender.track.capture_ntp = timestamp + (5 << 32)
        # A NACK retransmission must retain the original frame clock rather
        # than remapping old RTP data to the newest capture time.
        await transport._send_rtp(data)
        report = SimpleNamespace(ssrc=11, sender_info=SimpleNamespace(rtp_timestamp=1234, ntp_timestamp=0))
        await sender._send_rtcp([report])
        self.assertEqual(report.sender_info.ntp_timestamp, timestamp)
        self.assertEqual(sender._RTCRtpSender__lsr, (timestamp >> 16) & 0xffffffff)

    async def test_only_real_remb_feedback_becomes_a_network_estimate(self):
        from rtc_flow import pace_peer
        from aiortc.rtp import RtcpPsfbPacket, RTCP_PSFB_APP, pack_remb_fci
        received = []
        async def send(data): pass
        async def feedback(packet): received.append(packet)
        transport = SimpleNamespace(_send_rtp=send, transport=SimpleNamespace(iceGatherer=SimpleNamespace(_connection=SimpleNamespace(_nominated={}))))
        sender = SimpleNamespace(_ssrc=11, track=SimpleNamespace(), transport=transport, _send_rtcp=send, _handle_rtcp_packet=feedback)
        pc = SimpleNamespace(getTransceivers=lambda: [SimpleNamespace(sender=sender, kind='video')], getSenders=lambda: [sender])
        pace_peer(pc, lambda: 1500000)
        self.assertFalse(hasattr(sender, '_meeting_bandwidth'))
        packet = RtcpPsfbPacket(fmt=RTCP_PSFB_APP, ssrc=22, media_ssrc=0, fci=pack_remb_fci(800000, [11]))
        await sender._handle_rtcp_packet(packet)
        self.assertEqual(sender._meeting_bandwidth[1], 800000)
        self.assertEqual(received, [packet])


if __name__ == '__main__':
    unittest.main()
