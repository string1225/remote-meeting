import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("wol_image", Path(__file__).parents[1] / "nas" / "build-image.py")
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)


class ImageCompatibilityTests(unittest.TestCase):
    def test_legacy_reader_can_find_settings_and_follow_layers_without_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            layers = []
            for name in ("base.txt", "app/agent.py"):
                buffer = io.BytesIO()
                with tarfile.open(fileobj=buffer, mode="w") as layer:
                    image.add_file(layer, name, b"fixture")
                payload = buffer.getvalue()
                path = root / hashlib.sha256(payload).hexdigest()
                path.write_bytes(payload)
                layers.append(path)
            environment = image.image_environment(["PATH=/usr/local/bin:/usr/bin", "PYTHON_VERSION=3.13.9", "WOL_AGENT_KEY=discard-this-base-value"])
            settings = {"User": "65534:65534", "WorkingDir": "/app", "Cmd": ["python3", "/app/agent.py"], "Env": environment}
            config = {"created": "2026-11-05T19:30:27Z", "architecture": "amd64", "os": "linux", "config": settings,
                      "rootfs": {"type": "layers", "diff_ids": ["sha256:" + layer.name for layer in layers]}}
            for suffix in (".tar", ".tar.gz", ".tgz"):
                with self.subTest(suffix=suffix):
                    output = root / ("image" + suffix)
                    image.save_image(output, config, layers, "remote-meeting-wol:1.0.0")
                    self.assertEqual(output.read_bytes().startswith(b"\x1f\x8b"), suffix != ".tar")
                    with tarfile.open(output) as archive:
                        # QNAP may inspect the legacy index before asking Docker
                        # to load a modern manifest. Walk that format on its own.
                        repositories = json.load(archive.extractfile("repositories"))
                        identity = repositories["remote-meeting-wol"]["1.0.0"]
                        top = json.load(archive.extractfile(identity + "/json"))
                        self.assertEqual(top["config"], settings)
                        ordered = []
                        while identity:
                            self.assertTrue(archive.getmember(identity).isdir())
                            self.assertEqual(archive.extractfile(identity + "/VERSION").read(), b"1.0\n")
                            ordered.append(identity)
                            metadata = json.load(archive.extractfile(identity + "/json"))
                            self.assertEqual(metadata["id"], identity)
                            identity = metadata.get("parent")
                        self.assertEqual(ordered, [layer.name for layer in reversed(layers)])
                        manifest = json.load(archive.extractfile("manifest.json"))[0]
                        modern = json.load(archive.extractfile(manifest["Config"]))
                        for actual in (top["config"]["Env"], modern["config"]["Env"]):
                            variables = dict(value.split("=", 1) for value in actual)
                            self.assertEqual(len(actual), len(variables))
                            self.assertEqual(variables["MEETING_URL"], "https://home.sunny-string.cn/meeting/")
                            self.assertEqual(variables["WOL_AGENT_KEY"], "")
                            self.assertEqual(variables["WOL_BROADCAST"], "192.168.31.255")
                            self.assertEqual(variables["WOL_BASEMENT_MAC"], "22-18-4D-11-5D-C0")
                            self.assertEqual(variables["WOL_SMALL_ROOM_MAC"], "B8-88-E3-F9-AD-19")
                            self.assertEqual(variables["PATH"], "/usr/local/bin:/usr/bin")
                            self.assertEqual(variables["PYTHON_VERSION"], "3.13.9")
                            self.assertEqual(variables["PYTHONDONTWRITEBYTECODE"], "1")
                            self.assertEqual(variables["PYTHONUNBUFFERED"], "1")
                        for index, path in enumerate(manifest["Layers"]):
                            payload = archive.extractfile(path).read()
                            self.assertEqual("sha256:" + hashlib.sha256(payload).hexdigest(), modern["rootfs"]["diff_ids"][index])
                        self.assertFalse(any(member.pax_headers for member in archive.getmembers()))


if __name__ == "__main__":
    unittest.main()
