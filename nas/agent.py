"""Outbound HTTPS WOL agent; no listening ports or third-party dependencies."""
import json
from concurrent.futures import ThreadPoolExecutor
import errno
import math
import os
import re
import socket
import struct
import sys
import time
import uuid
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


TARGET_ENV = {"small-room": "WOL_SMALL_ROOM_MAC", "basement": "WOL_BASEMENT_MAC"}
TARGET_IPS = {"small-room": "192.168.31.150", "basement": "192.168.31.100"}


def ping_host(ip, timeout=0.8):
    """Unprivileged Linux ICMP; TCP checks still work if QNAP disallows it."""
    payload = os.urandom(16)
    packet = struct.pack("!BBHHH", 8, 0, 0, 0, 1) + payload
    total = sum(struct.unpack("!" + "H" * (len(packet) // 2), packet))
    total = (total & 0xffff) + (total >> 16)
    total = (total & 0xffff) + (total >> 16)
    packet = packet[:2] + struct.pack("!H", (~total) & 0xffff) + packet[4:]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP) as probe:
        probe.settimeout(timeout)
        probe.sendto(packet, (ip, 0))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            probe.settimeout(max(0.001, deadline - time.monotonic()))
            reply, address = probe.recvfrom(1024)
            if address[0] == ip and len(reply) >= 8 and reply[0] == 0 and reply[8:] == payload:
                return True
    return False


def probe_host(ip):
    try:
        if ping_host(ip):
            return "online"
    except OSError:
        pass
    # A refused TCP connection is also a live response from the computer.
    # Timeouts mean unresponsive, not proof that Windows has shut down.
    for port in (445, 135, 3389):
        try:
            with socket.create_connection((ip, port), timeout=0.6):
                return "online"
        except OSError as error:
            if error.errno == errno.ECONNREFUSED or getattr(error, "winerror", None) == 10061:
                return "online"
    return "unreachable"


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
    def __init__(self, env=None, sender=send_wake, prober=probe_host):
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
        self.prober = prober
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
        command_type = command.get("type", "wake")
        if command_type == "check" and target is None and valid_time:
            def inspect(item):
                name, ip = item
                try:
                    state = self.prober(ip)
                except OSError:
                    state = "unknown"
                return name, state if state in ("online", "unreachable", "unknown") else "unknown"
            with ThreadPoolExecutor(max_workers=2) as pool:
                result["states"] = dict(pool.map(inspect, TARGET_IPS.items()))
            result["ok"] = True
            print("Computer status check complete", flush=True)
        elif command_type == "wake" and isinstance(target, str) and target in self.targets and valid_time:
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
        payload = {"configured": list(self.targets), "capabilities": ["status"]}
        if result is not None:
            payload["result"] = result
        request = Request(self.url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={
            "Authorization": "Bearer " + self.key, "Content-Type": "application/json", "User-Agent": "remote-meeting-wol/1.1",
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
