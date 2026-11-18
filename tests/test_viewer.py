import contextlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import patch

from viewer import MAX_RESPONSE, ViewerServer


SAMPLE = {"mode": "live", "timestamp": "2026-11-18T12:00:00Z", "nodes": [{"id": "a800", "gpus": []}]}


@contextlib.contextmanager
def running(server):
    with server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join(timeout=2)


class SampleCollector(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get("Authorization")))
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/redirect-target")
            self.end_headers()
            return
        status = {"/unauthorized": 401, "/forbidden": 403}.get(self.path, 200)
        body = json.dumps(SAMPLE).encode()
        if self.path == "/non-finite":
            body = b'{"mode":"live","timestamp":"2026-11-18T12:00:00Z","nodes":[],"field": 1e999}'
        if self.path == "/oversized":
            body += b" " * MAX_RESPONSE
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The viewer stops reading an oversized response.


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.viewer = self.run_server(ViewerServer(0))
        self.origin = f"http://127.0.0.1:{self.viewer.server_port}"

    def run_server(self, server):
        context = running(server)
        self.addCleanup(context.__exit__, None, None, None)
        return context.__enter__()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.viewer.server_port, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            with connection.getresponse() as response:
                return response.status, dict(response.headers), json.load(response)
        finally:
            connection.close()

    def connect(self, endpoint, token="sample-token", headers=None):
        request_headers = {"Origin": self.origin, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}
        request_headers.update(headers or {})
        body = json.dumps({"endpoint": endpoint, "token": token})
        return self.request("POST", "/api/connect", body, request_headers)

    def start_collector(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), SampleCollector)
        upstream.requests = []
        self.run_server(upstream)
        return upstream, f"http://127.0.0.1:{upstream.server_port}"

    def test_viewer_marker_and_no_local_metrics(self):
        status, _, body = self.request("GET", "/api/viewer")
        self.assertEqual((status, body), (200, {"mode": "local-viewer"}))
        self.assertEqual(self.request("GET", "/api/metrics")[0], 404)
        self.assertEqual(self.request("GET", "/api/viewer", headers={"Host": "rebind.example"})[0], 403)

    def test_proxy_rejects_cross_origin_or_invalid_request_before_network(self):
        endpoint = "http://127.0.0.1:9999/api/metrics"
        invalid = [
            (403, {"Origin": "https://example.test"}),
            (403, {"Origin": f"{self.origin}0"}),
            (403, {"Origin": ""}),
            (403, {"Host": f"localhost:{self.viewer.server_port}"}),
            (403, {"Sec-Fetch-Site": "same-site"}),
            (415, {"Content-Type": "text/plain"}),
        ]
        with patch("viewer.read_metrics", side_effect=AssertionError("unexpected network request")):
            for expected, headers in invalid:
                with self.subTest(headers=headers):
                    status, response_headers, _ = self.connect(endpoint, headers=headers)
                    self.assertEqual(status, expected)
                    self.assertNotIn("Access-Control-Allow-Origin", response_headers)
            self.assertEqual(self.request("POST", "/api/connect", b"{}", {"Content-Type": "application/json"})[0], 403)
            self.assertEqual(self.request("OPTIONS", "/api/connect", headers={"Origin": "https://example.test"})[0], 405)
            self.assertEqual(self.connect("https://user:pass@example.test/api/metrics")[0], 400)
            self.assertEqual(self.connect("https://example.test/api/metrics?token=secret")[0], 400)
            self.assertEqual(self.connect("https://example.test/api/metrics#secret")[0], 400)
            self.assertEqual(self.connect(endpoint, token="bad\r\nheader")[0], 400)

    def test_get_metrics_with_request_local_token_and_never_follow_redirect(self):
        upstream, endpoint = self.start_collector()
        status, headers, payload = self.connect(f"{endpoint}/prefix/api/metrics")
        self.assertEqual((status, payload), (200, SAMPLE))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.connect(f"{endpoint}/prefix/api/metrics", token="")[0], 200)
        self.assertEqual(self.connect(f"{endpoint}/redirect")[0], 502)
        self.assertEqual(upstream.requests, [
            ("/prefix/api/metrics", "Bearer sample-token"),
            ("/prefix/api/metrics", None),
            ("/redirect", "Bearer sample-token"),
        ])

    def test_credential_errors_and_malformed_response(self):
        _, endpoint = self.start_collector()
        for path, expected in [
            ("/unauthorized", 401), ("/forbidden", 403), ("/non-finite", 502), ("/oversized", 502),
        ]:
            with self.subTest(path=path):
                status, headers, payload = self.connect(endpoint + path)
                self.assertEqual(status, expected)
                self.assertIn("error", payload)
                self.assertNotIn("sample-token", json.dumps(payload))
                self.assertNotIn("Access-Control-Allow-Origin", headers)


if __name__ == "__main__":
    unittest.main()
