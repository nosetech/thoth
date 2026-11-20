import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_process import engine, make_apps, svc_of  # noqa: F401  (fixture 再利用)

from thoth.api.deps import get_engine, get_process_manager, get_registry_holder
from thoth.apps.schema import Healthcheck
from thoth.config import ConfigError, parse_config
from thoth.db.models import HealthResult
from thoth.health.monitor import (
    HealthMonitor,
    Sample,
    evaluate,
    purge_old,
    service_health,
)
from thoth.main import app as fastapi_app
from thoth.process.manager import ProcessManager

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
HC = Healthcheck(type="tcp", interval=10, failure_threshold=3, start_grace=30)


def s(ok: bool, ago: int = 1) -> Sample:
    return Sample(ok, NOW - timedelta(seconds=ago))


def test_evaluate_unknown_without_samples_or_stale():
    assert evaluate([], HC, NOW) == "unknown"
    assert evaluate([s(True, ago=61)], HC, NOW) == "unknown"


def test_evaluate_healthy_and_threshold():
    assert evaluate([s(True)], HC, NOW) == "healthy"
    # 失敗が閾値未満なら直前の成功を引き継ぐ
    assert evaluate([s(False), s(True, 11), s(True, 21)], HC, NOW) == "healthy"
    assert evaluate([s(False), s(False, 11), s(True, 21)], HC, NOW) == "healthy"
    # 閾値回連続で失敗 → 異常
    assert evaluate([s(False), s(False, 11), s(False, 21)], HC, NOW) == "unhealthy"
    # 結果が閾値に満たず全て失敗 → 不明
    assert evaluate([s(False), s(False, 11)], HC, NOW) == "unknown"


def test_evaluate_start_grace():
    started = NOW - timedelta(seconds=5)
    assert evaluate([s(False)] * 3, HC, NOW, started) == "starting"
    assert evaluate([s(True)], HC, NOW, started) == "healthy"
    assert evaluate([s(False)] * 3, HC, NOW, NOW - timedelta(seconds=60)) == "unhealthy"


def test_config_retention():
    assert parse_config({}).health.retention_days == 7
    assert parse_config({"health": {"retention_days": 30}}).health.retention_days == 30
    for bad in (0, -1, True, "7"):
        with pytest.raises(ConfigError):
            parse_config({"health": {"retention_days": bad}})
    with pytest.raises(ConfigError):
        parse_config({"health": {"x": 1}})


def test_purge_old(engine):  # noqa: F811
    with Session(engine) as ses:
        for days in (0, 3, 8, 30):
            ses.add(
                HealthResult(
                    app_id="demo",
                    service_id="web",
                    ok=True,
                    message=None,
                    checked_at=datetime.now(UTC) - timedelta(days=days),
                )
            )
        ses.commit()
    assert purge_old(engine, 7) == 2
    with Session(engine) as ses:
        assert len(list(ses.scalars(select(HealthResult)))) == 2


class FakeHolder:
    def __init__(self, registry):
        self.registry = registry


def test_monitor_tick_records_and_state(tmp_path, engine):  # noqa: F811
    mgr = ProcessManager(engine, tmp_path / "logs", settle=0.3)
    app = make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [sleep, '60'], stop_timeout: 3,"
        " healthcheck: {type: pid, interval: 1, timeout: 1, failure_threshold: 1}}\n"
        "- {id: job, kind: process, start: [sleep, '60']}\n",
    )
    web = svc_of(app, "web")

    class Reg:
        apps = [app]

    monitor = HealthMonitor(engine, FakeHolder(Reg), mgr, retention_days=7)

    # 停止中はチェックせず、状態は不明
    asyncio.run(monitor.tick())
    with Session(engine) as ses:
        assert list(ses.scalars(select(HealthResult))) == []
    assert service_health(engine, mgr, app, web).state == "unknown"

    # 起動 → 成功が記録され「正常」
    mgr.start(app, web)
    monitor._due.clear()
    asyncio.run(monitor.tick())
    with Session(engine) as ses:
        rows = list(ses.scalars(select(HealthResult)))
    assert [(r.service_id, r.ok) for r in rows] == [("web", True)]
    assert service_health(engine, mgr, app, web).state == "healthy"

    # 例外が出てもループは止まらず、失敗として扱わず握る
    def boom(*a, **k):
        raise RuntimeError("x")

    monitor._mgr = type("M", (), {"probe_inputs": boom})()
    monitor._due.clear()
    asyncio.run(monitor.tick())
    mgr.stop(app, web)


def test_monitor_records_failure(tmp_path, engine):  # noqa: F811
    mgr = ProcessManager(engine, tmp_path / "logs", settle=0.3)
    app = make_apps(
        tmp_path,
        "- {id: web, kind: process, start: [sleep, '60'], stop_timeout: 3, port: 1,"
        " healthcheck: {type: tcp, interval: 1, timeout: 1,"
        " failure_threshold: 1, start_grace: 0}}\n",
    )
    web = svc_of(app, "web")

    class Reg:
        apps = [app]

    monitor = HealthMonitor(engine, FakeHolder(Reg), mgr, retention_days=7)
    mgr.start(app, web)
    asyncio.run(monitor.tick())
    h = service_health(engine, mgr, app, web)
    assert h.state == "unhealthy" and h.message
    mgr.stop(app, web)


def test_api(tmp_path, engine):  # noqa: F811
    mgr = ProcessManager(engine, tmp_path / "logs", settle=0.3)
    app = make_apps(tmp_path, "- {id: web, kind: process, start: [sleep, '60']}\n")
    with Session(engine) as ses:
        ses.add(
            HealthResult(
                app_id="demo",
                service_id="web",
                ok=False,
                message="x",
                checked_at=datetime.now(UTC),
            )
        )
        ses.commit()

    class Reg:
        def get(self, i):
            return app if i == "demo" else None

        apps = [app]

    fastapi_app.dependency_overrides[get_engine] = lambda: engine
    fastapi_app.dependency_overrides[get_process_manager] = lambda: mgr
    fastapi_app.dependency_overrides[get_registry_holder] = lambda: FakeHolder(Reg())
    try:
        c = TestClient(fastapi_app)
        r = c.get("/api/service-health")
        assert r.status_code == 200
        assert r.json()[0]["state"] == "unknown"  # 停止中
        r = c.get("/api/service-health/demo/web/history")
        assert [x["ok"] for x in r.json()] == [False]
        assert c.get("/api/service-health/demo/nope/history").status_code == 404
        assert c.get("/api/service-health/demo/web/history?limit=0").status_code == 422
    finally:
        fastapi_app.dependency_overrides.clear()


def test_evaluate_ignores_samples_before_start():
    started = NOW - timedelta(seconds=3)
    # 起動前の成功は引き継がない
    assert evaluate([s(True, ago=20)], HC, NOW, started) == "unknown"
