import os
import signal
import socket
import textwrap
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from thoth.api.deps import get_process_manager, get_registry_holder
from thoth.apps.loader import load_apps
from thoth.apps.registry import RegistryHolder
from thoth.db.migrate import upgrade_db
from thoth.db.models import AppState, ServiceOperation, ServiceProcess
from thoth.db.session import create_db_engine
from thoth.main import app as fastapi_app
from thoth.process.env import ProcessConfigError, build_env, resolve_argv
from thoth.process.manager import ProcessError, ProcessManager, ordered_services
from thoth.process.ps import process_info

CSRF = {"Origin": "http://127.0.0.1:3900", "X-Thoth-Request": "1"}


def alive(pid: int) -> bool:
    return process_info(pid) is not None


def gone(pid: int, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def engine(tmp_path):
    e = create_db_engine(tmp_path / "t.db")
    upgrade_db(e)
    yield e
    # テストが残したプロセスを片付ける（記録したもの・PID ファイル）
    pids = []
    with Session(e) as s:
        pids += [r.pid for r in s.scalars(select(ServiceProcess))]
    for f in tmp_path.rglob("*.pid"):
        try:
            pids.append(int(f.read_text().split()[0]))
        except (OSError, ValueError, IndexError):
            pass
    for pid in pids:
        if pid == os.getpid():  # PID 再利用テストが記録するテスト自身は対象外
            continue
        for kill in (os.killpg, os.kill):
            try:
                kill(pid, signal.SIGKILL)
            except OSError:
                pass
    e.dispose()


@pytest.fixture
def mgr(engine, tmp_path):
    return ProcessManager(engine, tmp_path / "logs", settle=0.3)


def make_apps(tmp_path, services: str, extra: str = ""):
    wd = tmp_path / "work"
    wd.mkdir(exist_ok=True)
    p = tmp_path / "apps.yaml"
    p.write_text(
        textwrap.dedent(
            f"""
            apps:
              - id: demo
                name: Demo
                workdir: {wd}
                {extra}
                services:
            """
        )
        + textwrap.indent(textwrap.dedent(services), "      "),
        encoding="utf-8",
    )
    return load_apps(p).get("demo")


def svc_of(app, sid):
    return next(s for s in app.services if s.id == sid)


SLEEP = "{id: web, kind: process, start: [sleep, '60'], stop_timeout: 3}"


def test_start_stop_foreground(tmp_path, mgr):
    app = make_apps(tmp_path, f"- {SLEEP}\n")
    svc = svc_of(app, "web")
    assert mgr.status(app, svc).running is False
    mgr.start(app, svc)
    st = mgr.status(app, svc)
    assert st.running and st.source == "thoth"
    pid = st.pid
    # 起動中の再起動要求はエラー
    with pytest.raises(ProcessError) as e:
        mgr.start(app, svc)
    assert e.value.kind == "conflict"
    assert mgr.status(app, svc).pid == pid
    mgr.stop(app, svc)
    assert gone(pid)
    assert mgr.status(app, svc).running is False
    with pytest.raises(ProcessError) as e:
        mgr.stop(app, svc)
    assert e.value.kind == "conflict"


def test_new_session_and_process_group_stop(tmp_path, mgr):
    child_pid = tmp_path / "child.pid.txt"
    script = f"sleep 60 & echo $! > {child_pid}; wait"
    app = make_apps(
        tmp_path, f"- {{id: web, kind: process, start: [sh, -c, '{script}'], stop_timeout: 3}}\n"
    )
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    pid = mgr.status(app, svc).pid
    assert os.getpgid(pid) == pid != os.getpgid(0)  # thoth とは別のプロセスグループ
    child = int(child_pid.read_text())
    assert alive(child)
    mgr.stop(app, svc)
    assert gone(pid) and gone(child)  # 子プロセスも残さない


def test_sigkill_after_timeout(tmp_path, mgr):
    script = tmp_path / "stubborn.sh"
    script.write_text("trap '' TERM\nwhile true; do sleep 1; done\n")
    app = make_apps(
        tmp_path, f"- {{id: web, kind: process, start: [sh, {script}], stop_timeout: 1}}\n"
    )
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    pid = mgr.status(app, svc).pid
    time.sleep(0.3)  # trap の設定を待つ
    note = mgr.stop(app, svc)
    assert "SIGKILL" in note
    assert gone(pid)


def test_exits_immediately_is_failure(tmp_path, mgr):
    app = make_apps(tmp_path, "- {id: web, kind: process, start: [sh, -c, 'exit 3']}\n")
    with pytest.raises(ProcessError) as e:
        mgr.start(app, svc_of(app, "web"))
    assert e.value.kind == "failed" and "終了コード 3" in str(e.value)
    assert mgr.status(app, svc_of(app, "web")).running is False


def test_command_not_found(tmp_path, mgr):
    app = make_apps(tmp_path, "- {id: web, kind: process, start: [./no-such-command]}\n")
    with pytest.raises(ProcessError) as e:
        mgr.start(app, svc_of(app, "web"))
    assert e.value.kind == "failed"


LAUNCHER = (
    "- id: web\n"
    "  kind: process\n"
    "  start: [sh, -c, 'nohup sleep 60 >/dev/null 2>&1 & echo $! > run.pid']\n"
    "  pid_file: run.pid\n"
    "  stop_timeout: 3\n"
)


def test_pid_file_launcher(tmp_path, mgr):
    app = make_apps(tmp_path, LAUNCHER)
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    st = mgr.status(app, svc)
    assert st.running and st.source == "pid_file"
    assert st.pid == int((tmp_path / "work" / "run.pid").read_text())
    with pytest.raises(ProcessError) as e:
        mgr.start(app, svc)
    assert e.value.kind == "conflict"
    mgr.stop(app, svc)
    assert gone(st.pid)


def test_pid_file_with_stop_command(tmp_path, mgr):
    app = make_apps(
        tmp_path,
        LAUNCHER + "  stop: [sh, -c, 'kill $(cat run.pid); rm -f run.pid']\n",
    )
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    pid = mgr.status(app, svc).pid
    mgr.stop(app, svc)
    assert gone(pid) and mgr.status(app, svc).running is False


def test_launcher_failure_and_timeout(tmp_path, mgr):
    app = make_apps(
        tmp_path,
        "- {id: bad, kind: process, start: [sh, -c, 'exit 1'], pid_file: x.pid}\n"
        "- {id: slow, kind: process, start: [sleep, '30'], pid_file: y.pid, start_timeout: 1}\n"
        "- {id: nopid, kind: process, start: ['true'], pid_file: z.pid}\n",
    )
    with pytest.raises(ProcessError, match="終了コード 1"):
        mgr.start(app, svc_of(app, "bad"))
    with pytest.raises(ProcessError, match="start_timeout"):
        mgr.start(app, svc_of(app, "slow"))
    with pytest.raises(ProcessError, match="PID ファイル"):
        mgr.start(app, svc_of(app, "nopid"))


def test_thoth_restart_keeps_app_running(tmp_path, engine):
    """thoth（ProcessManager）を作り直しても、対象は落ちず PID を引き継いで停止できる。"""
    app = make_apps(tmp_path, f"- {SLEEP}\n")
    svc = svc_of(app, "web")
    m1 = ProcessManager(engine, tmp_path / "logs", settle=0.3)
    m1.start(app, svc)
    pid = m1.status(app, svc).pid
    del m1  # thoth 再起動相当（メモリ上の状態を失う）
    m2 = ProcessManager(engine, tmp_path / "logs", settle=0.3)
    assert alive(pid)
    assert m2.status(app, svc).running and m2.status(app, svc).pid == pid
    with pytest.raises(ProcessError) as e:
        m2.start(app, svc)
    assert e.value.kind == "conflict"
    m2.stop(app, svc)
    assert gone(pid)


def test_pid_reuse_is_not_killed(tmp_path, mgr, engine):
    """記録した起動時刻と一致しない PID は停止済みとみなし、kill しない。"""
    app = make_apps(tmp_path, f"- {SLEEP}\n")
    svc = svc_of(app, "web")
    with Session(engine) as s:  # 無関係な生存プロセス（テスト自身）を指す古い記録
        s.add(
            ServiceProcess(
                app_id="demo",
                service_id="web",
                pid=os.getpid(),
                proc_started="Mon Jan  1 00:00:00 2001",
            )
        )
        s.commit()
    assert mgr.status(app, svc).running is False
    with pytest.raises(ProcessError) as e:
        mgr.stop(app, svc)
    assert e.value.kind == "conflict"
    assert alive(os.getpid())


def test_stale_pid_file_pointing_to_unrelated_process(tmp_path, mgr):
    app = make_apps(tmp_path, LAUNCHER)
    svc = svc_of(app, "web")
    pid_file = tmp_path / "work" / "run.pid"
    pid_file.write_text(str(os.getpid()))  # 無関係な生存プロセス（テスト自身）
    old = time.time() - 3600  # PID ファイルはプロセスより前に書かれた古いもの
    os.utime(pid_file, (old, old))
    assert mgr.status(app, svc).running is False
    with pytest.raises(ProcessError) as e:
        mgr.stop(app, svc)
    assert e.value.kind == "conflict"


def test_port_in_use_blocks_start(tmp_path, mgr):
    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        port = srv.getsockname()[1]
        app = make_apps(
            tmp_path, f"- {{id: web, kind: process, start: [sleep, '60'], port: {port}}}\n"
        )
        with pytest.raises(ProcessError) as e:
            mgr.start(app, svc_of(app, "web"))
        assert e.value.kind == "conflict" and str(port) in str(e.value)
        assert mgr.status(app, svc_of(app, "web")).running is False


def test_concurrent_start_only_one_wins(tmp_path, mgr):
    app = make_apps(
        tmp_path,
        "- id: web\n  kind: process\n  pid_file: run.pid\n"
        "  start: [sh, -c, 'sleep 1; nohup sleep 60 >/dev/null 2>&1 & echo $! > run.pid']\n",
    )
    svc = svc_of(app, "web")
    results: list[str] = []

    def go():
        try:
            mgr.start(app, svc)
            results.append("ok")
        except ProcessError as e:
            results.append(e.kind)

    threads = [threading.Thread(target=go) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["conflict", "conflict", "ok"]


def test_restart(tmp_path, mgr):
    app = make_apps(tmp_path, f"- {SLEEP}\n")
    svc = svc_of(app, "web")
    mgr.restart(app, svc)  # 停止中なら起動のみ
    old = mgr.status(app, svc).pid
    mgr.restart(app, svc)
    new = mgr.status(app, svc).pid
    assert new != old and gone(old) and alive(new)


def test_history_recorded_without_env_values(tmp_path, mgr, engine):
    app = make_apps(
        tmp_path,
        f"- {SLEEP}\n",
        extra="env: {SECRET_TOKEN: s3cr3t-value}",
    )
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    with pytest.raises(ProcessError):
        mgr.start(app, svc)
    mgr.stop(app, svc)
    with Session(engine) as s:
        rows = list(s.scalars(select(ServiceOperation).order_by(ServiceOperation.id)))
    assert [(r.action, r.status) for r in rows] == [
        ("start", "succeeded"),
        ("start", "rejected"),
        ("stop", "succeeded"),
    ]
    assert all("s3cr3t-value" not in (r.message or "") for r in rows)
    assert all(r.finished_at >= r.started_at for r in rows)


def test_child_output_goes_to_log_file(tmp_path, mgr):
    app = make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [sh, -c, 'echo hello-log; sleep 60']}\n",
    )
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    time.sleep(0.3)
    log = (tmp_path / "logs" / "apps" / "demo.web.log").read_text()
    assert "hello-log" in log
    mgr.stop(app, svc)


