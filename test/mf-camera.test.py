"""Windows acceptance: Python producer -> separate COM media source process."""
import json
import pathlib
import subprocess
import struct
import sys
import tempfile
import threading
import time
import unittest

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "host"))
from mf_camera import FrameWriter, MAPPING_BYTES, nv12


class MediaFoundationCameraTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = ROOT / ".local/mf-camera/bin/RemoteMeetingCamera.exe"
        cls.dll = cls.controller.with_name("RemoteMeetingMediaSource.dll")
        if sys.platform != "win32" or not cls.controller.exists():
            raise unittest.SkipTest("Build the Windows Media Foundation source first")

    def samples(self, path):
        result = subprocess.run([str(self.controller), "self-test", str(self.dll), str(path)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        messages = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(messages[-1]["selfTest"])
        samples = [m for m in messages if m.get("sample")]
        self.assertEqual({(m["width"], m["height"], m["format"]) for m in samples},
                         {(w, h, f) for w, h in [(1920, 1080), (1280, 720), (640, 360)] for f in ["NV12", "YUY2"]})
        return samples

    def test_transport_conversion_expiry_and_close(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "frame.nv12"
            with path.open("wb") as file:
                file.truncate(MAPPING_BYTES)
            self.assertTrue(all(m["luma"] == 16 for m in self.samples(path)))
            # Simulate a producer killed while writing; startup must recover.
            with path.open("r+b") as file:
                file.seek(8)
                file.write(struct.pack("<I", 1))
            writer = FrameWriter(path, self.dll, 1920, 1080, 30)
            frame = np.empty((1080, 1920, 3), np.uint8)
            frame[:] = [25, 25, 232]
            expected_luma = int(nv12(frame)[0])
            stop = threading.Event()
            def produce():
                while not stop.is_set():
                    writer.send(frame)
                    stop.wait(1 / 30)
            thread = threading.Thread(target=produce)
            try:
                writer.send(frame)
                thread.start()
                self.assertTrue(all(m["luma"] == expected_luma for m in self.samples(path)))
                with self.assertRaises(ValueError):
                    writer.send(frame[:100])
                stop.set()
                thread.join()
                time.sleep(2.1)
                self.assertTrue(all(m["luma"] == 16 for m in self.samples(path)))
            finally:
                stop.set()
                if thread.is_alive():
                    thread.join()
                writer.close()
            self.assertEqual(path.read_bytes()[64:], bytes(MAPPING_BYTES - 64))
            self.assertTrue(all(m["luma"] == 16 for m in self.samples(path)))


if __name__ == "__main__":
    unittest.main()
