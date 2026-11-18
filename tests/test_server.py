import contextlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("monitor_server", ROOT / "server.py")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)

GPU_OUTPUT = '''0, GPU-a, NVIDIA A800-SXM4-80GB, 82, 71000, 81920, 54, 270.50
1, GPU-b, NVIDIA A800-SXM4-80GB, 0, 0, 81920, N/A, [Not Supported]
'''
PROCESS_OUTPUT = '''GPU-a, 2468, /usr/bin/python3, 16384
GPU-a, 3579, "python,worker", 8192
'''


class ParsingTests(unittest.TestCase):
    def test_gpu_units_and_unavailable_metrics(self):
        gpus = server.parse_gpus(GPU_OUTPUT)
        self.assertEqual(len(gpus), 2)
        self.assertEqual(gpus[0]["memoryTotalMb"], 81920)
        self.assertEqual(gpus[0]["powerWatts"], 270.5)
        self.assertIsNone(gpus[1]["temperature"])
        self.assertIsNone(gpus[1]["powerWatts"])
        self.assertIsNone(server.number("nan"))

    def test_quoted_process_names_and_empty_list(self):
        items = server.parse_processes(PROCESS_OUTPUT)
        self.assertEqual(items[1]["name"], "python,worker")
        self.assertEqual(server.parse_processes("\n"), [])
        with self.assertRaises(ValueError):
            server.parse_gpus("0, GPU-a, missing columns")

    def test_missing_gpu_tool_is_not_demo(self):
        with patch.object(server, "run_nvidia", side_effect=FileNotFoundError), patch.object(server, "psutil", None):
            node = server.collect_local("test-node")
        self.assertEqual(node["gpus"], [])
        self.assertEqual(node["name"], "test-node")
        self.assertIsNone(node["cpuPercent"])
        self.assertTrue(any("nvidia-smi" in warning for warning in node["warnings"]))

    def test_collect_processes_maps_by_gpu_uuid(self):
        with patch.object(server, "run_nvidia", side_effect=[GPU_OUTPUT, PROCESS_OUTPUT]), patch.object(server, "psutil", None):
            node = server.collect_local()
        self.assertEqual(len(node["gpus"][0]["processes"]), 2)
        self.assertEqual(len(node["gpus"][1]["processes"]), 0)
        self.assertEqual(node["gpus"][0]["processes"][0]["memoryMb"], 16384)

    @unittest.skipIf(server.psutil is None, "psutil not installed")
    def test_process_exit_does_not_drop_gpu_sample(self):
        with patch.object(server.psutil, "Process", side_effect=server.psutil.NoSuchProcess(2468)):
            detail = server.process_details(server.parse_processes(PROCESS_OUTPUT)[0])
        self.assertEqual(detail["pid"], 2468)
        self.assertEqual(detail["memoryMb"], 16384)
        self.assertIsNone(detail["user"])

    @unittest.skipIf(server.psutil is None, "psutil not installed")
    def test_denied_user_retains_other_fields(self):
        fake = MagicMock()
        fake.username.side_effect = server.psutil.AccessDenied(2468)
        fake.name.return_value = "trainer"
        fake.cmdline.return_value = ["python", "train.py"]
        fake.create_time.return_value = 100
        with patch.object(server.psutil, "Process", return_value=fake):
            detail = server.process_details(server.parse_processes(PROCESS_OUTPUT)[0], now=200)
        self.assertIsNone(detail["user"])
        self.assertEqual(detail["name"], "trainer")
        self.assertEqual(detail["elapsedSeconds"], 100)

    def test_failed_process_query_preserves_gpu_counters(self):
        with patch.object(server, "run_nvidia", side_effect=[GPU_OUTPUT, subprocess.TimeoutExpired("nvidia-smi", 4)]):
            node = server.collect_local()
        self.assertEqual(len(node["gpus"]), 2)
        self.assertTrue(any("进程" in warning for warning in node["warnings"]))

    @unittest.skipIf(server.psutil is None, "psutil not installed")
    def test_cpu_uses_timed_sample_in_collection_worker(self):
        with patch.object(server, "run_nvidia", return_value=""), patch.object(server.psutil, "cpu_percent", return_value=31.5) as cpu:
            node = server.collect_local()
        cpu.assert_called_once_with(interval=0.1)
        self.assertEqual(node["cpuPercent"], 31.5)


