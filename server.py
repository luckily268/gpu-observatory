#!/usr/bin/env python3
"""Read-only NVIDIA monitoring API and static dashboard server.

Run: python server.py --host 127.0.0.1 --port 8765
No shell, SSH password, or privileged process control is used.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hmac
import io
import json
import logging
import math
import mimetypes
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    import psutil
except ImportError:
    psutil = None


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
LOG = logging.getLogger("gpu-monitor")
GPU_FIELDS = "index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
PROCESS_FIELDS = "gpu_uuid,pid,process_name,used_gpu_memory"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def number(value, integer=False):
    """NVIDIA uses N/A / [Not Supported] for unavailable counters."""
    try:
        result = float(str(value).strip())
        if not math.isfinite(result):
            return None
        return int(result) if integer else round(result, 2)
    except (ValueError, TypeError):
        return None


def sample_interval(value, fallback=2):
    """Keep each source's sampling cadence when aggregating nested collectors."""
    try:
        interval = float(value)
        return interval if math.isfinite(interval) and interval > 0 else fallback
    except (ValueError, TypeError):
        return fallback


def parse_gpus(output):
    gpus = []
    for row in csv.reader(io.StringIO(output), skipinitialspace=True):
        if not row or not any(cell.strip() for cell in row):
            continue
        if len(row) != 8:
            raise ValueError("Unexpected NVIDIA GPU CSV columns")
        index = number(row[0], integer=True)
        if index is None:
            raise ValueError("Invalid GPU index")
        gpus.append({
            "index": index,
            "uuid": row[1].strip(),
            "name": row[2].strip(),
            "utilization": number(row[3]),
            "memoryUsedMb": number(row[4]),
            "memoryTotalMb": number(row[5]),
            "temperature": number(row[6]),
            "powerWatts": number(row[7]),
            "processes": [],
        })
    return gpus


def parse_processes(output):
    processes = []
    for row in csv.reader(io.StringIO(output), skipinitialspace=True):
        if not row or not any(cell.strip() for cell in row):
            continue
        if len(row) != 4:
            raise ValueError("Unexpected NVIDIA process CSV columns")
        pid = number(row[1], integer=True)
        if pid is None:
            continue
        processes.append({
            "gpuUuid": row[0].strip(),
            "pid": pid,
            "name": row[2].strip(),
            "memoryMb": number(row[3]),
        })
    return processes