# ---- 環境変数・モード --------------------------------------------------------------


def _app_with_modes(tmp_path):
    return make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [serve, '--host', '${LAN_IP}'], env: {A: x}}\n",
        extra="modes: {local: {}, lan: {env: {LAN_IP: '${LAN_IP}'}}, vpn: {env: {TAILSCALE_IP: "
        "'${TAILSCALE_IP}'}}}",
    )


def test_env_local_mode_does_not_pass_thoth_ips(tmp_path):
    app = _app_with_modes(tmp_path)
    svc = svc_of(app, "web")
    thoth_env = {"PATH": "/bin", "LAN_IP": "192.168.0.5", "TAILSCALE_IP": "100.1.1.1"}
    env, defined = build_env(app, svc, "local", thoth_env)
    assert "LAN_IP" not in env and "TAILSCALE_IP" not in env
    assert env["A"] == "x" and env["PATH"] == "/bin"
    with pytest.raises(ProcessConfigError, match="LAN_IP"):
        resolve_argv(svc.start, defined, "start")  # local では ${LAN_IP} は未定義


def test_env_lan_mode_and_argv_expansion(tmp_path):
    app = _app_with_modes(tmp_path)
    svc = svc_of(app, "web")
    env, defined = build_env(app, svc, "lan", {"LAN_IP": "192.168.0.5", "TAILSCALE_IP": "1.1.1.1"})
    assert env["LAN_IP"] == "192.168.0.5" and "TAILSCALE_IP" not in env
    assert resolve_argv(svc.start, defined, "start") == ["serve", "--host", "192.168.0.5"]


