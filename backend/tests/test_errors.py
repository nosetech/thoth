import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from thoth.api.deps import get_registry_holder, get_session
from thoth.apps.loader import AppRegistry, AppsConfigError, load_apps
from thoth.apps.schema import App
from thoth.db.migrate import upgrade_db
from thoth.db.models import ErrorEvent, LogCursor
from thoth.db.session import create_db_engine
from thoth.errors import detector
from thoth.errors.detector import Cursor, detect_once, purge_old, scan
from thoth.logreader.reader import level_detector, read_tail
from thoth.main import app as fastapi_app

CSRF = {"Origin": "http://127.0.0.1:3900", "X-Thoth-Request": "1"}
OLD = 1_000_000.0  # 十分古い時刻（未完行も確定扱いになる）


def make_app(tmp_path, *, app_extra=None, svc_extra=None, services=None):
    svc = {"id": "svc", "kind": "process", "start": ["true"], "log_paths": ["app.log"]}
    svc.update(svc_extra or {})
    data = {
        "id": "x",
        "name": "X",
        "workdir": str(tmp_path),
        "services": services or [svc],
    }
    data.update(app_extra or {})
    return App.model_validate(data)


@pytest.fixture
def engine(tmp_path):
    eng = create_db_engine(tmp_path / "t.db")
    upgrade_db(eng)
    yield eng
    eng.dispose()


def events(engine):
    with Session(engine) as s:
        return list(s.scalars(select(ErrorEvent).order_by(ErrorEvent.id)))


# --- スキーマ ---


def test_default_and_disabled_rules(tmp_path):
    a = make_app(tmp_path)
    assert [r.id for r in a.effective_error_rules] == ["error-level"]
    assert make_app(tmp_path, app_extra={"error_rules": []}).effective_error_rules == ()


@pytest.mark.parametrize(
    "rule",
    [
        {"id": "r"},  # levels も pattern も無い
        {"id": "r", "pattern": "("},  # 不正な正規表現
        {"id": "r", "levels": ["error"], "exclude": "["},
        {"id": "R", "levels": ["error"]},  # id の形式
        {"id": "r", "levels": ["fatal"]},
        {"id": "r", "levels": ["error"], "unknown": 1},
    ],
)
def test_invalid_rule(tmp_path, rule):
    with pytest.raises(ValueError):
        make_app(tmp_path, app_extra={"error_rules": [rule]})


def test_invalid_log_format(tmp_path):
    with pytest.raises(ValueError, match="level"):
        make_app(tmp_path, app_extra={"log_format": {"level_pattern": r"\[(\w+)\]"}})
    with pytest.raises(ValueError):
        make_app(tmp_path, svc_extra={"log_format": {"level_pattern": "(?P<level>"}})


def test_loader_checks_rule_services_and_duplicates(tmp_path):
    (tmp_path / "apps.yaml").write_text(
        f"""
apps:
  - id: x
    name: X
    workdir: {tmp_path}
    error_rules:
      - {{id: a, levels: [error], services: [nope]}}
      - {{id: a, pattern: boom}}
    services:
      - {{id: svc, kind: process, start: ["true"]}}
"""
    )
    with pytest.raises(AppsConfigError) as e:
        load_apps(tmp_path / "apps.yaml")
    msg = str(e.value)
    assert "存在しないサービス 'nope'" in msg
    assert "id 'a' がアプリ内で重複" in msg


# --- パーサ ---


def test_level_detector_with_format(tmp_path):
    a = make_app(
        tmp_path,
        app_extra={
            "log_format": {
                "level_pattern": r"^\S+ (?P<level>[A-Z])/",
                "level_map": {"E": "error", "W": "warn", "I": "info"},
            }
        },
    )
    of = level_detector(a.log_format)
    assert of("12:00 E/main boom") == "error"
    assert of("12:00 W/main hmm") == "warn"
    assert of("12:00 X/main ERROR in text") is None  # パターンが正、自動推定はしない
    assert of("no match") is None
    # level_map に無い文字列は既定の対応で解釈する
    of2 = level_detector(
        make_app(
            tmp_path, app_extra={"log_format": {"level_pattern": r"lvl=(?P<level>\w+)"}}
        ).log_format
    )
    assert of2("lvl=Warning x") == "warn"
    assert level_detector(None)("ERROR x") == "error"