def run_nvidia(query):
    completed = subprocess.run(
        ["nvidia-smi", query, "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=4, check=True,
        encoding="utf-8", errors="replace",
    )
    return completed.stdout


def process_details(item, now=None):
    """A process can exit or be inaccessible between NVIDIA and OS samples."""
    result = {
        "pid": item["pid"], "name": item["name"], "user": None,
        "command": item["name"], "memoryMb": item["memoryMb"],
        "elapsedSeconds": None,
    }
    if psutil is None:
        return result
    now = time.time() if now is None else now
    try:
        process = psutil.Process(item["pid"])
        with process.oneshot():
            # Query independently: one denied field should not erase other fields.
            for field, reader in (("user", process.username), ("name", process.name)):
                try:
                    result[field] = reader()
                except (psutil.Error, OSError):
                    pass
            try:
                command = process.cmdline()
                if command:
                    result["command"] = " ".join(command)[:2048]
            except (psutil.Error, OSError):
                pass
            try:
                result["elapsedSeconds"] = max(0, int(now - process.create_time()))
            except (psutil.Error, OSError):
                pass
    except (psutil.Error, OSError):
        pass
    return result


def collect_local(node_name=None, interval=2):
    hostname = socket.gethostname()
    try:
        address = socket.gethostbyname(hostname)
    except OSError:
        address = hostname
    warnings = []
    node = {
        "id": os.environ.get("MONITOR_NODE_ID", hostname),
        "name": node_name or os.environ.get("MONITOR_NODE_NAME", hostname),
        "host": address, "status": "online", "cpuPercent": None,
        "ramUsedGb": None, "ramTotalGb": None, "uptimeSeconds": None,
        "gpus": [], "sampledAt": iso_now(), "warnings": warnings,
        "sampleIntervalSeconds": sample_interval(interval),
    }
    if psutil is None:
        warnings.append("未安装 psutil；CPU、内存与进程用户信息不可用。")
    else:
        try:
            memory = psutil.virtual_memory()
            node.update(
                # Each collection uses a worker thread; a timed sample avoids
                # psutil's per-thread, first-call cpu_percent(None) zero value.
                cpuPercent=psutil.cpu_percent(interval=0.1),
                ramUsedGb=round(memory.used / (1024 ** 3), 2),
                ramTotalGb=round(memory.total / (1024 ** 3), 2),
                uptimeSeconds=max(0, int(time.time() - psutil.boot_time())),
            )
        except (psutil.Error, OSError):
            warnings.append("系统指标暂时不可用。")
    try:
        node["gpus"] = parse_gpus(run_nvidia(f"--query-gpu={GPU_FIELDS}"))
    except FileNotFoundError:
        warnings.append("未找到 nvidia-smi；请确认此节点已安装 NVIDIA 驱动且有可见的 NVIDIA GPU。")
        return node
    except (subprocess.SubprocessError, ValueError, OSError):
        warnings.append("GPU 指标采集失败，请检查 nvidia-smi、驱动与容器 GPU 权限。")
        return node
    if not node["gpus"]:
        warnings.append("当前节点没有可见的 NVIDIA GPU。")
        return node
    try:
        processes = parse_processes(run_nvidia(f"--query-compute-apps={PROCESS_FIELDS}"))
        gpu_map = {gpu["uuid"]: gpu for gpu in node["gpus"]}
        details = {}
        for item in processes:
            if item["gpuUuid"] not in gpu_map:
                warnings.append("存在无法映射到物理 GPU 的进程；MIG 实例需额外采集适配。")
                continue
            if item["pid"] not in details:
                details[item["pid"]] = process_details(item)
            detail = dict(details[item["pid"]], memoryMb=item["memoryMb"])
            gpu_map[item["gpuUuid"]]["processes"].append(detail)
    except (subprocess.SubprocessError, ValueError, OSError):
        warnings.append("GPU 指标已采集，但计算进程列表暂时不可用。")
    node["warnings"] = list(dict.fromkeys(warnings))
    return node


def load_upstreams(filename):
    if not filename:
        return []
    config = json.loads(Path(filename).read_text(encoding="utf-8-sig"))
    if not isinstance(config, list) or len(config) > 32:
        raise ValueError("upstreams must be a JSON array with at most 32 targets")
    for target in config:
        if not isinstance(target, dict) or not isinstance(target.get("id"), str):
            raise ValueError("Each upstream needs a unique string id")
        parsed = urlsplit(target.get("url", ""))
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Upstream URL must be an HTTP(S) URL without embedded credentials")
        if target.get("token") is not None and not isinstance(target["token"], str):
            raise ValueError("Upstream token must be a string")
    if len({target["id"] for target in config}) != len(config):
        raise ValueError("Upstream ids must be unique")
    return config


def fetch_upstream(target):
    headers = {"Accept": "application/json"}
    if target.get("token"):
        headers["Authorization"] = f"Bearer {target['token']}"
    request = Request(target["url"], headers=headers)
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, new_url):
            return None

    # Never forward a collector's bearer token to a redirected endpoint.
    with build_opener(NoRedirect).open(request, timeout=4) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("Upstream response too large")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or payload.get("mode") != "live" or not isinstance(payload.get("nodes"), list):
        raise ValueError("Upstream did not return live metrics")
    upstream_interval = sample_interval(payload.get("sampleIntervalSeconds"))
    nodes = []
    for index, original in enumerate(payload["nodes"]):
        if not isinstance(original, dict) or not isinstance(original.get("gpus"), list):
            raise ValueError("Invalid upstream node")
        node = copy.deepcopy(original)
        node["id"] = f"{target['id']}:{node.get('id', index)}"
        node["sampleIntervalSeconds"] = sample_interval(node.get("sampleIntervalSeconds"), upstream_interval)
        freshness_seconds = max(15, node["sampleIntervalSeconds"] * 3)
        node["sampledAt"] = node.get("sampledAt") or payload.get("timestamp")
        try:
            sampled = datetime.fromisoformat(node["sampledAt"].replace("Z", "+00:00"))
            if sampled.tzinfo is None:
                raise ValueError("Timestamp needs timezone")
            age = (datetime.now(timezone.utc) - sampled).total_seconds()
            expired = age > freshness_seconds or age < -300
        except (ValueError, TypeError, AttributeError):
            expired = True
        if expired:
            node.update(status="offline", stale=True)
            node["warnings"] = list(node.get("warnings", [])) + ["远端采集值时间过旧或时间戳无效，请检查采集器与服务器时钟。"]
        if target.get("name") and len(payload["nodes"]) == 1:
            node["name"] = target["name"]
        nodes.append(node)
    return nodes


