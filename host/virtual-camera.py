"""Read fixed-size RGBA frames from stdin and publish to the OBS camera."""
import json
import sys


def status(**message):
    print(json.dumps(message), flush=True)


def main():
    import numpy as np
    import pyvirtualcam
    width, height, fps = map(int, sys.argv[1:4])
    if (width, height) not in ((1280, 720), (1920, 1080)) or not 5 <= fps <= 30:
        raise ValueError("Unsupported virtual camera settings")
    size = width * height * 4
    with pyvirtualcam.Camera(width=width, height=height, fps=fps,
                             fmt=pyvirtualcam.PixelFormat.RGB, backend="obs") as camera:
        status(type="ready", device=camera.device)
        while True:
            data = sys.stdin.buffer.read(size)
            if not data:
                break
            if len(data) != size:
                raise ValueError("Incomplete video frame")
            rgba = np.frombuffer(data, np.uint8).reshape(height, width, 4)
            camera.send(np.ascontiguousarray(rgba[:, :, :3]))
            status(type="frame")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        status(type="error", message=str(error))
        sys.exit(1)