def test_env_errors(tmp_path):
    app = _app_with_modes(tmp_path)
    svc = svc_of(app, "web")
    with pytest.raises(ProcessConfigError, match="未定義"):
        build_env(app, svc, "lan", {})  # thoth に LAN_IP が無い
    with pytest.raises(ProcessConfigError, match="定義されていません"):
        build_env(app, svc, "nope", {})
    both = make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [x], env: {LAN_IP: a, TAILSCALE_IP: b}}\n",
    )
    with pytest.raises(ProcessConfigError, match="同時"):
        build_env(both, svc_of(both, "web"), "local", {})
    other = make_apps(tmp_path, "- {id: web, kind: process, start: [x], env: {A: '${HOME}'}}\n")
    with pytest.raises(ProcessConfigError, match="HOME"):  # 許可リスト外は参照不可
        build_env(other, svc_of(other, "web"), "local", {"HOME": "/h"})


def test_mode_from_db_applies_to_start(tmp_path, mgr, engine):
    app = make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [sleep, '60']}\n",
        extra="modes: {local: {}, lan: {env: {LAN_IP: '${LAN_IP}'}}}",
    )
    with Session(engine) as s:
        s.add(AppState(app_id="demo", mode="lan"))
        s.commit()
    os.environ.pop("LAN_IP", None)
    with pytest.raises(ProcessError) as e:  # LAN_IP が thoth の環境に無い
        mgr.start(app, svc_of(app, "web"))
    assert e.value.kind == "config"


