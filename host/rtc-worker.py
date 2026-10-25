"""Native capture and a single shared H264/Opus encoder; JSON signaling only."""
import asyncio
import importlib.util
import json
import math
import pathlib
import queue
import sys
import threading
import time
from fractions import Fraction

import av
import cv2
import numpy as np
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender, RTCSessionDescription, MediaStreamTrack
from aiortc.sdp import candidate_from_sdp

spec = importlib.util.spec_from_file_location('capture', pathlib.Path(__file__).with_name('virtual-camera.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
output_lock = threading.Lock()

def emit(**data):
    with output_lock:
        print(json.dumps(data), flush=True)


class Subscription(MediaStreamTrack):
    def __init__(self, source):
        super().__init__()
        self.kind, self.source = source.kind, source
        self.queue = asyncio.Queue(maxsize=3)
        source.listeners.add(self)

    async def recv(self):
        data, pts, base = await self.queue.get()
        packet = av.Packet(data)
        packet.pts = packet.dts = pts
        packet.time_base = base
        return packet

    def stop(self):
        super().stop()
        self.source.listeners.discard(self)


class Broadcast:
    def __init__(self, kind, loop):
        self.kind, self.loop = kind, loop
        self.listeners = set()

    def publish(self, packet):
        value = (bytes(packet), packet.pts, packet.time_base)
        def deliver():
            for listener in tuple(self.listeners):
                if listener.queue.full():
                    listener.queue.get_nowait()
                listener.queue.put_nowait(value)
        self.loop.call_soon_threadsafe(deliver)


def video_encoder(width, height, fps, preferred='auto'):
    errors = []
    for name in (['h264_qsv', 'libx264'] if preferred == 'auto' else [preferred]):
        try:
            codec = av.CodecContext.create(name, 'w')
            codec.width, codec.height, codec.bit_rate = width, height, 3000000
            codec.time_base, codec.framerate = Fraction(1, 90000), Fraction(fps)
            codec.pix_fmt = 'nv12' if name == 'h264_qsv' else 'yuv420p'
            codec.thread_count, codec.gop_size, codec.max_b_frames = 2, fps, 0
            codec.options = ({'preset': 'veryfast', 'tune': 'zerolatency', 'profile': 'baseline', 'x264-params': f'repeat-headers=1:keyint={fps}:min-keyint={fps}:scenecut=0'}
                             if name == 'libx264' else {'preset': 'veryfast', 'look_ahead': '0', 'async_depth': '1', 'profile': 'baseline', 'repeat_pps': '1'})
            codec.open()
            # Some drivers defer device initialization until the first frame.
            frame = av.VideoFrame(width, height, 'yuv420p')
            frame.pts, frame.time_base = 0, Fraction(1, 90000)
            codec.encode(frame)
            return codec, name
        except Exception as error:
            errors.append(f'{name}: {error}')
    raise RuntimeError('; '.join(errors))


class Devices:
    def __init__(self, config, loop):
        self.config, self.loop = config, loop
        self.video, self.audio = Broadcast('video', loop), Broadcast('audio', loop)
        self.camera_stop, self.audio_stop = threading.Event(), threading.Event()
        self.camera_thread = self.audio_thread = None
        self.view = dict(zoom=1, x=0.5, y=0.5)
        self.version = 0

    def camera_start(self):
        if self.camera_thread and self.camera_thread.is_alive(): return
        self.camera_stop.clear()
        self.view = dict(zoom=1, x=0.5, y=0.5)
        emit(type='camera-state', state='starting')
        self.camera_thread = threading.Thread(target=self.camera_loop, daemon=True)
        self.camera_thread.start()

    def camera_loop(self):
        sources, encoder_errors, encoder_info, encode_times = [], [], [], []
        pending, encoder_ready = queue.Queue(maxsize=1), threading.Event()
        encoded, encoder_thread, failed = [0], None, False
        settings = self.config['output']
        width, height, fps = settings['width'], settings['height'], settings['fps']
        def encode():
            try:
                codec, name = video_encoder(width, height, fps, self.config.get('encoder', 'auto'))
                encoder_info.append(name); encoder_ready.set()
                while not self.camera_stop.is_set():
                    try: image, pts = pending.get(timeout=0.1)
                    except queue.Empty: continue
                    start = time.perf_counter()
                    frame = av.VideoFrame.from_ndarray(cv2.cvtColor(image, cv2.COLOR_BGR2YUV_I420), format='yuv420p')
                    frame.pts, frame.time_base = pts, Fraction(1, 90000)
                    if encoded[0] % fps == 0: frame.pict_type = av.video.frame.PictureType.I
                    for packet in codec.encode(frame): self.video.publish(packet)
                    encoded[0] += 1
                    encode_times.append((time.perf_counter() - start) * 1000)
                    if len(encode_times) > 30: del encode_times[0]
            except Exception as error:
                encoder_errors.append(error); encoder_ready.set()
        try:
            if self.config.get('synthetic'):
                sources = [capture.SyntheticSource(0), capture.SyntheticSource(1)]
            else:
                from pygrabber.dshow_graph import FilterGraph
                import comtypes
                comtypes.CoInitialize()
                names = FilterGraph().get_input_devices()
                for i, index in enumerate(capture.select_cameras(names, self.config.get('cameras', []))):
                    if self.camera_stop.is_set(): return
                    sources.append(capture.Source(index, names[index], 1920 if i == 0 else 640, 1080 if i == 0 else 480, fps))
            encoder_thread = threading.Thread(target=encode, daemon=True)
            encoder_thread.start(); encoder_ready.wait()
            if encoder_errors: raise encoder_errors[0]
            encoder = encoder_info[0]
            if self.camera_stop.is_set(): return
            emit(type='camera-state', state='ready', cameras=[s.info for s in sources], encoder=encoder)
            clock, last, count, preview_at, applied, last_encoded, render_ms = time.monotonic(), time.monotonic(), 0, 0, -1, 0, 0
            while not self.camera_stop.is_set():
                if encoder_errors: raise encoder_errors[0]
                view, version = self.view.copy(), self.version
                render_start = time.perf_counter()
                image = capture.compose(sources[0].latest(), sources[1].latest(), width, height, view)
                render_ms += (time.perf_counter() - render_start) * 1000
                if time.monotonic() >= preview_at:
                    import base64
                    _, jpeg = cv2.imencode('.jpg', cv2.resize(image, (640, 360)), [cv2.IMWRITE_JPEG_QUALITY, 65])
                    emit(type='preview', jpeg=base64.b64encode(jpeg).decode('ascii'))
                    preview_at = time.monotonic() + 0.5
                if self.video.listeners:
                    if pending.full():
                        try: pending.get_nowait()
                        except queue.Empty: pass
                    pending.put_nowait((image, round(time.monotonic() * 90000)))
                if applied != version:
                    emit(type='viewport-applied', **view)
                    applied = version
                count += 1
                clock = max(clock + 1 / fps, time.monotonic())
                self.camera_stop.wait(max(0, clock - time.monotonic()))
                elapsed = time.monotonic() - last
                if elapsed >= 2:
                    produced, times = encoded[0], encode_times.copy()
                    emit(type='metrics', fps=round((produced-last_encoded)/elapsed, 1), composeFps=round(count/elapsed, 1), encodeMs=round(sum(times)/max(1,len(times)), 1), renderMs=round(render_ms/count, 1), encoder=encoder)
                    last, count, last_encoded, render_ms = time.monotonic(), 0, produced, 0
        except Exception as error:
            failed = True
            emit(type='camera-state', state='error', message=str(error))
        finally:
            self.camera_stop.set()
            if encoder_thread: encoder_thread.join()
            for source in sources: source.close()
            emit(type='preview', jpeg='')
            if not failed: emit(type='camera-state', state='stopped')

    async def camera_close(self):
        self.camera_stop.set()
        if self.camera_thread:
            emit(type='camera-state', state='stopping')
            await asyncio.to_thread(self.camera_thread.join)
        self.camera_thread = None
        emit(type='camera-state', state='stopped')

    def microphone_start(self):
        if self.audio_thread and self.audio_thread.is_alive(): return
        self.audio_stop.clear()
        emit(type='microphone-state', state='starting')
        self.audio_thread = threading.Thread(target=self.audio_loop, daemon=True)
        self.audio_thread.start()

    def audio_loop(self):
        stream = None
        try:
            codec = av.CodecContext.create('libopus', 'w')
            codec.sample_rate, codec.layout, codec.format, codec.bit_rate = 48000, 'mono', 's16', 48000
            codec.time_base = Fraction(1, 48000)
            codec.options = {'application': 'voip'}
            codec.open()
            if not self.config.get('synthetic'):
                import sounddevice as sd
                device = self.config.get('microphone') or None
                hostapis = sd.query_hostapis()
                wasapi = next((i for i, api in enumerate(hostapis) if api['name'] == 'Windows WASAPI'), None)
                if wasapi is not None and not device: device = hostapis[wasapi]['default_input_device']
                stream = sd.RawInputStream(device=device, samplerate=48000, blocksize=960, channels=1, dtype='int16', latency='low')
                stream.start()
            emit(type='microphone-state', state='ready')
            sample = round(time.monotonic() * 48000)
            while not self.audio_stop.is_set():
                if stream:
                    raw, overflow = stream.read(960)
                    raw = bytes(raw)
                else:
                    t = (np.arange(960) + sample) / 48000
                    raw = (np.sin(t * 2 * math.pi * 440) * 4000).astype(np.int16).tobytes()
                    self.audio_stop.wait(0.02)
                frame = av.AudioFrame(format='s16', layout='mono', samples=960)
                frame.planes[0].update(raw)
                frame.sample_rate, frame.pts, frame.time_base = 48000, sample, Fraction(1, 48000)
                sample += 960
                for packet in codec.encode(frame):
                    self.audio.publish(packet)
        except Exception as error:
            emit(type='microphone-state', state='error', message=str(error))
        finally:
            if stream: stream.stop(); stream.close()
            if self.audio_stop.is_set(): emit(type='microphone-state', state='stopped')

    async def microphone_close(self):
        self.audio_stop.set()
        if self.audio_thread: await asyncio.to_thread(self.audio_thread.join)
        self.audio_thread = None
        emit(type='microphone-state', state='stopped')


async def main():
    config = json.loads(await asyncio.to_thread(sys.stdin.readline))
    cv2.setNumThreads(2)
    devices = Devices(config, asyncio.get_running_loop())
    peers, tasks = {}, set()
    async def remove(id):
        peer = peers.pop(id, None)
        if peer:
            for sender in peer.getSenders():
                if sender.track: sender.track.stop()
            await peer.close()

    async def handle(message):
        kind, id = message.get('type'), message.get('id')
        try:
            if kind == 'peer-add':
                await remove(id)
                pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**server) for server in config.get('iceServers', [])]))
                peers[id] = pc
                for source in [devices.video, devices.audio]:
                    t = pc.addTransceiver(Subscription(source), direction='sendonly')
                    if source.kind == 'video': t.setCodecPreferences([c for c in RTCRtpSender.getCapabilities('video').codecs if c.mimeType == 'video/H264'])
                @pc.on('connectionstatechange')
                async def state():
                    emit(type='peer-state', id=id, state=pc.connectionState)
                await pc.setLocalDescription(await pc.createOffer())
                if peers.get(id) is pc: emit(type='signal', to=id, channel='host-media', data={'description': {'type': pc.localDescription.type, 'sdp': pc.localDescription.sdp}})
            elif kind == 'peer-remove': await remove(id)
            elif kind == 'signal' and id in peers:
                data = message['data']
                if 'description' in data: await peers[id].setRemoteDescription(RTCSessionDescription(**data['description']))
                elif data.get('candidate'):
                    c = data['candidate']
                    candidate = candidate_from_sdp(c['candidate'].removeprefix('candidate:'))
                    candidate.sdpMid, candidate.sdpMLineIndex = c.get('sdpMid'), c.get('sdpMLineIndex')
                    await peers[id].addIceCandidate(candidate)
            elif kind == 'camera-start': devices.camera_start()
            elif kind == 'camera-stop': await devices.camera_close()
            elif kind == 'microphone-start': devices.microphone_start()
            elif kind == 'microphone-stop': await devices.microphone_close()
            elif kind == 'viewport': devices.view = capture.normalize(message); devices.version += 1
        except Exception as error: emit(type='worker-error', id=id, message=str(error))

    emit(type='worker-ready')
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line: break
            message = json.loads(line)
            task = asyncio.create_task(handle(message)); tasks.add(task); task.add_done_callback(tasks.discard)
    finally:
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await devices.camera_close(); await devices.microphone_close()
        await asyncio.gather(*(remove(id) for id in list(peers)))

if __name__ == '__main__':
    asyncio.run(main())
