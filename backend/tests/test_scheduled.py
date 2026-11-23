import os
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from thoth.api.deps import get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, ScheduledService
from thoth.main import app as fastapi_app
from thoth.scheduled.status import parse_print, scheduled_status

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)
DAY = 86400


def make_app(tmp_path, **kw):
    job = {"id": "job", "kind": "scheduled", "launchd_label": "com.example.job", **kw}
    return App.model_validate({"id": "x", "name": "X", "workdir": str(tmp_path), "services": [job]})


def runner(rc=0, state="not running", code="0", runs=3):
    out = f"\tstate = {state}\n\truns = {runs}\n\tlast exit code = {code}\n"
    return lambda target: (rc, out)


def log(tmp_path, age_seconds):
    p = tmp_path / "job.log"
    p.write_text("x")
    t = (NOW - timedelta(seconds=age_seconds)).timestamp()
    os.utime(p, (t, t))
    return str(p)


def status(tmp_path, run, **kw):
    a = make_app(tmp_path, **kw)
    svc = a.services[0]
    assert isinstance(svc, ScheduledService)
    return scheduled_status(a, svc, NOW, run)


def test_parse_print():
    info = parse_print("\tstate = running\n\truns = 2\n\tlast exit code = (never exited)\n")
    assert (info.running, info.exit_code, info.runs) == (True, None, 2)
    assert parse_print("\tlast exit code = 78\n").exit_code == 78


def test_ok_with_last_run(tmp_path):
    st = status(tmp_path, runner(), log_paths=[log(tmp_path, 3600)], expected_interval=DAY)
    assert st.state == "ok"
    assert st.last_run_at == NOW - timedelta(hours=1)


def test_failed_by_exit_code(tmp_path):
    st = status(tmp_path, runner(code="1"), log_paths=[log(tmp_path, 60)])
    assert st.state == "failed" and st.exit_code == 1


def test_running(tmp_path):
    st = status(tmp_path, runner(state="running", code="(never exited)"))
    assert st.state == "running"


def test_overdue_beyond_interval_factor(tmp_path):
    lp = [log(tmp_path, int(DAY * 1.5) + 60)]
    assert status(tmp_path, runner(), log_paths=lp, expected_interval=DAY).state == "overdue"


def test_not_overdue_within_interval_factor(tmp_path):
    lp = [log(tmp_path, int(DAY * 1.5) - 60)]
    assert status(tmp_path, runner(), log_paths=lp, expected_interval=DAY).state == "ok"


def test_failed_takes_precedence_over_overdue(tmp_path):
    lp = [log(tmp_path, DAY * 5)]
    st = status(tmp_path, runner(code="2"), log_paths=lp, expected_interval=DAY)
    assert st.state == "failed"


def test_never_run(tmp_path):
    st = status(tmp_path, runner(code="(never exited)", runs=0), expected_interval=DAY)
    assert st.state == "never"


def test_unloaded_and_unknown(tmp_path):
    assert status(tmp_path, lambda t: (113, "")).state == "unloaded"
    assert status(tmp_path, lambda t: (-1, "")).state == "unknown"


def test_ok_without_log_paths_has_no_last_run(tmp_path):
    st = status(tmp_path, runner(), expected_interval=DAY)
    assert st.state == "ok" and st.last_run_at is None


def test_target_uses_domain_and_label(tmp_path):
    seen = []

    def r(target):
        seen.append(target)
        return runner()(target)

    status(tmp_path, r, launchd_domain="gui/1234")
    assert seen == ["gui/1234/com.example.job"]


def test_api_lists_only_scheduled(tmp_path):
    f = tmp_path / "apps.yaml"
    f.write_text(
        f"""
apps:
  - id: sample
    name: Sample
    workdir: {tmp_path}
    services:
      - {{id: web, kind: process, start: ["true"]}}
      - id: job
        kind: scheduled
        launchd_label: com.thoth.test.nonexistent
        schedule: 毎日 03:00
""",
        encoding="utf-8",
    )
    fastapi_app.dependency_overrides[get_registry_holder] = lambda: RegistryHolder(f)
    try:
        res = TestClient(fastapi_app).get("/api/scheduled")
    finally:
        fastapi_app.dependency_overrides.clear()
    assert res.status_code == 200
    (row,) = res.json()
    assert (row["app_id"], row["service_id"], row["schedule"]) == ("sample", "job", "毎日 03:00")
    assert row["state"] in ("unloaded", "unknown")