def test_ordered_services(tmp_path):
    app = make_apps(
        tmp_path,
        "- {id: c, kind: process, start: [x], depends_on: [b]}\n"
        "- {id: b, kind: process, start: [x], depends_on: [a]}\n"
        "- {id: a, kind: process, start: [x]}\n",
    )
    assert [s.id for s in ordered_services(app)] == ["a", "b", "c"]


# ---- API --------------------------------------------------------------------------------


@pytest.fixture
def api(tmp_path, mgr):
    app = make_apps(
        tmp_path,
        "- {id: db, kind: process, start: [sleep, '60'], stop_timeout: 3}\n"
        "- {id: web, kind: process, start: [sleep, '60'], stop_timeout: 3, depends_on: [db]}\n"
        "- {id: job, kind: scheduled, launchd_label: com.example.job}\n",
    )
    holder = RegistryHolder(tmp_path / "apps.yaml")
    assert holder.registry.get(app.id)
    fastapi_app.dependency_overrides[get_registry_holder] = lambda: holder
    fastapi_app.dependency_overrides[get_process_manager] = lambda: mgr
    yield TestClient(fastapi_app)
    fastapi_app.dependency_overrides.clear()


def test_api_service_lifecycle(api):
    base = "/api/apps/demo/services/db"
    assert api.get(f"{base}/status").json()["state"] == "stopped"
    r = api.post(f"{base}/start", headers=CSRF)
    assert r.status_code == 200, r.text
    st = api.get(f"{base}/status").json()
    assert st["state"] == "running" and st["pid"]
    r = api.post(f"{base}/start", headers=CSRF)  # 二重起動はエラー
    assert r.status_code == 409
    assert api.post(f"{base}/restart", headers=CSRF).status_code == 200
    assert api.post(f"{base}/stop", headers=CSRF).status_code == 200
    assert api.post(f"{base}/stop", headers=CSRF).status_code == 409
    assert api.get(f"{base}/status").json()["state"] == "stopped"


def test_api_requires_csrf_and_validates(api):
    base = "/api/apps/demo/services/db"
    assert api.post(f"{base}/start").status_code == 403
    assert api.post(f"{base}/start", headers={"Origin": "http://evil.example"}).status_code == 403
    assert api.post("/api/apps/demo/start").status_code == 403
    assert api.post("/api/apps/nope/start", headers=CSRF).status_code == 404
    assert api.post("/api/apps/demo/services/nope/start", headers=CSRF).status_code == 404
    assert api.post(f"{base}/explode", headers=CSRF).status_code == 422
    # scheduled は未対応
    assert api.post("/api/apps/demo/services/job/start", headers=CSRF).status_code == 400
    assert api.get("/api/apps/demo/services/job/status").json()["state"] == "unsupported"
    # 任意コマンドを受け取らない（ボディは無視される）
    r = api.post(f"{base}/start", headers=CSRF, json={"command": ["touch", "/tmp/pwned"]})
    assert r.status_code == 200
    api.post(f"{base}/stop", headers=CSRF)


def test_api_app_level_order_and_double_start(api):
    r = api.post("/api/apps/demo/start", headers=CSRF)
    assert r.status_code == 200, r.text
    assert [(x["service_id"], x["result"]) for x in r.json()["results"]] == [
        ("db", "ok"),
        ("web", "ok"),
        ("job", "skipped"),
    ]
    assert {s["service_id"]: s["state"] for s in api.get("/api/apps/demo/status").json()} == {
        "db": "running",
        "web": "running",
        "job": "unsupported",
    }
    assert api.post("/api/apps/demo/start", headers=CSRF).status_code == 409  # 二重起動
    assert api.post("/api/apps/demo/restart", headers=CSRF).status_code == 200
    r = api.post("/api/apps/demo/stop", headers=CSRF)
    assert r.status_code == 200
    # 停止は起動の逆順（依存されている db を最後に止める）
    assert [x["service_id"] for x in r.json()["results"]] == ["job", "web", "db"]
    assert api.post("/api/apps/demo/stop", headers=CSRF).status_code == 409
