import os
import signal
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.orm import Session
from test_process import alive, engine, gone, make_apps, mgr, svc_of  # noqa: F401

from thoth.api.deps import get_engine, get_registry_holder
from thoth.apps.schema import AutoRestart
from thoth.db.models import ServiceOperation, ServiceSupervision
from thoth.main import app as fastapi_app
from thoth.process.supervisor import Supervisor, SupState, backoff, decide

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
CFG = AutoRestart(
    max_retries=3, backoff_initial=10, backoff_factor=2, backoff_max=30, reset_after=100
)


def st(**kw):
    base = dict(desired=True, attempts=0, gave_up=False, last_attempt_at=None, next_attempt_at=None)
    return SupState(**{**base, **kw})


def d(state, running=False, unhealthy=False, busy=False, now=NOW):
    return decide(now, CFG, state, running=running, unhealthy=unhealthy, busy=busy)


def test_backoff():
    assert [backoff(CFG, n) for n in (1, 2, 3, 4)] == [10, 20, 30, 30]


def test_decide_basic():
    assert d(None, running=False) == "none"
    assert d(None, running=True) == "adopt"
    assert d(st(desired=False)) == "none"  # 手動停止
    assert d(st(gave_up=True)) == "none"
    assert d(st(), busy=True) == "none"
    assert d(st()) == "restart"
    assert d(st(), running=True, unhealthy=True) == "restart"
    assert d(st(), running=True) == "none"


def test_decide_unhealthy_option():
    cfg = AutoRestart(on_unhealthy=False)
    assert decide(NOW, cfg, st(), running=True, unhealthy=True, busy=False) == "none"


def test_decide_backoff_limit_and_reset():
    waiting = st(attempts=1, last_attempt_at=NOW, next_attempt_at=NOW + timedelta(seconds=10))
    assert d(waiting) == "wait"
    assert d(waiting, now=NOW + timedelta(seconds=10)) == "restart"
    last = st(attempts=3, last_attempt_at=NOW, next_attempt_at=NOW + timedelta(seconds=30))
    assert d(last) == "wait"  # 最後の試行が効くか、待ってから判断する
    assert d(last, now=NOW + timedelta(seconds=30)) == "give_up"
    assert d(last, running=True, now=NOW + timedelta(seconds=30)) == "none"
    assert d(last, running=True, now=NOW + timedelta(seconds=100)) == "reset"


def test_autorestart_schema():
    assert AutoRestart().max_retries == 5
    with pytest.raises(ValidationError):
        AutoRestart(backoff_initial=100, backoff_max=10)
    with pytest.raises(ValidationError):
        AutoRestart(max_retries=0)
    with pytest.raises(ValidationError):
        AutoRestart(unknown=1)


SVC = (
    "{id: web, kind: process, start: [sleep, '60'], stop_timeout: 3, "
    "auto_restart: {max_retries: 2, backoff_initial: 1, backoff_max: 1}}"
)


def row(eng):
    with Session(eng) as s:
        return s.get(ServiceSupervision, ("demo", "web"))


def kill(pid):
    os.killpg(pid, signal.SIGKILL)
    assert gone(pid)


def test_manual_start_stop_sets_desired(tmp_path, mgr, engine):  # noqa: F811
    app = make_apps(tmp_path, f"- {SVC}\n")
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    assert row(engine).desired is True
    mgr.stop(app, svc)
    assert row(engine).desired is False


def test_recovers_after_crash_but_not_after_manual_stop(tmp_path, mgr, engine):  # noqa: F811
    app = make_apps(tmp_path, f"- {SVC}\n")
    svc = svc_of(app, "web")
    sup = Supervisor(engine, None, mgr)
    mgr.start(app, svc)
    assert sup.step(app, svc) == "none"
    kill(mgr.status(app, svc).pid)  # 異常終了
    assert sup.step(app, svc) == "restart"
    st_ = mgr.status(app, svc)
    assert st_.running
    assert row(engine).attempts == 1
    with Session(engine) as s:
        ops = [o.action for o in s.query(ServiceOperation)]
    assert "auto_restart" in ops
    # 手動停止したものは再起動されない
    mgr.stop(app, svc)
    assert sup.step(app, svc) == "none"
    assert mgr.status(app, svc).running is False
    assert row(engine).attempts == 0


def test_gives_up_at_limit_and_manual_start_resets(tmp_path, mgr, engine):  # noqa: F811
    bad = (
        "{id: web, kind: process, start: [sh, -c, 'exit 1'], "
        "auto_restart: {max_retries: 2, backoff_initial: 1, backoff_max: 1}}"
    )
    app = make_apps(tmp_path, f"- {bad}\n")
    svc = svc_of(app, "web")
    sup = Supervisor(engine, None, mgr)
    # 一度でも起動に成功した扱いにして、以後は起動できない状況を作る
    mgr.set_desired(("demo", "web"), True)
    t = NOW
    assert sup.step(app, svc, t) == "restart"  # 失敗（起動直後に終了）
    assert sup.step(app, svc, datetime.now(UTC)) == "wait"
    r = row(engine)
    assert r.attempts == 1 and "失敗" in r.last_message
    # 待ち時間を過ぎたら 2 回目
    future = datetime.now(UTC) + timedelta(seconds=5)
    assert sup.step(app, svc, future) == "restart"
    assert row(engine).attempts == 2
    future2 = datetime.now(UTC) + timedelta(seconds=10)
    assert sup.step(app, svc, future2) == "give_up"
    r = row(engine)
    assert r.gave_up and "停止しました" in r.last_message
    assert sup.step(app, svc, future2) == "none"  # 以後は何もしない
    # 状況 API
    fastapi_app.dependency_overrides[get_engine] = lambda: engine
    fastapi_app.dependency_overrides[get_registry_holder] = lambda: type(
        "H", (), {"registry": type("R", (), {"apps": [app]})()}
    )()
    try:
        body = TestClient(fastapi_app).get("/api/auto-restart").json()
    finally:
        fastapi_app.dependency_overrides.clear()
    assert body[0]["state"] == "gave_up" and body[0]["max_retries"] == 2
    # 手動の起動でリセットされる
    good = svc.model_copy(update={"start": ["sleep", "60"]})
    mgr.start(app, good)
    r = row(engine)
    assert not r.gave_up and r.attempts == 0 and r.desired


def test_no_config_is_ignored(tmp_path, mgr, engine):  # noqa: F811
    app = make_apps(tmp_path, "- {id: web, kind: process, start: [sleep, '60'], stop_timeout: 3}\n")
    svc = svc_of(app, "web")
    mgr.start(app, svc)
    sup = Supervisor(engine, None, mgr)
    kill(mgr.status(app, svc).pid)
    assert sup.step(app, svc) == "none"
