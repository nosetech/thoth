import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_process import CSRF, engine, make_apps, mgr  # noqa: F401

from thoth.api.deps import get_process_manager, get_registry_holder, get_session
from thoth.apps.registry import RegistryHolder
from thoth.db.models import AppState
from thoth.main import app as fastapi_app
from thoth.process.env import ProcessConfigError, build_env

MODES = (
    "modes: {local: {}, lan: {env: {LAN_IP: '${LAN_IP}'}},"
    " vpn: {env: {TAILSCALE_IP: '${TAILSCALE_IP}'}}}"
)


@pytest.fixture
def api(tmp_path, mgr, engine, monkeypatch):  # noqa: F811
    monkeypatch.setenv("LAN_IP", "192.168.0.5")
    monkeypatch.delenv("TAILSCALE_IP", raising=False)
    make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [sleep, '60'], stop_timeout: 3}\n",
        extra=MODES,
    )
    holder = RegistryHolder(tmp_path / "apps.yaml")
    fastapi_app.dependency_overrides[get_registry_holder] = lambda: holder
    fastapi_app.dependency_overrides[get_process_manager] = lambda: mgr

    def _session():
        with Session(engine) as s:
            yield s

    fastapi_app.dependency_overrides[get_session] = _session
    yield TestClient(fastapi_app)
    fastapi_app.dependency_overrides.clear()


def test_get_mode_defaults_to_local_with_availability(api):
    body = api.get("/api/apps/demo/mode").json()
    assert body["mode"] == "local"
    opts = {o["name"]: o for o in body["modes"]}
    assert opts["local"]["available"] and opts["lan"]["available"]
    assert not opts["vpn"]["available"] and "TAILSCALE_IP" in opts["vpn"]["reason"]
    assert api.get("/api/apps/none/mode").status_code == 404


def test_set_mode_persists_and_rejects_invalid(api, engine):  # noqa: F811
    r = api.put("/api/apps/demo/mode", json={"mode": "lan"}, headers=CSRF)
    assert r.status_code == 200 and r.json()["mode"] == "lan"
    with Session(engine) as s:
        assert s.get(AppState, "demo").mode == "lan"
    assert api.get("/api/apps/demo/mode").json()["mode"] == "lan"
    # IP 未設定のモードは選択不可
    assert api.put("/api/apps/demo/mode", json={"mode": "vpn"}, headers=CSRF).status_code == 422
    # 不明なモード
    assert api.put("/api/apps/demo/mode", json={"mode": "x"}, headers=CSRF).status_code == 422
    assert api.get("/api/apps/demo/mode").json()["mode"] == "lan"


def test_set_mode_requires_csrf(api):
    assert api.put("/api/apps/demo/mode", json={"mode": "lan"}).status_code == 403


def test_set_mode_rejected_while_running(api):
    assert api.post("/api/apps/demo/services/web/start", headers=CSRF).status_code == 200
    r = api.put("/api/apps/demo/mode", json={"mode": "lan"}, headers=CSRF)
    assert r.status_code == 409
    assert api.put("/api/apps/demo/mode", json={"mode": "local"}, headers=CSRF).status_code == 200
    api.post("/api/apps/demo/services/web/stop", headers=CSRF)


def test_invalid_ip_value_rejected(tmp_path):
    a = make_apps(tmp_path, "- {id: web, kind: process, start: [x]}\n", extra=MODES)
    svc = a.services[0]
    with pytest.raises(ProcessConfigError, match="IP アドレス"):
        build_env(a, svc, "lan", {"LAN_IP": "not-an-ip"})
    env, _ = build_env(a, svc, "vpn", {"TAILSCALE_IP": "100.64.0.1"})
    assert env["TAILSCALE_IP"] == "100.64.0.1"


@pytest.mark.parametrize("ip", ["0.0.0.0", "::", "127.0.0.1", "224.0.0.1"])
def test_unsafe_ip_rejected(tmp_path, ip):
    a = make_apps(tmp_path, "- {id: web, kind: process, start: [x]}\n", extra=MODES)
    with pytest.raises(ProcessConfigError, match="使えない"):
        build_env(a, a.services[0], "lan", {"LAN_IP": ip})
    env, _ = build_env(a, a.services[0], "lan", {"LAN_IP": "fd00::1"})
    assert env["LAN_IP"] == "fd00::1"
