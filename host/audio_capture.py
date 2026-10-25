"""Capture at the device's native format; Opus and RTP always use 48 kHz."""
import queue
import time
from fractions import Fraction

import av

OPUS_RATE = 48000
OPUS_SAMPLES = 960


def microphones():
    import sounddevice as sd
    apis = sd.query_hostapis()
    devices = sd.query_devices()
    wasapi = next((i for i, api in enumerate(apis) if api['name'] == 'Windows WASAPI'), None)
    selected = [(i, d) for i, d in enumerate(devices) if d['max_input_channels'] > 0 and (wasapi is None or d['hostapi'] == wasapi)]
    default = apis[wasapi]['default_input_device'] if wasapi is not None else sd.default.device[0]
    return [dict(id=f"{apis[d['hostapi']]['name']}|{d['name']}", name=d['name'], hostApi=apis[d['hostapi']]['name'],
                 sampleRate=round(d['default_samplerate']), channels=min(2, d['max_input_channels']), default=i == default)
            for i, d in selected]


def resolve_microphone(selection):
    import sounddevice as sd
    devices, apis = sd.query_devices(), sd.query_hostapis()
    available = microphones()
    match = next((d for d in available if d['id'] == selection or d['name'] == selection), None) if selection else next((d for d in available if d['default']), None)
    if not match: raise ValueError('所选麦克风未连接，请在本机设备设置中重新选择')
    index = next(i for i, d in enumerate(devices) if d['name'] == match['name'] and apis[d['hostapi']]['name'] == match['hostApi'])
    return index, match


class OpusPackets:
    def __init__(self, rate, channels):
        self.rate, self.channels, self.expected = rate, channels, None
        self.codec = av.CodecContext.create('libopus', 'w')
        self.codec.sample_rate, self.codec.layout, self.codec.format, self.codec.bit_rate = OPUS_RATE, 'mono', 's16', 48000
        self.codec.time_base = Fraction(1, OPUS_RATE)
        self.codec.options = {'application': 'voip', 'frame_duration': '20'}
        self.codec.open()
        self.reset_resampler()

    def reset_resampler(self):
        self.resampler = av.AudioResampler(format='s16', layout='mono', rate=OPUS_RATE, frame_size=OPUS_SAMPLES)

    def encode(self, raw, frames, pts):
        if len(raw) != frames * self.channels * 2: raise ValueError('麦克风 PCM 长度与采样格式不匹配')
        # Discard partial old audio after a capture overrun; never stretch it.
        if self.expected is not None and abs(pts - self.expected) > 1: self.reset_resampler()
        self.expected = pts + frames
        frame = av.AudioFrame(format='s16', layout='mono' if self.channels == 1 else 'stereo', samples=frames)
        frame.planes[0].update(raw)
        frame.sample_rate, frame.pts, frame.time_base = self.rate, pts, Fraction(1, self.rate)
        for normalized in self.resampler.resample(frame):
            for index, packet in enumerate(self.codec.encode(normalized)):
                # libopus continues its own sample counter across input gaps.
                # RTP must instead follow the capture clock after dropped data.
                packet.pts = packet.dts = normalized.pts + index * OPUS_SAMPLES
                packet.time_base = Fraction(1, OPUS_RATE)
                yield packet


class Microphone:
    def __init__(self, selection):
        import sounddevice as sd
        index, self.info = resolve_microphone(selection)
        self.rate, self.channels = self.info['sampleRate'], self.info['channels']
        self.pending = queue.Queue(maxsize=3)
        self.frames, self.dropped, self.overflows = 0, 0, 0
        self.base = None
        def capture(raw, frames, timing, status):
            if self.base is None: self.base = round(time.monotonic() * self.rate)
            pts = self.base + self.frames
            self.frames += frames
            self.overflows += int(bool(status.input_overflow))
            item = (bytes(raw), frames, pts, time.monotonic())
            if self.pending.full():
                try: self.dropped += self.pending.get_nowait()[1]
                except queue.Empty: pass
            self.pending.put_nowait(item)
        self.stream = sd.RawInputStream(device=index, samplerate=self.rate, blocksize=0, channels=self.channels,
                                        dtype='int16', latency='low', callback=capture)

    def start(self):
        self.stream.start()
        if round(self.stream.samplerate) != self.rate: raise ValueError('麦克风实际采样率与配置不一致')

    def read(self):
        return self.pending.get(timeout=0.25)

    def close(self):
        try: self.stream.stop()
        finally: self.stream.close()