def test_log_viewer_uses_parser(tmp_path):
    p = tmp_path / "a.log"
    p.write_text("E/x boom\nI/x ok\n")
    fmt = make_app(
        tmp_path,
        app_extra={
            "log_format": {"level_pattern": r"^(?P<level>\w)/", "level_map": {"E": "error"}}
        },
    ).log_format
    c = read_tail(p, 10, levels=frozenset({"error"}), level_of=level_detector(fmt))
    assert [ln.text for ln in c.lines] == ["E/x boom"]


# --- 読み取り ---


def test_scan_starts_at_end_then_follows(tmp_path):
    p = tmp_path / "app.log"
    p.write_text("old ERROR\n")
    s1 = scan(p, None, now=OLD)
    assert s1.lines == [] and s1.cursor.offset == p.stat().st_size
    with open(p, "a") as f:
        f.write("new1\nnew2\n")
    s2 = scan(p, s1.cursor, now=OLD)
    assert [(ln.file_name, ln.text) for ln in s2.lines] == [
        ("app.log", "new1"),
        ("app.log", "new2"),
    ]
    assert s2.cursor.offset == p.stat().st_size
    assert scan(p, s2.cursor, now=OLD).lines == []


def test_scan_waits_for_incomplete_line(tmp_path):
    p = tmp_path / "app.log"
    p.write_text("")
    c = scan(p, None).cursor
    with open(p, "a") as f:
        f.write("done\npart")
    s = scan(p, c)  # 更新直後: 未完の行は返さない
    assert [ln.text for ln in s.lines] == ["done"]
    assert s.cursor.offset == len("done\n")


def test_scan_rename_rotation_reads_rest_of_old_file(tmp_path):
    p = tmp_path / "app.log"
    p.write_text("a\n")
    c = scan(p, None, now=OLD).cursor
    with open(p, "a") as f:
        f.write("b ERROR\n")
    os.rename(p, tmp_path / "app.log.1")
    p.write_text("c\n")
    s = scan(p, c, now=OLD)
    assert [(ln.file_name, ln.text) for ln in s.lines] == [
        ("app.log.1", "b ERROR"),
        ("app.log", "c"),
    ]
    assert s.cursor.inode == p.stat().st_ino and s.cursor.offset == 2


def test_scan_copytruncate_reads_from_start(tmp_path):
    p = tmp_path / "app.log"
    p.write_text("aaaaaaaaaa\n")
    c = scan(p, None, now=OLD).cursor
    p.write_text("b\n")  # 同じ inode で縮む
    s = scan(p, c, now=OLD)
    assert [ln.text for ln in s.lines] == ["b"]


def test_scan_path_change_restarts_at_end(tmp_path):
    p = tmp_path / "app.log"
    p.write_text("x ERROR\n")
    s = scan(p, Cursor(str(tmp_path / "other.log"), 1, 0), now=OLD)
    assert s.lines == [] and s.cursor.path == str(p)


def test_scan_missing_file(tmp_path):
    with pytest.raises(OSError):
        scan(tmp_path / "none.log", None)


# --- 検知 ---


def test_detect_once_records_matches(tmp_path, engine):
    a = make_app(
        tmp_path,
        app_extra={
            "error_rules": [
                {
                    "id": "timeout",
                    "name": "タイムアウト",
                    "severity": "warn",
                    "pattern": "(?i)timeout",
                },
                {"id": "err", "levels": ["error"], "exclude": "ignored"},
            ]
        },
    )
    reg = AppRegistry((a,))
    p = tmp_path / "app.log"
    p.write_text("before ERROR\n")
    assert detect_once(engine, reg, now=OLD) == 0  # 初回は末尾から
    with open(p, "a") as f:
        f.write("INFO ok\nERROR boom\nERROR ignored\nERROR Timeout here\nWARN x\n")
    assert detect_once(engine, reg, now=OLD) == 2
    ev = events(engine)
    assert [(e.rule_id, e.severity, e.level, e.line) for e in ev] == [
        ("err", "error", "error", "ERROR boom"),
        ("timeout", "warn", "error", "ERROR Timeout here"),  # 定義順で最初のルール
    ]
    assert ev[0].rule_name == "err" and ev[1].rule_name == "タイムアウト"
    assert ev[0].file_name == "app.log" and ev[0].source == 0
    assert detect_once(engine, reg, now=OLD) == 0  # 同じ行は二度検知しない
    with Session(engine) as s:
        cur = s.get(LogCursor, ("x", "svc", 0))
        assert cur is not None and cur.offset == p.stat().st_size


