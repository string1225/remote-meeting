"""Capture, compose and publish cameras natively. Stdin carries JSON controls only."""
import json
import math
import re
import sys
import threading
import time

import cv2
import numpy as np


def status(**message):
    print(json.dumps(message), flush=True)


def normalize(view):
    zoom, x, y = (view[key] for key in ("zoom", "x", "y"))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (zoom, x, y)):
        raise ValueError("Invalid viewport")
    zoom = min(8, max(1, zoom))
    edge = 0.5 / zoom
    return dict(zoom=zoom, x=min(1 - edge, max(edge, x)), y=min(1 - edge, max(edge, y)))


def select_cameras(names, configured):
    def stem(name):
        return re.sub(r"\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$", "", name, flags=re.I).lower()
    eligible = [i for i, name in enumerate(names) if not re.search(r"\bIR\b|infrared|virtual|obs|unity|remote meeting camera", name, re.I)]
    if configured:
        selected = []
        for name in configured:
            matches = [i for i in eligible if stem(names[i]) == stem(name)]
            if len(matches) != 1:
                raise ValueError("摄像头未连接或名称不唯一：" + name)
            selected.append(matches[0])
    else:
        usb = next((i for i in eligible if re.search(r"USB|PC Camera", names[i], re.I)), None)
        front = next((i for i in eligible if i != usb and re.search(r"front|integrated|built.in|前置", names[i], re.I)), None)
        selected = [usb, front]
    if len(selected) != 2 or None in selected or selected[0] == selected[1]:
        raise ValueError("需要连接 USB 主摄像头和笔记本前置摄像头")
    return selected


def cover(frame, width, height, view):
    h, w = frame.shape[:2]
    cw, ch = w / view["zoom"], h / view["zoom"]
    if cw / ch > width / height:
        cw = ch * width / height
    else:
        ch = cw * height / width
    left = max(0, round(view["x"] * w - cw / 2))
    top = max(0, round(view["y"] * h - ch / 2))
    right, bottom = min(w, max(left + 1, round(left + cw))), min(h, max(top + 1, round(top + ch)))
    return cv2.resize(frame[top:bottom, left:right], (width, height), interpolation=cv2.INTER_LINEAR)


def compose(main, pip, width, height, view):
    output = cover(main, width, height, view)
    pw, margin = round(width * 0.26), round(width * 0.02)
    ph = round(pw * 9 / 16)
    x, y = width - pw - margin, height - ph - margin
    output[y - 2:y + ph + 2, x - 2:x + pw + 2] = 255
    output[y:y + ph, x:x + pw] = cover(pip, pw, ph, dict(zoom=1, x=0.5, y=0.5))
    return output


class Source:
    def __init__(self, index, label, width, height, fps):
        self.camera = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        self.closed = threading.Event()
        self.thread = None
        self.error = None
        try:
            if not self.camera.isOpened():
                raise ValueError("无法打开摄像头：" + label + "。请先让 OBS、钉钉等软件停止使用这一路原摄像头")
            self.camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            self.camera.set(cv2.CAP_PROP_FPS, fps)
            ok, self.frame = self.camera.read()
            if not ok or self.frame is None:
                raise ValueError("摄像头被占用或无法读取：" + label)
            h, w = self.frame.shape[:2]
            if w > width or h > height:
                raise ValueError("摄像头未遵守采集尺寸上限：" + label)
            self.updated = time.monotonic()
            self.info = dict(label=label, width=w, height=h, frameRate=self.camera.get(cv2.CAP_PROP_FPS))
            self.thread = threading.Thread(target=self.read, daemon=True)
            self.thread.start()
        except Exception:
            self.close()
            raise

    def read(self):
        while not self.closed.is_set():
            ok, frame = self.camera.read()
            if not ok:
                self.error = "摄像头已断开：" + self.info["label"]
                return
            self.frame, self.updated = frame, time.monotonic()

    def latest(self):
        if self.error or time.monotonic() - self.updated > 5:
            raise ValueError(self.error or "摄像头读取超时")
        return self.frame

    def close(self):
        self.closed.set()
        if self.thread:
            self.thread.join(timeout=1.5)
        self.camera.release()


class SyntheticSource:
    def __init__(self, index):
        w, h = (1920, 1080) if index == 0 else (640, 360)
        self.frame = np.empty((h, w, 3), np.uint8)
        self.frame[:, :w // 2] = (25, 25, 232) if index == 0 else (64, 191, 20)
        self.frame[:, w // 2:] = (232, 59, 24) if index == 0 else (22, 202, 232)
        self.info = dict(label=f"Synthetic camera {index}", width=w, height=h, frameRate=30)

    def latest(self):
        return self.frame

    def close(self):
        pass


def main():
    from mf_camera import NativeCamera
    cv2.setNumThreads(2)
    width, height, fps = map(int, sys.argv[1:4])
    if (width, height) not in ((1280, 720), (1920, 1080)) or not 5 <= fps <= 30:
        raise ValueError("Unsupported virtual camera settings")
    config = json.loads(sys.stdin.readline())
    sources, stop = [], threading.Event()
    camera = None
    view, lock = dict(zoom=1, x=0.5, y=0.5), threading.Lock()
    revision = 0

    def controls():
        nonlocal view, revision
        try:
            for line in sys.stdin:
                message = json.loads(line)
                if message.get("type") == "viewport":
                    with lock:
                        view = normalize(message)
                        revision += 1
        finally:
            stop.set()

    threading.Thread(target=controls, daemon=True).start()
    try:
        camera = NativeCamera(width, height, fps)
        if config.get("synthetic"):
            sources = [SyntheticSource(0), SyntheticSource(1)]
        else:
            from pygrabber.dshow_graph import FilterGraph
            names = FilterGraph().get_input_devices()
            for i, index in enumerate(select_cameras(names, config.get("cameras", []))):
                w, h = (1920, 1080) if i == 0 else (640, 480)
                sources.append(Source(index, names[index], w, h, fps))
        if stop.is_set():
            return
        with camera:
            status(type="ready", device=camera.device, cameras=[s.info for s in sources])
            applied = -1
            started, frames, render_time, send_time = time.monotonic(), 0, 0.0, 0.0
            next_frame = started
            while not stop.is_set():
                with lock:
                    current, version = view.copy(), revision
                phase = time.perf_counter()
                output = compose(sources[0].latest(), sources[1].latest(), width, height, current)
                render_time += time.perf_counter() - phase
                phase = time.perf_counter()
                camera.send(output)
                send_time += time.perf_counter() - phase
                if applied != version:
                    applied = version
                    status(type="viewport-applied", camera=0, shared=True, **current, sourceWidth=sources[0].info["width"], sourceHeight=sources[0].info["height"], outputWidth=width, outputHeight=height)
                frames += 1
                # Absolute cadence caps production at 30 fps without catch-up bursts.
                next_frame = max(next_frame + 1 / fps, time.monotonic())
                stop.wait(max(0, next_frame - time.monotonic()))
                elapsed = time.monotonic() - started
                if elapsed >= 2:
                    status(type="metrics", fps=round(frames / elapsed, 1), renderMs=round(render_time * 1000 / frames, 1), sendMs=round(send_time * 1000 / frames, 1))
                    started, frames, render_time, send_time = time.monotonic(), 0, 0.0, 0.0
    finally:
        stop.set()
        if camera:
            camera.close()
        for source in sources:
            source.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        status(type="error", message=str(error))
        sys.exit(1)
