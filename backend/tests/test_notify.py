import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

from thoth.apps.loader import AppRegistry
from thoth.apps.schema import App
from thoth.config import ConfigError, NotifyConfig, parse_config
from thoth.db.migrate import upgrade_db
from thoth.db.models import ErrorEvent, ServiceSupervision
from thoth.db.session import create_db_engine
from thoth.health.monitor import ServiceHealth
from thoth.notify import notifier as notifier_mod
from thoth.notify import slack
from thoth.notify.notifier import Notifier, Throttle

URL = "https://hooks.slack.com/services/T/B/X"


@pytest.fixture
def engine(tmp_path):
    eng = create_db_engine(tmp_path / "t.db")
    upgrade_db(eng)
    yield eng
    eng.dispose()


def make_app(tmp_path, *, auto_restart=False):
    svc = {"id": "svc", "kind": "process", "start": ["true"], "log_paths": ["app.log"]}
    if auto_restart:
        svc["auto_restart"] = {}
    return App.model_validate({"id": "x", "name": "X", "workdir": str(tmp_path), "services": [svc]})


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Sent:
    def __init__(self, ok=True):
        self.messages: list[str] = []
        self.ok = ok

    def __call__(self, url, text):
        assert url == URL
        self.messages.append(text)
        return self.ok


def make_notifier(engine, tmp_path, *, cfg=None, sent=None, clock=None, auto_restart=False):
    holder = SimpleNamespace(registry=AppRegistry((make_app(tmp_path, auto_restart=auto_restart),)))
    return Notifier(
        engine,
        holder,
        mgr=None,
        cfg=cfg or NotifyConfig(health=False, auto_restart=False),
        webhook_url=URL,
        sender=sent or Sent(),
        clock=clock or Clock(),
    )


def add_event(engine, *, severity="error", rule="r", line="ERROR boom"):
    with Session(engine) as s:
        s.add(
            ErrorEvent(
                app_id="x",
                service_id="svc",
                rule_id=rule,
                rule_name=rule.upper(),
                severity=severity,
                level="error",
                source=0,
                file_name="app.log",
                offset=0,
                line=line,
                detected_at=datetime.now(UTC),
            )
        )
        s.commit()


# --- 設定 ---


def test_notify_config_defaults_and_override():
    assert parse_config({}).notify == NotifyConfig()
    cfg = parse_config({"notify": {"min_severity": "warn", "cooldown": 60, "health": False}})
    assert (cfg.notify.min_severity, cfg.notify.cooldown, cfg.notify.health) == ("warn", 60, False)


@pytest.mark.parametrize(
    "raw",
    [
        {"min_severity": "critical"},
        {"cooldown": 0},
        {"interval": True},
        {"health": "yes"},
        {"webhook_url": URL},  # URL は設定ファイルに書かない
    ],
)
def test_notify_config_invalid(raw):
    with pytest.raises(ConfigError):
        parse_config({"notify": raw})


# --- Webhook の読み込み ---


def test_webhook_unset(tmp_path):
    assert slack.load_webhook_url({}, tmp_path / "none") is None