def test_detect_once_respects_services_and_disabled(tmp_path, engine):
    (tmp_path / "a.log").write_text("")
    (tmp_path / "b.log").write_text("")
    services = [
        {"id": "a", "kind": "process", "start": ["true"], "log_paths": ["a.log"]},
        {"id": "b", "kind": "process", "start": ["true"], "log_paths": ["b.log"]},
    ]
    only_a = make_app(
        tmp_path,
        services=services,
        app_extra={"error_rules": [{"id": "r", "levels": ["error"], "services": ["a"]}]},
    )
    detect_once(engine, AppRegistry((only_a,)), now=OLD)
    for n in ("a", "b"):
        (tmp_path / f"{n}.log").write_text("ERROR x\n")
    detect_once(engine, AppRegistry((only_a,)), now=OLD)
    assert [e.service_id for e in events(engine)] == ["a"]

    disabled = make_app(tmp_path, services=services, app_extra={"error_rules": []})
    (tmp_path / "a.log").write_text("ERROR x\nERROR y\n")
    assert detect_once(engine, AppRegistry((disabled,)), now=OLD) == 0


def test_detect_once_caps_events(tmp_path, engine, monkeypatch):
    monkeypatch.setattr(detector, "MAX_EVENTS_PER_SCAN", 3)
    a = make_app(tmp_path)
    reg = AppRegistry((a,))
    p = tmp_path / "app.log"
    p.write_text("")
    detect_once(engine, reg, now=OLD)
    p.write_text("".join(f"ERROR {i}\n" for i in range(10)))
    assert detect_once(engine, reg, now=OLD) == 3
    assert detect_once(engine, reg, now=OLD) == 0  # 位置は進めている


def test_detect_once_skips_missing_file(tmp_path, engine):
    a = make_app(tmp_path)
    assert detect_once(engine, AppRegistry((a,)), now=OLD) == 0


def test_purge_old(engine):
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    with Session(engine) as s:
        for d in (1, 40):
            s.add(
                ErrorEvent(
                    app_id="x",
                    service_id="s",
                    rule_id="r",
                    rule_name="r",
                    severity="error",
                    level="error",
                    source=0,
                    file_name="a.log",
                    offset=0,
                    line="ERROR",
                    detected_at=now - timedelta(days=d),
                )
            )
        s.commit()
    assert purge_old(engine, 30, now) == 1
    assert len(events(engine)) == 1


# --- API ---


@pytest.fixture
def client(tmp_path, engine):
    services = [
        {"id": "api", "kind": "process", "start": ["true"], "log_paths": ["api.log"]},
        {"id": "web", "kind": "process", "start": ["true"], "log_paths": ["web.log"]},
        {"id": "job", "kind": "process", "start": ["true"]},
    ]
    a = make_app(
        tmp_path,
        services=services,
        app_extra={
            "error_rules": [
                {"id": "err", "name": "エラー", "levels": ["error"]},
                {"id": "slow", "severity": "warn", "pattern": "slow", "services": ["web"]},
            ],
            "log_format": {"level_pattern": r"^(?P<level>\w)/", "level_map": {"E": "error"}},
        },
    )
    b = App.model_validate(
        {
            "id": "y",
            "name": "Y",
            "workdir": str(tmp_path),
            "error_rules": [],
            "services": [{"id": "s", "kind": "process", "start": ["true"], "log_paths": ["y.log"]}],
        }
    )
    c = App.model_validate(
        {
            "id": "z",
            "name": "Z",
            "workdir": str(tmp_path),
            "services": [
                {
                    "id": "s",
                    "kind": "process",
                    "start": ["true"],
                    "log_paths": ["z.log"],
                    "log_format": {"level_pattern": "(?P<level>LV\\d)"},
                }
            ],
        }
    )

    class Holder:
        registry = AppRegistry((a, b, c))

    def session():
        with Session(engine) as s:
            yield s

    for n in ("api", "web"):
        (tmp_path / f"{n}.log").write_text("")
    detect_once(engine, Holder.registry, now=OLD)
    (tmp_path / "api.log").write_text("E/a boom1\nE/a boom2\nI/a fine\n")
    (tmp_path / "web.log").write_text("I/w slow request\n")
    detect_once(engine, Holder.registry, now=OLD)

    fastapi_app.dependency_overrides[get_registry_holder] = lambda: Holder
    fastapi_app.dependency_overrides[get_session] = session
    try:
        yield TestClient(fastapi_app)
    finally:
        fastapi_app.dependency_overrides.clear()


