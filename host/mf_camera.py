"""Local NV12 frame transport for the Windows Media Foundation camera."""
import ctypes
import json
import mmap
import os
import subprocess
from pathlib import Path

import cv2
import numpy as np

MAPPING_BYTES = 64 + 1920 * 1080 * 3 // 2
CONFIG_KEY = r"SOFTWARE\RemoteMeetingCamera"
DEVICE_PREFIX = "Remote Meeting Camera"


def configuration():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, CONFIG_KEY, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            return {name: winreg.QueryValueEx(key, name)[0] for name in ["ControllerPath", "DllPath", "FramePath", "OwnerSid"]}
    except OSError as error:
        raise ValueError("Windows 原生虚拟摄像头尚未安装，请运行 host/install-mf-camera.ps1 完成安装") from error


def nv12(frame):
    h, w = frame.shape[:2]
    planar = cv2.cvtColor(frame, cv2.COLOR_BGR2YUV_I420).reshape(-1)
    pixels = w * h
    output = np.empty(pixels * 3 // 2, np.uint8)
    output[:pixels] = planar[:pixels]
    output[pixels::2] = planar[pixels:pixels * 5 // 4]
    output[pixels + 1::2] = planar[pixels * 5 // 4:]
    return output


class FrameWriter:
    def __init__(self, path, dll_path, width, height, fps):
        if width not in (1280, 1920) or height != width * 9 // 16 or not 5 <= fps <= 30:
            raise ValueError("Unsupported native output mode")
        self.width, self.height, self.fps = width, height, fps
        self.file = open(path, "r+b")
        self.mapping = None
        try:
            if os.fstat(self.file.fileno()).st_size != MAPPING_BYTES:
                raise ValueError("原生摄像头共享帧文件大小不正确，请重新安装")
            self.mapping = mmap.mmap(self.file.fileno(), MAPPING_BYTES, access=mmap.ACCESS_WRITE)
            self.address = ctypes.addressof(ctypes.c_byte.from_buffer(self.mapping))
            self.dll = ctypes.WinDLL(str(dll_path))
            self.dll.RMCWriteFrame.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32]
            self.dll.RMCWriteFrame.restype = ctypes.c_long
            self.dll.RMCClearFrame.argtypes = [ctypes.c_void_p]
            self.dll.RMCClearFrame.restype = ctypes.c_long
            self.dll.RMCClearFrame(self.address)
        except Exception:
            if self.mapping:
                self.mapping.close()
            self.file.close()
            raise

    def send(self, frame):
        if frame.shape != (self.height, self.width, 3) or frame.dtype != np.uint8:
            raise ValueError("Native frame dimensions do not match output")
        data = nv12(frame)
        hr = self.dll.RMCWriteFrame(self.address, self.width, self.height, self.fps, data.ctypes.data, data.size)
        if hr < 0:
            raise ValueError("原生摄像头送帧失败：0x" + format(hr & 0xFFFFFFFF, "08x"))

    def close(self):
        if self.mapping:
            self.dll.RMCClearFrame(self.address)
            self.mapping.close()
            self.mapping = None
        self.file.close()


class NativeCamera:
    def __init__(self, width, height, fps):
        config = configuration()
        self.writer, self.mutex = None, None
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        self.kernel.CreateMutexW.restype = ctypes.c_void_p
        self.kernel.ReleaseMutex.argtypes = [ctypes.c_void_p]
        self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self.mutex = self.kernel.CreateMutexW(None, True, "Local\\RemoteMeetingCameraProducer-" + config["OwnerSid"])
        if not self.mutex or ctypes.get_last_error() == 183:
            if self.mutex:
                self.kernel.CloseHandle(self.mutex)
            self.mutex = None
            raise ValueError("已有另一份本地服务正在输出虚拟摄像头")
        try:
            result = subprocess.run([config["ControllerPath"], "publish"], capture_output=True, text=True, encoding="utf-8", timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode:
                raise ValueError("无法发布 Windows 原生摄像头：" + result.stdout.strip())
            messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            devices = [device for message in messages for device in message.get("devices", [])]
            self.device = next((d["name"] for d in devices if d.get("native")), None)
            if not self.device:
                raise ValueError("Windows 尚未枚举到原生虚拟摄像头，请重新安装")
            self.writer = FrameWriter(config["FramePath"], config["DllPath"], width, height, fps)
        except Exception:
            self.close()
            raise

    def send(self, frame):
        self.writer.send(frame)

    def close(self):
        if self.writer:
            self.writer.close()
            self.writer = None
        if self.mutex:
            self.kernel.ReleaseMutex(self.mutex)
            self.kernel.CloseHandle(self.mutex)
            self.mutex = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