def test_webhook_from_env_and_dotenv(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(f"# c\nOTHER=1\nexport {slack.WEBHOOK_ENV}='{URL}'\n", encoding="utf-8")
    assert slack.load_webhook_url({}, dotenv) == URL
    other = "https://hooks.slack.com/services/env"
    assert slack.load_webhook_url({slack.WEBHOOK_ENV: other}, dotenv) == other


def test_webhook_invalid_is_disabled(tmp_path):
    assert slack.load_webhook_url({slack.WEBHOOK_ENV: "http://example.com/"}, tmp_path) is None


def test_send_failure_returns_false():
    # 接続できない宛先（ポート 9 / discard）。例外は出さず False
    assert slack.send("https://127.0.0.1:9/", "x", timeout=1) is False


# --- 抑制 ---


def test_throttle():
    t = Throttle(cooldown=60)
    assert t.submit(("k",), 0, 1, "L") == 1
    assert t.submit(("k",), 10, 2, "L") is None
    assert t.submit(("other",), 10, 1, "O") == 1
    assert t.due(30) == []
    assert t.due(60) == [(("k",), 2, "L")]
    assert t.due(200) == []
    assert t.submit(("k",), 70, 1, "L") is None  # due で通知した時刻から再び抑制
    assert t.submit(("k",), 130, 1, "L") == 2  # 期間明けの新規 + 抑えていた 1 件


# --- エラー検知の通知 ---


def test_existing_events_are_not_notified(engine, tmp_path):
    add_event(engine)
    sent = Sent()
    n = make_notifier(engine, tmp_path, sent=sent)
    assert n.run_once() == 0
    assert sent.messages == []


def test_error_notified_and_suppressed(engine, tmp_path):
    sent, clock = Sent(), Clock()
    n = make_notifier(engine, tmp_path, sent=sent, clock=clock)
    n.run_once()
    add_event(engine, line="ERROR first")
    add_event(engine)
    assert n.run_once() == 1
    assert "ログ検知 [error] x/svc 「R」 2 件" in sent.messages[0]
    assert "`ERROR boom`" in sent.messages[0]  # 最新行
    # 同じ対象は cooldown の間は送らない
    clock.t += 10
    add_event(engine)
    assert n.run_once() == 0
    assert len(sent.messages) == 1
    # 期間が明けたら抑えた件数をまとめて送る
    clock.t += 600
    assert n.run_once() == 1
    assert "前回の通知後に 1 件" in sent.messages[1]


def test_error_escaped(engine, tmp_path):
    sent = Sent()
    n = make_notifier(engine, tmp_path, sent=sent)
    n.run_once()
    add_event(engine, line="ERROR <b>&`x`")
    n.run_once()
    assert "`ERROR &lt;b&gt;&amp;'x'`" in sent.messages[0]


def test_min_severity_and_include_line(engine, tmp_path):
    sent = Sent()
    n = make_notifier(
        engine,
        tmp_path,
        sent=sent,
        cfg=NotifyConfig(health=False, auto_restart=False, include_line=False),
    )
    n.run_once()
    add_event(engine, severity="warn")
    assert n.run_once() == 0  # 既定は error のみ
    add_event(engine, severity="error", line="secret")
    n.run_once()
    assert "secret" not in sent.messages[0]

    sent2 = Sent()
    w = make_notifier(
        engine,
        tmp_path,
        sent=sent2,
        cfg=NotifyConfig(health=False, auto_restart=False, min_severity="warn"),
    )
    w.run_once()
    add_event(engine, severity="warn", rule="w")
    assert w.run_once() == 1
    assert "[warn]" in sent2.messages[0]


def test_send_failure_does_not_raise(engine, tmp_path):
    n = make_notifier(engine, tmp_path, sent=Sent(ok=False))
    n.run_once()
    add_event(engine)
    assert n.run_once() == 0


def test_many_items_are_capped(engine, tmp_path):
    sent = Sent()
    n = make_notifier(engine, tmp_path, sent=sent)
    n.run_once()
    for i in range(25):
        add_event(engine, rule=f"r{i}")
    assert n.run_once() == 25
    assert sent.messages[0].count("\n• ") == notifier_mod.MAX_ITEMS
    assert "ほか 5 件" in sent.messages[0]


# --- ヘルスチェック ---


def test_health_unhealthy_and_recovery(engine, tmp_path, monkeypatch):
    states = iter(["healthy", "unhealthy", "unhealthy", "healthy", "unhealthy", "unhealthy"])
    monkeypatch.setattr(
        notifier_mod,
        "service_health",
        lambda *_a, **_k: ServiceHealth("svc", next(states), "接続できません"),
    )
    sent, clock = Sent(), Clock()
    n = make_notifier(
        engine, tmp_path, sent=sent, clock=clock, cfg=NotifyConfig(auto_restart=False)
    )
    assert n.run_once() == 0  # healthy
    assert n.run_once() == 1  # unhealthy になった
    assert "ヘルスチェック異常 x/svc: 接続できません" in sent.messages[-1]
    assert n.run_once() == 0  # unhealthy のまま
    assert n.run_once() == 1  # 回復
    assert "ヘルスチェック回復 x/svc" in sent.messages[-1]
    clock.t += 10
    assert n.run_once() == 0  # cooldown 中の再発は抑制
    clock.t += 600
    assert n.run_once() == 1
    assert "前回の通知後に 1 件" in sent.messages[-1]


def test_health_disabled(engine, tmp_path, monkeypatch):
    def fail(*_a, **_k):
        raise AssertionError("呼ばれない")

    monkeypatch.setattr(notifier_mod, "service_health", fail)
    assert make_notifier(engine, tmp_path).run_once() == 0


# --- 自動再起動 ---


def set_gave_up(engine, gave_up):
    with Session(engine) as s:
        row = s.get(ServiceSupervision, ("x", "svc"))
        if row is None:
            row = ServiceSupervision(app_id="x", service_id="svc", desired=True, attempts=5)
            s.add(row)
        row.gave_up = gave_up
        row.last_message = "5 回試行しても復旧しませんでした"
        s.commit()


def test_auto_restart_gave_up(engine, tmp_path):
    sent = Sent()
    n = make_notifier(
        engine,
        tmp_path,
        sent=sent,
        auto_restart=True,
        cfg=NotifyConfig(health=False),
    )
    set_gave_up(engine, True)
    assert n.run_once() == 0  # 起動時点の上限到達は通知しない
    set_gave_up(engine, False)
    assert n.run_once() == 0
    set_gave_up(engine, True)
    assert n.run_once() == 1
    assert "自動再起動を停止（上限到達） x/svc: 5 回試行" in sent.messages[-1]
    assert n.run_once() == 0


def test_payload_is_json(monkeypatch):
    captured = {}

    class Res:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        captured["timeout"] = timeout
        return Res()

    monkeypatch.setattr(slack.urllib.request, "urlopen", fake_urlopen)
    assert slack.send(URL, "hello") is True
    assert captured == {"body": {"text": "hello"}, "timeout": slack.SEND_TIMEOUT}


# --- 起動 ---


@pytest.mark.parametrize("url", [None, URL])
def test_lifespan_starts_with_or_without_webhook(engine, tmp_path, monkeypatch, url):
    import asyncio

    from thoth import main
    from thoth.config import Config
    from thoth.process.manager import ProcessManager

    holder = SimpleNamespace(registry=AppRegistry(()))
    monkeypatch.setattr(main, "get_config", lambda: Config())
    monkeypatch.setattr(main, "get_engine", lambda: engine)
    monkeypatch.setattr(main, "get_registry_holder", lambda: holder)
    monkeypatch.setattr(main, "get_process_manager", lambda: ProcessManager(engine, tmp_path))
    monkeypatch.setattr(main.slack, "load_webhook_url", lambda: url)
    started = []
    monkeypatch.setattr(main.Notifier, "start", lambda self: started.append(self))

    async def run():
        async with main.lifespan(main.app):
            pass

    asyncio.run(run())
    assert len(started) == (0 if url is None else 1)


# --- レビュー指摘の回帰 ---


def test_dotenv_trailing_comment_and_invalid_chars(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(f"{slack.WEBHOOK_ENV}={URL}  # prod\n", encoding="utf-8")
    assert slack.load_webhook_url({}, dotenv) == URL
    bad = {slack.WEBHOOK_ENV: URL + " x"}
    assert slack.load_webhook_url(bad, tmp_path / "none") is None
    bad = {slack.WEBHOOK_ENV: "https://hooks.slack.com.evil.example/x"}
    assert slack.load_webhook_url(bad, tmp_path / "none") is None


def test_send_unexpected_exception_hides_url(monkeypatch, caplog):
    def boom(req, timeout):
        raise ValueError(f"bad {req.full_url}")

    monkeypatch.setattr(slack.urllib.request, "urlopen", boom)
    assert slack.send(URL, "x") is False
    assert "services/T/B/X" not in caplog.text


def health_seq(monkeypatch, seq):
    states = iter(seq)
    monkeypatch.setattr(
        notifier_mod,
        "service_health",
        lambda *_a, **_k: ServiceHealth("svc", next(states), None),
    )


def test_health_recovery_after_suppressed_alert(engine, tmp_path, monkeypatch):
    health_seq(monkeypatch, ["unhealthy", "healthy", "unhealthy", "healthy"])
    sent, clock = Sent(), Clock()
    n = make_notifier(
        engine, tmp_path, sent=sent, clock=clock, cfg=NotifyConfig(auto_restart=False)
    )
    n.run_once()  # 異常
    n.run_once()  # 回復
    clock.t += 10
    assert n.run_once() == 0  # cooldown 中の再発は抑制
    assert n.run_once() == 1  # それでも回復は通知し、抑えた異常を添える
    assert "ヘルスチェック回復 x/svc（通知を抑制した間に 1 回異常" in sent.messages[-1]
    clock.t += 600
    health_seq(monkeypatch, ["healthy"])
    assert n.run_once() == 0  # 後から「異常」を送らない


def test_health_stopped_is_not_recovery(engine, tmp_path, monkeypatch):
    health_seq(monkeypatch, ["unhealthy", "unknown", "healthy"])
    sent = Sent()
    n = make_notifier(engine, tmp_path, sent=sent, cfg=NotifyConfig(auto_restart=False))
    assert n.run_once() == 1
    assert n.run_once() == 0
    assert n.run_once() == 0


def test_event_id_reset_after_purge(engine, tmp_path):
    from sqlalchemy import delete

    for _ in range(3):
        add_event(engine)
    sent = Sent()
    n = make_notifier(engine, tmp_path, sent=sent)
    n.run_once()  # 既存の 3 件は通知済み扱い
    with Session(engine) as s:
        s.execute(delete(ErrorEvent))
        s.commit()
    add_event(engine)  # id が 1 から振り直される
    assert n.run_once() == 1


def test_auto_restart_throttled(engine, tmp_path):
    sent, clock = Sent(), Clock()
    n = make_notifier(
        engine, tmp_path, sent=sent, clock=clock, auto_restart=True, cfg=NotifyConfig(health=False)
    )
    n.run_once()
    set_gave_up(engine, True)
    assert n.run_once() == 1
    set_gave_up(engine, False)
    n.run_once()
    set_gave_up(engine, True)
    clock.t += 10
    assert n.run_once() == 0  # cooldown 中


def test_suppressed_alert_dropped_when_unknown(engine, tmp_path, monkeypatch):
    health_seq(monkeypatch, ["unhealthy", "healthy", "unhealthy", "unknown", "healthy"])
    sent, clock = Sent(), Clock()
    n = make_notifier(
        engine, tmp_path, sent=sent, clock=clock, cfg=NotifyConfig(auto_restart=False)
    )
    n.run_once()
    n.run_once()
    clock.t += 10
    for _ in range(3):
        assert n.run_once() == 0
    clock.t += 600
    health_seq(monkeypatch, ["healthy"])
    assert n.run_once() == 0  # 回復後に「異常」を送らない


def test_dotenv_quoted_value_with_comment(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(f'{slack.WEBHOOK_ENV}="{URL}" # c\n', encoding="utf-8")
    assert slack.load_webhook_url({}, dotenv) == URL