class StoreTests(unittest.TestCase):
    def test_upstream_disconnect_retains_explicitly_stale_sample(self):
        target = {"id": "remote", "url": "http://127.0.0.1:8766/api/metrics"}
        store = server.MetricsStore(upstreams=[target], include_local=False)
        previous = [{"id": "remote:node", "name": "node", "status": "online", "gpus": server.parse_gpus(GPU_OUTPUT)}]
        with patch.object(server, "fetch_upstream", return_value=previous):
            store.collect()
        with patch.object(server, "fetch_upstream", side_effect=OSError("disconnected")):
            store.collect()
        node = store.get()["nodes"][0]
        self.assertEqual(node["status"], "offline")
        self.assertTrue(node["stale"])
        self.assertEqual(node["gpus"][0]["utilization"], 82)

    def test_get_snapshot_is_isolated(self):
        store = server.MetricsStore()
        first = store.get()
        first["warnings"].append("mutation")
        self.assertNotIn("mutation", store.get()["warnings"])

    def test_upstream_config_rejects_credentials_in_url(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tests") as temp:
            filename = Path(temp) / "upstreams.json"
            filename.write_text(json.dumps([{"id": "bad", "url": "http://user:secret@host/api/metrics"}]))
            with self.assertRaises(ValueError):
                server.load_upstreams(filename)

    def test_upstream_stale_timestamp_cannot_become_fresh_aggregate(self):
        old = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()
        payload = {"mode": "live", "timestamp": old, "nodes": [{"id": "node", "gpus": server.parse_gpus(GPU_OUTPUT), "status": "online"}]}
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(payload).encode()
        with patch.object(server, "build_opener", return_value=opener):
            nodes = server.fetch_upstream({"id": "remote", "url": "https://collector.example/api/metrics"})
        self.assertTrue(nodes[0]["stale"])
        self.assertEqual(nodes[0]["status"], "offline")
        self.assertEqual(nodes[0]["sampledAt"], old)

    def test_aggregate_preserves_node_specific_sampling_cadence(self):
        observed = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
        payload = {
            "mode": "live", "timestamp": observed, "sampleIntervalSeconds": 60,
            "nodes": [
                {"id": "slow", "gpus": [], "status": "online"},
                {"id": "fast", "gpus": [], "status": "online", "sampleIntervalSeconds": 2},
            ],
        }
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(payload).encode()
        store = server.MetricsStore(interval=2, include_local=False, upstreams=[{"id": "upstream", "url": "https://collector.example/api/metrics"}])
        with patch.object(server, "build_opener", return_value=opener):
            store.collect()
        snapshot = store.get()
        self.assertEqual(snapshot["sampleIntervalSeconds"], 2)
        slow, fast = snapshot["nodes"]
        self.assertEqual(slow["sampleIntervalSeconds"], 60)
        self.assertEqual(slow["status"], "online")
        self.assertNotIn("stale", slow)
        self.assertEqual(fast["sampleIntervalSeconds"], 2)
        self.assertEqual(fast["status"], "offline")
        self.assertTrue(fast["stale"])

    def test_local_node_carries_actual_sample_interval(self):
        with patch.object(server, "run_nvidia", return_value=""):
            node = server.collect_local(interval=60)
        self.assertEqual(node["sampleIntervalSeconds"], 60)

    def test_malformed_upstream_root_does_not_poison_local_node(self):
        target = {"id": "remote", "url": "https://collector.example/api/metrics"}
        local = {"id": "healthy-local", "name": "local", "status": "online", "gpus": server.parse_gpus(GPU_OUTPUT)}
        for malformed in (None, [], 7, "unexpected", False):
            with self.subTest(root=malformed):
                opener = MagicMock()
                opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(malformed).encode()
                store = server.MetricsStore(upstreams=[target])
                with patch.object(server, "build_opener", return_value=opener), patch.object(server, "collect_local", return_value=local):
                    store.collect()
                snapshot = store.get()
                self.assertEqual(snapshot["nodes"][0]["id"], "healthy-local")
                self.assertEqual(snapshot["nodes"][0]["status"], "online")
                self.assertNotIn("stale", snapshot["nodes"][0])
                self.assertEqual(snapshot["nodes"][1]["status"], "offline")
                self.assertTrue(snapshot["warnings"])


@contextlib.contextmanager
def running_server(static_dir):
    store = server.MetricsStore()
    store.snapshot = {"mode": "live", "timestamp": "2026-11-10T12:00:00+00:00", "nodes": [], "warnings": []}
    http = server.MonitorServer(("127.0.0.1", 0), store, token="test-secret", allowed_origin="https://dashboard.example", static_dir=static_dir)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield http, f"http://127.0.0.1:{http.server_port}"
    finally:
        http.shutdown()
        http.server_close()
        thread.join(timeout=2)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "tests")
        self.dist = Path(self.temp.name) / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<!doctype html><title>Dashboard</title>")
        (Path(self.temp.name) / "secret.txt").write_text("secret")
        (self.dist / ".env").write_text("secret")

    def tearDown(self):
        self.temp.cleanup()

    def test_auth_cors_and_cached_api(self):
        with running_server(self.dist) as (http, base):
            with self.assertRaises(HTTPError) as error:
                urlopen(base + "/api/metrics")
            self.assertEqual(error.exception.code, 401)
            request = Request(base + "/api/metrics", headers={"Authorization": "Bearer test-secret", "Origin": "https://dashboard.example"})
            with patch.object(server, "run_nvidia", side_effect=AssertionError("API must use cached metrics")):
                with urlopen(request) as response:
                    self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://dashboard.example")
                    self.assertEqual(json.load(response)["mode"], "live")
            request = Request(base + "/api/metrics", headers={"Authorization": "Bearer test-secret", "Origin": "https://evil.example"})
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            self.assertEqual(error.exception.code, 403)

    def test_preflight_does_not_require_bearer(self):
        with running_server(self.dist) as (_, base):
            request = Request(base + "/api/metrics", method="OPTIONS", headers={"Origin": "https://dashboard.example"})
            with urlopen(request) as response:
                self.assertEqual(response.status, 204)
                self.assertIn("Authorization", response.headers["Access-Control-Allow-Headers"])
                self.assertNotIn("*", response.headers["Access-Control-Allow-Origin"])

    def test_loopback_rejects_rebinding_host_without_origin(self):
        with running_server(self.dist) as (http, base):
            # Rebinding must be blocked even for a tokenless loopback collector.
            http.token = ""
            request = Request(base + "/api/metrics", headers={"Host": "attacker.example"})
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
            self.assertEqual(error.exception.code, 403)
            with urlopen(base + "/api/metrics") as response:
                self.assertEqual(response.status, 200)
            http.allowed_hosts.add("trusted-proxy.example")
            request = Request(base + "/api/metrics", headers={"Host": "trusted-proxy.example"})
            with urlopen(request) as response:
                self.assertEqual(response.status, 200)

    def test_only_static_assets_and_health_are_public(self):
        with running_server(self.dist) as (_, base):
            with urlopen(base + "/") as response:
                self.assertIn(b"Dashboard", response.read())
            with urlopen(base + "/health") as response:
                self.assertEqual(json.load(response)["status"], "ok")
            for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/.env", "/server.py", "/dist/", "/%5c..%5csecret.txt"):
                with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                    urlopen(base + path)
                self.assertEqual(error.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
