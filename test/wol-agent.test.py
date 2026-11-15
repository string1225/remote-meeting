import importlib.util
import json
import errno
from pathlib import Path
import socket
import threading
import time
import unittest
import uuid
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("wol_agent", Path(__file__).parents[1] / "nas" / "agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class WakeAgentTests(unittest.TestCase):
    def make_agent(self, sender=None, **env):
        return agent.Agent({"WOL_AGENT_KEY": "unit-test-separate-nas-credential-32-chars", "WOL_BASEMENT_MAC": "22-18-4D-11-5D-C0", **env}, sender=sender or (lambda *args: None))

    def command(self, **values):
        return {"id": str(uuid.uuid4()), "target": "basement", "expiresAt": time.time() * 1000 + 10000, **values}

    def test_packet_and_three_real_datagrams(self):
        expected = b"\xff" * 6 + bytes.fromhex("22184d115dc0") * 16
        self.assertEqual(agent.magic_packet("22:18:4d:11:5d:c0"), expected)
        received = []
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.bind(("127.0.0.1", 0))
            udp.settimeout(3)
            thread = threading.Thread(target=lambda: received.extend(udp.recvfrom(200)[0] for _ in range(3)))
            thread.start()
            agent.send_wake("22-18-4D-11-5D-C0", "127.0.0.1", udp.getsockname()[1])
            thread.join(4)
        self.assertEqual(received, [expected] * 3)

    def test_unicast_mac_validation(self):
        for mac in ("ff:ff:ff:ff:ff:ff", "00:00:00:00:00:00", "01:18:4d:11:5d:c0", "bad", "22:18:4d:11:5d:c0;whoami"):
            with self.assertRaises(ValueError):
                agent.magic_packet(mac)

    def test_allowlist_expiry_and_duplicate_delivery(self):
        sent = []
        client = self.make_agent(sender=lambda *args: sent.append(args))
        valid = self.command()
        self.assertTrue(client.execute(valid)["ok"])
        self.assertTrue(client.execute(valid)["ok"])
        self.assertEqual(len(sent), 1)
        for command in (self.command(target="small-room"), self.command(target="192.168.31.9"), self.command(expiresAt=0), self.command(expiresAt=time.time() * 1000 + 60000), self.command(expiresAt=float("nan")), self.command(expiresAt=True)):
            self.assertFalse(client.execute(command)["ok"])
        self.assertEqual(len(sent), 1)

    def test_failure_is_not_a_successful_receipt(self):
        def failure(*_args):
            raise OSError("test UDP failure")
        self.assertFalse(self.make_agent(sender=failure).execute(self.command())["ok"])

    def test_status_probes_both_fixed_ips_without_a_room_mac_or_wake_packets(self):
        probed, sent = [], []
        def probe(ip):
            probed.append(ip)
            return "online" if ip.endswith(".250") else "unreachable"
        client = agent.Agent({"WOL_AGENT_KEY": "unit-test-separate-nas-credential-32-chars"}, sender=lambda *args: sent.append(args), prober=probe)
        command = self.command(type="check", target=None)
        result = client.execute(command)
        self.assertTrue(result["ok"])
        self.assertEqual(result["states"], {"small-room": "online", "basement": "unreachable"})
        self.assertCountEqual(probed, ["192.168.31.250", "192.168.31.100"])
        self.assertEqual(sent, [])
        with patch.object(client.opener, "open") as opened:
            opened.return_value.__enter__.return_value.read.return_value = b'{"command":null}'
            self.assertIsNone(client.poll())
            advertised = json.loads(opened.call_args.args[0].data)["statusTargets"]
        self.assertEqual(set(advertised.values()), set(probed))
        self.assertEqual(advertised["small-room"], "192.168.31.250")
        self.assertEqual(client.execute(command), result)
        self.assertEqual(len(probed), 2)
        self.assertFalse(client.execute(self.command(type="check", target=None, expiresAt=0))["ok"])
        self.assertFalse(client.execute(self.command(type="check", target="192.168.31.1"))["ok"])
        self.assertEqual(len(probed), 2)

    def test_ping_and_tcp_refusal_both_prove_online_without_raw_socket_permission(self):
        with patch.object(agent, "ping_host", return_value=True), patch.object(agent.socket, "create_connection") as tcp:
            self.assertEqual(agent.probe_host("192.168.31.250"), "online")
            tcp.assert_not_called()
        with patch.object(agent, "ping_host", side_effect=PermissionError()), patch.object(agent.socket, "create_connection", side_effect=ConnectionRefusedError(errno.ECONNREFUSED, "closed")):
            self.assertEqual(agent.probe_host("192.168.31.250"), "online")
        with patch.object(agent, "ping_host", side_effect=TimeoutError()), patch.object(agent.socket, "create_connection", side_effect=TimeoutError()) as tcp:
            self.assertEqual(agent.probe_host("192.168.31.250"), "unreachable")
            self.assertEqual(tcp.call_count, 3)

    def test_configuration_does_not_allow_cleartext_or_arbitrary_destinations(self):
        for options in ({"MEETING_URL": "http://public.example/meeting/"}, {"MEETING_URL": "https://user:password@example.com/"}, {"WOL_AGENT_KEY": "short"}, {"WOL_SMALL_ROOM_MAC": "invalid"}, {"WOL_BROADCAST": "192.168.31.1"}):
            with self.assertRaises(ValueError):
                self.make_agent(**options)
        self.assertEqual(list(self.make_agent().targets), ["basement"])
        self.assertIn("small-room", self.make_agent(WOL_SMALL_ROOM_MAC="00:11:22:33:44:55").targets)


if __name__ == "__main__":
    unittest.main()
