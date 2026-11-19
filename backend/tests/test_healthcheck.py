import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from thoth.apps.loader import AppsConfigError, load_apps
from thoth.apps.schema import ProcessService
from thoth.health.probe import probe


def svc(hc=None, port=None):
    d = {"id": "s", "kind": "process", "start": ["x"], "port": port, "healthcheck": hc}
    return ProcessService.model_validate(d)


@pytest.fixture
def http_server():
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(204 if self.path == "/ok" else 500)
            self.end_headers()

        def log_message(self, *a):
            pass

    s = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    yield s.server_address[1]
    s.shutdown()


def test_http(http_server):
    u = f"http://127.0.0.1:{http_server}"
    assert probe(svc({"type": "http", "url": u + "/ok", "expect_status": [204]})).ok
    assert not probe(svc({"type": "http", "url": u + "/ok"})).ok
    assert not probe(svc({"type": "http", "url": u + "/ng", "expect_status": [204]})).ok


def test_tcp_and_default():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen()
    port = s.getsockname()[1]
    assert probe(svc({"type": "tcp"}, port)).ok
    assert probe(svc(None, port)).ok  # 省略時は port があれば tcp
    s.close()
    assert not probe(svc({"type": "tcp"}, port)).ok


def test_pid():
    assert probe(svc({"type": "pid"}), pid=os.getpid()).ok
    assert not probe(svc({"type": "pid"}), pid=None).ok
    assert not probe(svc(None), pid=2**22 + 12345).ok  # 省略かつ port 無しは pid


def test_command():
    ok = svc({"type": "command", "command": [sys.executable, "-c", "pass"]})
    ng = svc({"type": "command", "command": [sys.executable, "-c", "raise SystemExit(3)"]})
    slow = svc(
        {
            "type": "command",
            "command": [sys.executable, "-c", "import time; time.sleep(5)"],
            "timeout": 1,
        }
    )
    assert probe(ok).ok
    assert probe(ng).message == "終了コード 3"
    assert "タイムアウト" in probe(slow).message


@pytest.mark.parametrize(
    "hc,port,msg",
    [
        ({"type": "tcp"}, None, "port が必須"),
        ({"type": "http"}, None, "url が必須"),
        ({"type": "command"}, None, "command が必須"),
        ({"type": "pid", "url": "http://127.0.0.1/"}, None, "url は type が http"),
        ({"type": "pid", "command": ["x"]}, None, "command は type が command"),
        ({"type": "foo"}, None, "type"),
        ({"type": "pid", "interval": 0}, None, "interval"),
        ({"type": "pid", "interval": 5, "timeout": 10}, None, "timeout は interval 以下"),
        ({"type": "pid", "failure_threshold": 0}, None, "failure_threshold"),
        ({"type": "pid", "expect_status": []}, None, "expect_status"),
        (
            {"type": "http", "url": "http://localhost/", "expect_status": [99]},
            None,
            "100〜599",
        ),
    ],
)
def test_invalid_config_rejected(tmp_path, hc, port, msg):
    import json

    body = {
        "apps": [
            {
                "id": "a",
                "name": "A",
                "workdir": str(tmp_path),
                "services": [
                    {"id": "s", "kind": "process", "start": ["x"], "port": port, "healthcheck": hc}
                ],
            }
        ]
    }
    p = tmp_path / "apps.yaml"
    p.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(AppsConfigError) as e:
        load_apps(p)
    assert msg in "\n".join(e.value.errors)
