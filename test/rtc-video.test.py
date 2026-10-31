import importlib.util
import pathlib
import sys
import unittest

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


if __name__ == '__main__':
    unittest.main()
