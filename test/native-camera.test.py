import importlib.util
import pathlib
import unittest
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location("native_camera", pathlib.Path(__file__).parent.parent / "host" / "virtual-camera.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeCameraTests(unittest.TestCase):
    def test_selection_maps_browser_labels_without_selecting_ir_or_virtual(self):
        names = ["Surface Camera Rear", "Surface IR", "OBS Virtual Camera", "Surface Camera Front", "PC Camera"]
        self.assertEqual(native.select_cameras(names, []), [4, 3])
        self.assertEqual(native.select_cameras(names, ["PC Camera (eba4:6579)", "Surface Camera Front (045e:0990)"]), [4, 3])
        for configured in [["PC Camera", "PC Camera"], ["OBS Virtual Camera", "Surface Camera Front"], ["missing", "Surface Camera Front"]]:
            with self.assertRaises(ValueError):
                native.select_cameras(names, configured)

    def test_mirrored_usb_controls_keep_unmirrored_pip_in_lower_right(self):
        usb, pip = native.SyntheticSource(0).frame, native.SyntheticSource(1).frame
        for x, expected in [(0.25, [232, 59, 24]), (0.75, [25, 25, 232])]:
            image = native.compose(usb, pip, 1920, 1080, native.normalize(dict(zoom=2, x=x, y=0.5)))
            self.assertEqual(image.shape, (1080, 1920, 3))
            self.assertEqual(image[540, 960].tolist(), expected)
            self.assertEqual(image[907, 1497].tolist(), [64, 191, 20])
            self.assertEqual(image[907, 1800].tolist(), [22, 202, 232])
            self.assertEqual(image[1050, 1497].tolist(), [64, 191, 20])
            self.assertEqual(image[1050, 100].tolist(), expected)
            self.assertEqual(image[100, 1800].tolist(), expected)
        self.assertEqual(native.normalize(dict(zoom=2, x=0, y=1)), dict(zoom=2, x=0.25, y=0.75))
        for value in [float("inf"), float("nan"), True, "2"]:
            with self.assertRaises(ValueError):
                native.normalize(dict(zoom=value, x=0.5, y=0.5))

    def test_failed_or_oversized_capture_releases_the_device(self):
        class Camera:
            released = False
            def isOpened(self): return True
            def set(self, *args): pass
            def release(self): self.released = True
        for read in [(False, None), (True, np.zeros((1080, 3840, 3), np.uint8))]:
            camera = Camera()
            camera.read = lambda: read
            with patch.object(native.cv2, "VideoCapture", return_value=camera), self.assertRaises(ValueError):
                native.Source(0, "USB", 1920, 1080, 30)
            self.assertTrue(camera.released)


if __name__ == "__main__":
    unittest.main()
