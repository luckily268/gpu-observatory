#!/usr/bin/env python3
"""Serve the dashboard locally and read a configured remote collector on demand."""

import argparse
import json
import time
from http.client import HTTPException
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from server import DIST, MonitorHandler


MAX_REQUEST = 12_288
MAX_RESPONSE = 2_000_000
UPSTREAM_TIMEOUT = 5


class ViewerError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def connection_settings(payload):
    if not isinstance(payload, dict):
        raise ViewerError(400, "连接设置必须是 JSON 对象。")
    endpoint = payload.get("endpoint")
    token = payload.get("token", "")
    if not isinstance(endpoint, str) or not endpoint or len(endpoint) > 4096:
        raise ViewerError(400, "请输入有效的采集接口地址。")
    if not isinstance(token, str) or len(token) > 4096 or any(not 33 <= ord(char) <= 126 for char in token):
        raise ViewerError(400, "访问令牌只能包含非空格的 ASCII 字符。")
    if any(ord(char) < 33 or ord(char) > 126 or char in "\\?#" for char in endpoint):
        raise ViewerError(400, "采集接口地址不能包含空白、查询参数或片段。")
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError:
        raise ViewerError(400, "采集接口地址格式不正确。") from None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or "@" in parsed.netloc or port == 0:
        raise ViewerError(400, "请输入无内嵌账号密码的 HTTP(S) 采集接口地址。")
    return endpoint, token


def reject_constant(_):
    raise ValueError("Non-finite JSON numeric constant")


def read_metrics(endpoint, token):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # Send credentials over the selected direct connection only, with normal
    # TLS verification. Environment proxies and redirects are not followed.
    opener = build_opener(ProxyHandler({}), NoRedirect)
    request = Request(endpoint, headers=headers)
    deadline = time.monotonic() + UPSTREAM_TIMEOUT
    try:
        with opener.open(request, timeout=UPSTREAM_TIMEOUT) as response:
            raw = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError
                chunk = response.read1(min(65_536, MAX_RESPONSE + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > MAX_RESPONSE:
                    raise ViewerError(502, "采集器响应超过 2 MB。")
    except HTTPError as error:
        error.close()
        if error.code == 401:
            raise ViewerError(401, "采集器拒绝了令牌，请检查访问令牌。") from None
        if error.code == 403:
            raise ViewerError(403, "采集器拒绝访问，请检查采集器权限。") from None
        if 300 <= error.code < 400:
            raise ViewerError(502, "采集器重定向了请求，请填写最终接口地址。") from None
        raise ViewerError(502, f"采集器返回 HTTP {error.code}，请检查接口地址与服务状态。") from None
    except TimeoutError:
        raise ViewerError(504, "连接采集器超时，请检查地址和网络。") from None
    except URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise ViewerError(504, "连接采集器超时，请检查地址和网络。") from None
        raise ViewerError(502, "无法连接采集器，请检查地址、网络和证书。") from None
    except (OSError, HTTPException, ValueError):
        raise ViewerError(502, "连接采集器失败，请检查接口地址和网络。") from None

    try:
        payload = json.loads(raw, parse_constant=reject_constant)
        if (not isinstance(payload, dict) or payload.get("mode") != "live"
                or not isinstance(payload.get("timestamp"), str) or not isinstance(payload.get("nodes"), list)):
            raise ValueError("Unexpected metrics payload")
        # Validate numeric overflow and malformed Unicode before writing headers.
        return json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, RecursionError):
        raise ViewerError(502, "采集器未返回有效的实时监控数据。") from None


class ViewerHandler(MonitorHandler):
    timeout = 6

    def log_message(self, _format, *_args):
        pass

    def _headers(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()

    def _host(self):
        hosts = self.headers.get_all("Host", failobj=[])
        if len(hosts) != 1 or hosts[0] not in self.server.authorities:
            return None
        return hosts[0]

    def _get(self, head=False):
        if not self._host():
            return self._json(403, {"error": "请通过本机查看地址访问。"}, head)
        path = self.path.partition("?")[0]
        if path == "/api/viewer":
            return self._json(200, {"mode": "local-viewer"}, head)
        if path == "/api/metrics":
            return self._json(404, {"error": "请连接远端采集器。"}, head)
        return super()._get(head)

    def do_OPTIONS(self):
        self._json(405, {"error": "只接受同源请求。"})

    def do_POST(self):
        host = self._host()
        origins = self.headers.get_all("Origin", failobj=[])
        fetch_site = self.headers.get("Sec-Fetch-Site")
        if not host or origins != [f"http://{host}"] or fetch_site not in (None, "same-origin"):
            return self._json(403, {"error": "请从本机监控页面发起连接。"})
        if self.path != "/api/connect":
            return self._json(404, {"error": "接口不存在。"})
        if self.headers.get_content_type() != "application/json":
            return self._json(415, {"error": "请发送 application/json 请求。"})
        lengths = self.headers.get_all("Content-Length", failobj=[])
        try:
            length = int(lengths[0]) if len(lengths) == 1 else 0
        except ValueError:
            length = 0
        if self.headers.get("Transfer-Encoding") or not 1 <= length <= MAX_REQUEST:
            return self._json(400, {"error": "连接请求过大或长度无效。"})
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request body")
            payload = json.loads(raw, parse_constant=reject_constant)
        except (ValueError, RecursionError, TimeoutError):
            return self._json(400, {"error": "连接请求 JSON 无效。"})
        try:
            endpoint, token = connection_settings(payload)
            body = read_metrics(endpoint, token)
        except ViewerError as error:
            return self._json(error.status, {"error": str(error)})
        self._headers(200, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)


class ViewerServer(ThreadingHTTPServer):
    def __init__(self, port=8765, static_dir=DIST):
        self.static_dir = Path(static_dir).resolve()
        super().__init__(("127.0.0.1", port), ViewerHandler)
        suffix = "" if self.server_port == 80 else f":{self.server_port}"
        self.authorities = {f"127.0.0.1{suffix}", f"localhost{suffix}"}


def main():
    parser = argparse.ArgumentParser(description="Run the local GPU Observatory viewer")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        with ViewerServer(args.port) as server:
            print(f"GPU Observatory: http://127.0.0.1:{server.server_port}", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except OSError as error:
        parser.exit(1, f"无法启动本机查看服务：{error}\n")


if __name__ == "__main__":
    main()