def test_api_list_and_summary(client):
    body = client.get("/api/errors").json()
    assert body["total"] == 3
    assert [e["line"] for e in body["events"]] == ["I/w slow request", "E/a boom2", "E/a boom1"]
    e = body["events"][0]
    assert e["app_name"] == "X" and e["service_name"] == "web" and e["rule_id"] == "slow"
    sm = body["summary"]
    assert (sm["unacknowledged"], sm["error"], sm["warn"]) == (3, 2, 1)
    assert sm["last_detected_at"] is not None
    by = {s["service_id"]: s for s in sm["services"]}
    assert by["api"]["error"] == 2 and by["api"]["latest_line"] == "E/a boom2"
    assert by["web"]["warn"] == 1

    f = client.get("/api/errors", params={"service_id": "api", "limit": 1}).json()
    assert f["total"] == 2 and len(f["events"]) == 1
    assert client.get("/api/errors", params={"severity": "warn"}).json()["total"] == 1
    assert client.get("/api/errors", params={"rule_id": "err"}).json()["total"] == 2
    assert client.get("/api/errors", params={"severity": "bad"}).status_code == 422


def test_api_ack(client):
    ids = [e["id"] for e in client.get("/api/errors").json()["events"]]
    assert client.post("/api/errors/ack", json={"ids": ids[:1]}).status_code == 403  # CSRF
    r = client.post("/api/errors/ack", json={"ids": ids[:1]}, headers=CSRF)
    assert r.json() == {"acknowledged": 1}
    body = client.get("/api/errors").json()
    assert body["total"] == 2 and body["summary"]["unacknowledged"] == 2
    all_ = client.get("/api/errors", params={"include_acknowledged": True}).json()
    assert all_["total"] == 3
    assert sum(e["acknowledged_at"] is not None for e in all_["events"]) == 1

    r = client.post("/api/errors/ack", json={"all": True, "service_id": "api"}, headers=CSRF)
    assert r.json() == {"acknowledged": 2}
    assert client.get("/api/errors").json()["summary"]["services"] == []
    bad = client.post("/api/errors/ack", json={"all": True, "ids": [1]}, headers=CSRF)
    assert bad.status_code == 422
    assert client.post("/api/errors/ack", json={}, headers=CSRF).status_code == 422


def test_api_rules(client):
    body = client.get("/api/errors/rules").json()
    assert body["monitored_services"] == 3  # x/api, x/web, z/s（y は検知無効）
    x, y, z = body["apps"]
    assert x["mode"] == "custom" and [r["id"] for r in x["rules"]] == ["err", "slow"]
    assert x["rules"][1]["services"] == ["web"]
    svc = {s["service_id"]: s for s in x["services"]}
    assert svc["job"]["monitored"] is False and svc["job"]["has_log_paths"] is False
    assert svc["api"]["parser"]["kind"] == "regex" and svc["api"]["parser"]["origin"] == "app"
    assert y["mode"] == "disabled" and y["rules"] == []
    assert y["services"][0]["monitored"] is False
    assert z["mode"] == "default" and z["rules"][0]["id"] == "error-level"
    assert z["services"][0]["parser"]["origin"] == "service"
