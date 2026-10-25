import pathlib
import sys
import unittest

import av
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'host'))
from audio_capture import OpusPackets


class AudioTests(unittest.TestCase):
    def test_native_formats_preserve_pitch_and_duration_on_48khz_rtp_clock(self):
        for rate, channels in [(44100, 2), (48000, 1), (48000, 2)]:
            with self.subTest(rate=rate, channels=channels):
                encoder = OpusPackets(rate, channels)
                decoder = av.CodecContext.create('libopus', 'r')
                decoder.sample_rate, decoder.layout, decoder.format = 48000, 'mono', 's16'
                decoded, pts = [], []
                for i in range(300):
                    frames = rate // 100
                    mono = (np.sin((np.arange(frames) + i*frames) * 2*np.pi*440/rate) * 8000).astype(np.int16)
                    raw = np.repeat(mono[:, None], channels, axis=1).tobytes()
                    for packet in encoder.encode(raw, frames, rate*100 + i*frames):
                        self.assertEqual(packet.time_base.denominator, 48000)
                        pts.append(packet.pts)
                        decoded.extend(frame.to_ndarray().reshape(-1) for frame in decoder.decode(packet))
                samples = np.concatenate(decoded).astype(float)
                frequency = np.fft.rfftfreq(len(samples), 1/48000)[np.argmax(abs(np.fft.rfft(samples)))]
                self.assertLess(abs(frequency-440), 1)
                self.assertLess(abs(len(samples)/48000-3), 0.03)
                self.assertEqual(set(np.diff(pts)), {960})

    def test_capture_overrun_skips_time_instead_of_replaying_old_audio(self):
        encoder = OpusPackets(48000, 2)
        raw = np.zeros((960, 2), np.int16).tobytes()
        first = list(encoder.encode(raw, 960, 480000))[-1]
        fresh = list(encoder.encode(raw, 960, 480000 + 48000))[-1]
        self.assertEqual(fresh.pts-first.pts, 48000)
        with self.assertRaises(ValueError): list(encoder.encode(raw[:-2], 960, 528960))


if __name__ == '__main__': unittest.main()
