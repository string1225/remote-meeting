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
            settings = {"User": "65534:65534", "WorkingDir": "/app", "Cmd": ["python3", "/app/agent.py"]}
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
                        for index, path in enumerate(manifest["Layers"]):
                            payload = archive.extractfile(path).read()
                            self.assertEqual("sha256:" + hashlib.sha256(payload).hexdigest(), modern["rootfs"]["diff_ids"][index])
                        self.assertFalse(any(member.pax_headers for member in archive.getmembers()))


if __name__ == "__main__":
    unittest.main()