class MetricsStore:
    def __init__(self, interval=2, node_name=None, upstreams=None, include_local=True):
        self.interval = max(0.5, interval)
        self.node_name = node_name
        self.upstreams = upstreams or []
        self.include_local = include_local
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.snapshot = {
            "mode": "live", "timestamp": iso_now(), "nodes": [],
            "warnings": ["采集器正在初始化，请等待下一次刷新。"], "collecting": True,
        }
        self.thread = threading.Thread(target=self._run, name="metrics-sampler", daemon=True)
        self.upstream_cache = {}

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=1)

    def get(self):
        with self.lock:
            return copy.deepcopy(self.snapshot)

    def collect(self):
        nodes, warnings = [], []
        with ThreadPoolExecutor(max_workers=min(8, len(self.upstreams) + 1)) as pool:
            local_future = pool.submit(collect_local, self.node_name, self.interval) if self.include_local else None
            futures = [(target, pool.submit(fetch_upstream, target)) for target in self.upstreams]
            if local_future:
                nodes.append(local_future.result())
            for target, future in futures:
                try:
                    remote_nodes = future.result()
                    self.upstream_cache[target["id"]] = remote_nodes
                    nodes.extend(remote_nodes)
                except (HTTPError, URLError, OSError, ValueError, TypeError, KeyError, TimeoutError):
                    # Keep last observed counters, explicitly marked offline/stale.
                    previous = copy.deepcopy(self.upstream_cache.get(target["id"], []))
                    if not previous:
                        previous = [{
                            "id": target["id"], "name": target.get("name", target["id"]),
                            "host": urlsplit(target["url"]).hostname, "gpus": [],
                            "cpuPercent": None, "ramUsedGb": None, "ramTotalGb": None,
                            "uptimeSeconds": None, "sampledAt": None,
                        }]
                    for node in previous:
                        node.update(status="offline", stale=True, warnings=["远端采集器连接失败，保留最后一次观测值。"])
                    nodes.extend(previous)
                    warnings.append(f"节点 {target.get('name', target['id'])} 的采集器不可用。")
        payload = {
            "mode": "live", "timestamp": iso_now(), "nodes": nodes,
            "warnings": warnings, "collecting": False, "sampleIntervalSeconds": self.interval,
        }
        with self.lock:
            self.snapshot = payload

    def _run(self):
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                self.collect()
            except Exception:
                LOG.exception("Metrics sampling failed")
                with self.lock:
                    failed = copy.deepcopy(self.snapshot)
                    failed["warnings"] = ["采集失败，当前为最后一次观测值。"]
                    failed["collecting"] = False
                    for node in failed["nodes"]:
                        node.update(status="offline", stale=True)
                    self.snapshot = failed
            self.stop_event.wait(max(0.05, self.interval - (time.monotonic() - started)))


class MonitorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, token="", allowed_origin="", static_dir=DIST, allowed_hosts=None):
        self.store = store
        self.token = token
        self.allowed_origin = allowed_origin.rstrip("/")
        self.allowed_hosts = {"127.0.0.1", "localhost", "::1"}
        self.allowed_hosts.update(host.lower() for host in (allowed_hosts or []))
        self.static_dir = Path(static_dir).resolve()
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, MonitorHandler)


