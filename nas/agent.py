"""Outbound HTTPS WOL agent; no listening ports or third-party dependencies."""
import json
import math
import os
import re
import socket
import sys
import time
import uuid
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


TARGET_ENV = {"small-room": "WOL_SMALL_ROOM_MAC", "basement": "WOL_BASEMENT_MAC"}


def normalize_mac(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{12}|(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})", value):
        raise ValueError("MAC must contain six hexadecimal octets")
    mac = bytes.fromhex(value.replace(":", "").replace("-", ""))
    if mac == b"\0" * 6 or mac[0] & 1:
        raise ValueError("MAC must identify a unicast network adapter")
    return mac


def magic_packet(mac):
    return b"\xff" * 6 + normalize_mac(mac) * 16


def send_wake(mac, broadcast="192.168.31.255", port=9):
    packet = magic_packet(mac)
    # Standard UDP broadcast requires neither root nor NET_RAW privileges.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp.settimeout(2)
        for index in range(3):
            udp.sendto(packet, (broadcast, port))
            if index < 2:
                time.sleep(0.2)


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Meeting URL redirected; configure the final HTTPS URL")


class Agent:
    def __init__(self, env=None, sender=send_wake):
        env = os.environ if env is None else env
        url = env.get("MEETING_URL", "https://home.sunny-string.cn/meeting/")
        parsed = urlparse(url)
        local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if (parsed.scheme != "https" and not local) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("MEETING_URL must be an HTTPS meeting URL")
        self.url = url.rstrip("/") + "/api/wol/agent/poll"
        self.key = env.get("WOL_AGENT_KEY", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", self.key) or self.key.startswith("replace-"):
            raise ValueError("WOL_AGENT_KEY must be the separate random NAS credential")
        self.targets = {}
        for target, name in TARGET_ENV.items():
            value = env.get(name, "").strip()
            if value:
                try:
                    normalize_mac(value)
                except ValueError:
                    raise ValueError(name + " must be a valid unicast MAC address") from None
                self.targets[target] = value
        self.broadcast = env.get("WOL_BROADCAST", "192.168.31.255")
        if self.broadcast not in ("192.168.31.255", "255.255.255.255"):
            raise ValueError("WOL_BROADCAST must be a broadcast address for this home LAN")
        self.sender = sender
        self.seen = {}
        self.opener = build_opener(NoRedirects())

    def execute(self, command):
        if not isinstance(command, dict):
            raise ValueError("Invalid wake command")
        identity = command.get("id")
        if not isinstance(identity, str) or str(uuid.UUID(identity)) != identity:
            raise ValueError("Invalid wake command ID")
        if identity in self.seen:
            return self.seen[identity][1]
        now = time.time() * 1000
        target, expires = command.get("target"), command.get("expiresAt")
        valid_time = type(expires) in (float, int) and math.isfinite(expires) and now < expires <= now + 30000
        result = {"id": identity, "ok": False}
        if isinstance(target, str) and target in self.targets and valid_time:
            try:
                self.sender(self.targets[target], self.broadcast)
                result["ok"] = True
                print("Wake packet sent: " + target, flush=True)
            except OSError:
                print("Wake packet send failed: " + target, file=sys.stderr, flush=True)
        else:
            print("Rejected expired or unconfigured wake command", file=sys.stderr, flush=True)
        self.seen = {key: entry for key, entry in self.seen.items() if entry[0] > now - 600000}
        if len(self.seen) >= 100:
            self.seen.pop(next(iter(self.seen)))
        self.seen[identity] = (now, result)
        return result

    def poll(self, result=None):
        payload = {"configured": list(self.targets)}
        if result is not None:
            payload["result"] = result
        request = Request(self.url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={
            "Authorization": "Bearer " + self.key, "Content-Type": "application/json", "User-Agent": "remote-meeting-wol/1.0",
        })
        with self.opener.open(request, timeout=30) as response:
            raw = response.read(8193)
        if len(raw) > 8192:
            raise ValueError("Meeting response too large")
        data = json.loads(raw)
        if not isinstance(data, dict) or "command" not in data:
            raise ValueError("Invalid meeting response")
        return data["command"]

    def run(self):
        result, delay = None, 1
        print("NAS wake agent started; configured: " + (", ".join(self.targets) or "none"), flush=True)
        while True:
            try:
                command = self.poll(result)
                result = None
                if command is not None:
                    result = self.execute(command)
                delay = 1
            except Exception as error:
                # Do not log URLs, headers, credentials, or response bodies.
                print("Cloud connection failed (" + type(error).__name__ + "); retrying in " + str(delay) + "s", file=sys.stderr, flush=True)
                time.sleep(delay)
                delay = min(delay * 2, 30)


if __name__ == "__main__":
    try:
        Agent().run()
    except ValueError as error:
        print("Configuration error: " + str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        pass
