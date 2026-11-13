"""Build a Docker-load archive from verified official Python layers, without Docker.

Usage: python nas/build-image.py --output /path/remote-meeting-wol-amd64.tar.gz
The resulting archive is an IMAGE archive (docker save), not a container export.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
from urllib.request import Request, urlopen


REGISTRIES = {
    "docker": ("https://registry-1.docker.io/v2/library/python", "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/python:pull"),
    "ecr": ("https://public.ecr.aws/v2/docker/library/python", "https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:docker/library/python:pull"),
}
ACCEPT = ", ".join(("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"))


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()


def add_file(archive, name, data, mode=0o644):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = len(data), mode, 0
    archive.addfile(info, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--base", default="3.13-alpine", help="Python tag or immutable amd64 manifest digest")
    parser.add_argument("--registry", choices=REGISTRIES, default="docker", help="Docker official library or its public ECR mirror")
    parser.add_argument("--tag", default="remote-meeting-wol:1.0.0")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    registry, auth_url = REGISTRIES[args.registry]
    with urlopen(auth_url, timeout=30) as response:
        token = json.load(response)["token"]

    def fetch(path, expected=None):
        request = Request(registry + path, headers={"Authorization": "Bearer " + token, "Accept": ACCEPT})
        with urlopen(request, timeout=120) as response:
            data = response.read(100 * 1024 * 1024 + 1)
        if len(data) > 100 * 1024 * 1024:
            raise ValueError("Registry object exceeds size limit")
        if expected and digest(data) != expected:
            raise ValueError("Registry digest verification failed")
        return data

    raw = fetch("/manifests/" + args.base, args.base if args.base.startswith("sha256:") else None)
    manifest = json.loads(raw)
    if "manifests" in manifest:
        base_digest = next(item["digest"] for item in manifest["manifests"] if item.get("platform", {}).get("os") == "linux" and item["platform"].get("architecture") == "amd64")
        raw = fetch("/manifests/" + base_digest, base_digest)
        manifest = json.loads(raw)
    else:
        base_digest = digest(raw)
    config = json.loads(fetch("/blobs/" + manifest["config"]["digest"], manifest["config"]["digest"]))
    if config.get("architecture") != "amd64" or config.get("os") != "linux":
        raise ValueError("Expected linux/amd64 Python base")
    print("Verified Python base: " + base_digest, flush=True)
    layer_names = []
    diff_ids = config["rootfs"]["diff_ids"]
    if len(diff_ids) != len(manifest["layers"]):
        raise ValueError("Base layer count mismatch")
    # Use disk for each uncompressed layer, keeping builder RAM bounded.
    with tempfile.TemporaryDirectory(prefix="meeting-wol-image-") as temporary:
        temp = Path(temporary)
        for index, item in enumerate(manifest["layers"]):
            packed = fetch("/blobs/" + item["digest"], item["digest"])
            layer = gzip.decompress(packed) if packed.startswith(b"\x1f\x8b") else packed
            if digest(layer) != diff_ids[index]:
                raise ValueError("Uncompressed layer verification failed")
            name = digest(layer).split(":")[1]
            (temp / name).write_bytes(layer)
            layer_names.append(name)
            print("Verified base layer " + str(index + 1), flush=True)
        source = Path(__file__).with_name("agent.py").read_bytes()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as layer_tar:
            add_file(layer_tar, "app/agent.py", source, mode=0o444)
        layer = buffer.getvalue()
        app_digest = digest(layer)
        name = app_digest.split(":")[1]
        (temp / name).write_bytes(layer)
        layer_names.append(name)
        config["rootfs"]["diff_ids"].append(app_digest)
        config.setdefault("history", []).append({"created_by": "COPY agent.py /app/agent.py"})
        config["config"].update({"User": "65534:65534", "WorkingDir": "/app", "Entrypoint": None, "Cmd": ["python3", "/app/agent.py"], "Labels": {"org.opencontainers.image.title": "Remote Meeting NAS WOL", "org.opencontainers.image.base.digest": base_digest}})
        config["config"]["Env"] = [value for value in config["config"].get("Env", []) if not value.startswith(("PYTHONDONTWRITEBYTECODE=", "PYTHONUNBUFFERED="))] + ["PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1"]
        config.pop("container_config", None)
        config_data = canonical(config)
        config_name = digest(config_data).split(":")[1] + ".json"
        saved_manifest = [{"Config": config_name, "RepoTags": [args.tag], "Layers": [name + "/layer.tar" for name in layer_names]}]
        with tarfile.open(output, "w:gz") as archive:
            add_file(archive, config_name, config_data)
            add_file(archive, "manifest.json", canonical(saved_manifest))
            for name in layer_names:
                info = tarfile.TarInfo(name + "/layer.tar")
                info.size, info.mode, info.mtime = (temp / name).stat().st_size, 0o644, 0
                with (temp / name).open("rb") as layer_file:
                    archive.addfile(info, layer_file)
        # Validate the completed Docker archive against the config's diff IDs.
        with tarfile.open(output, "r:gz") as archive:
            for index, name in enumerate(layer_names):
                with archive.extractfile(name + "/layer.tar") as layer_file:
                    actual = "sha256:" + hashlib.file_digest(layer_file, "sha256").hexdigest()
                if actual != config["rootfs"]["diff_ids"][index]:
                    raise ValueError("Saved image layer verification failed")
    info = {"image": args.tag, "platform": "linux/amd64", "baseRegistry": registry, "baseManifest": base_digest, "agentSha256": hashlib.sha256(source).hexdigest(), "archiveSha256": hashlib.sha256(output.read_bytes()).hexdigest()}
    output.with_suffix(output.suffix + ".json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print("Saved and verified: " + str(output), flush=True)


if __name__ == "__main__":
    main()