class MonitorHandler(BaseHTTPRequestHandler):
    server_version = "GPUObservatory/1.0"

    def log_message(self, format, *args):
        # Do not log request headers or query strings (tokens are never in URLs).
        LOG.info("%s %s", self.client_address[0], args[1] if len(args) > 1 else "request")

    def _origin_allowed(self):
        # Browsers can omit Origin on same-origin GETs. Validate Host before
        # the no-Origin shortcut to prevent DNS rebinding into a loopback API.
        host = self.headers.get("Host", "")
        try:
            requested_host = urlsplit(f"//{host}").hostname
        except ValueError:
            return False
        bound_host = self.server.server_address[0]
        if bound_host in {"127.0.0.1", "::1"} and requested_host not in self.server.allowed_hosts:
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if self.server.allowed_origin and origin == self.server.allowed_origin:
            return True
        # Browser same-origin requests require no CORS configuration.
        return origin in (f"http://{host}", f"https://{host}")

    def _headers(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()

    def _json(self, status, payload, head=False):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        if not head:
            self.wfile.write(body)

    def do_OPTIONS(self):
        if urlsplit(self.path).path != "/api/metrics":
            return self._json(404, {"error": "Not found"})
        if not self._origin_allowed():
            return self._json(403, {"error": "Origin not allowed"})
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._get(head=True)

    def do_GET(self):
        self._get()

    def _get(self, head=False):
        path = urlsplit(self.path).path
        if path == "/health":
            return self._json(200, {"status": "ok", "service": "gpu-observatory"}, head)
        if path == "/api/metrics":
            if not self._origin_allowed():
                return self._json(403, {"error": "Origin not allowed"}, head)
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {self.server.token}"
            if self.server.token and not hmac.compare_digest(supplied.encode(), expected.encode()):
                return self._json(401, {"error": "Bearer token required"}, head)
            return self._json(200, self.server.store.get(), head)
        try:
            decoded = unquote(path)
            parts = Path(decoded.lstrip("/")).parts
            if "\\" in decoded or any(part.startswith(".") for part in parts):
                return self._json(404, {"error": "Not found"}, head)
            candidate = (self.server.static_dir / (decoded.lstrip("/") or "index.html")).resolve()
            candidate.relative_to(self.server.static_dir)
            if not candidate.is_file() or candidate.suffix.lower() not in {
                ".html", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2",
            }:
                return self._json(404, {"error": "Not found"}, head)
            body = candidate.read_bytes()
        except (OSError, ValueError):
            return self._json(404, {"error": "Not found"}, head)
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix in {".html", ".js", ".css", ".svg"}:
            content_type += "; charset=utf-8"
        self._headers(200, content_type, len(body))
        if not head:
            self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Read-only NVIDIA GPU monitoring dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--interval", type=float, default=2, help="sampling interval in seconds (minimum 0.5)")
    parser.add_argument("--name", default=None, help="display name of the local server")
    parser.add_argument("--upstreams", default=os.environ.get("MONITOR_UPSTREAMS_FILE"), help="private JSON file with remote collector targets")
    parser.add_argument("--no-local", action="store_true", help="only aggregate remote collectors")
    args = parser.parse_args()
    token = os.environ.get("MONITOR_TOKEN", "")
    origin = os.environ.get("MONITOR_ALLOWED_ORIGIN", "")
    allowed_hosts = [host.strip().lower() for host in os.environ.get("MONITOR_ALLOWED_HOSTS", "").split(",") if host.strip()]
    if any(any(character in host for character in "/*?#@\\ \t\r\n") for host in allowed_hosts):
        parser.error("MONITOR_ALLOWED_HOSTS must contain exact comma-separated hostnames, without a scheme, path or wildcard.")
    if args.host not in {"127.0.0.1", "localhost", "::1"} and not token:
        parser.error("Non-loopback binding requires MONITOR_TOKEN. Prefer a loopback collector plus SSH tunnel.")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            parser.error("MONITOR_ALLOWED_ORIGIN must be one exact HTTP(S) origin, without a path or wildcard.")
    try:
        upstreams = load_upstreams(args.upstreams)
    except (OSError, ValueError, TypeError) as error:
        parser.error(f"Invalid upstream configuration: {error}")
    if args.no_local and not upstreams:
        parser.error("--no-local needs at least one upstream collector")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = MetricsStore(args.interval, args.name, upstreams, not args.no_local)
    server = MonitorServer((args.host, args.port), store, token, origin, allowed_hosts=allowed_hosts)
    store.start()
    LOG.info("Dashboard: http://%s:%d (read-only, sampling every %.1fs)", args.host, args.port, store.interval)
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        store.stop()


if __name__ == "__main__":
    main()
