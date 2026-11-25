"""設定ローダー（dataclass + 検証）。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml

DEFAULT_APPS_PATH = "../config/apps.yaml"
DEFAULT_CONFIG_PATH = "../config/config.yaml"  # backend/ 基準
CONFIG_ENV = "THOTH_CONFIG"
BACKEND_ROOT = Path(__file__).resolve().parent.parent


class ConfigError(Exception):
    """設定が不正な場合のエラー。"""


@dataclass(frozen=True)
class BackendConfig:
    port: int = 8900


@dataclass(frozen=True)
class FrontendConfig:
    port: int = 3900


@dataclass(frozen=True)
class DbConfig:
    path: str = "../data/thoth.db"


@dataclass(frozen=True)
class LogConfig:
    dir: str = "../logs"


@dataclass(frozen=True)
class HealthConfig:
    retention_days: int = 7  # ヘルスチェック履歴の保持期間（日）


@dataclass(frozen=True)
class ErrorsConfig:
    interval: int = 10  # エラー検知でログを読む間隔（秒）
    retention_days: int = 30  # 検知結果の保持期間（日）


@dataclass(frozen=True)
class NotifyConfig:
    """Slack 通知（#17）。Webhook URL は設定ファイルに書かず .env / 環境変数で渡す。"""

    interval: int = 10  # 通知対象を調べる間隔（秒）
    min_severity: str = "error"  # 通知するエラー検知の重要度の下限（error / warn）
    health: bool = True  # ヘルスチェックの異常（unhealthy）と回復を通知する
    auto_restart: bool = True  # 自動再起動の上限到達を通知する
    cooldown: int = 600  # 同じ対象を再通知しない秒数（その間の件数はまとめて後で通知）
    include_line: bool = True  # エラー検知の通知にログ行（先頭 200 文字）を含める


NOTIFY_SEVERITIES = ("error", "warn")


@dataclass(frozen=True)
class AppsConfig:
    path: str | None = None  # 未指定時は DEFAULT_APPS_PATH（無くても可）。明示時は必須


@dataclass(frozen=True)
class Config:
    instance: str = "default"
    backend: BackendConfig = field(default_factory=BackendConfig)
    frontend: FrontendConfig = field(default_factory=FrontendConfig)
    db: DbConfig = field(default_factory=DbConfig)
    log: LogConfig = field(default_factory=LogConfig)
    apps: AppsConfig = field(default_factory=AppsConfig)
    health: HealthConfig = field(default_factory=HealthConfig)
    errors: ErrorsConfig = field(default_factory=ErrorsConfig)
    notify: NotifyConfig = field(default_factory=NotifyConfig)

    def resolve_path(self, value: str) -> Path:
        """相対パスは backend/ 基準で解決する。"""
        p = Path(value)
        return p if p.is_absolute() else (BACKEND_ROOT / p).resolve()


def _section(data: Any, name: str, cls: type) -> dict[str, Any]:
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"{name} はマッピングで指定してください")
    allowed = {f.name for f in fields(cls)}
    unknown = set(data) - allowed
    if unknown:
        raise ConfigError(f"{name} に未知のキーがあります: {sorted(unknown)}")
    return data


def _port(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ConfigError(f"{name} は 1〜65535 の整数で指定してください")
    return value


def _nonempty_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{name} は空でない文字列で指定してください")
    return value.strip()


def _positive(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ConfigError(f"{name} は 1 以上の整数で指定してください")
    return value


def _bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ConfigError(f"{name} は true / false で指定してください")
    return value


def _notify(data: dict[str, Any]) -> NotifyConfig:
    d = NotifyConfig()
    sev = data.get("min_severity", d.min_severity)
    if sev not in NOTIFY_SEVERITIES:
        raise ConfigError(
            f"notify.min_severity は {' / '.join(NOTIFY_SEVERITIES)} で指定してください"
        )
    return NotifyConfig(
        interval=_positive(data.get("interval", d.interval), "notify.interval"),
        min_severity=sev,
        health=_bool(data.get("health", d.health), "notify.health"),
        auto_restart=_bool(data.get("auto_restart", d.auto_restart), "notify.auto_restart"),
        cooldown=_positive(data.get("cooldown", d.cooldown), "notify.cooldown"),
        include_line=_bool(data.get("include_line", d.include_line), "notify.include_line"),
    )


def parse_config(raw: Any) -> Config:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError("設定ファイルのトップレベルはマッピングで指定してください")
    unknown = set(raw) - {
        "instance",
        "backend",
        "frontend",
        "db",
        "log",
        "apps",
        "health",
        "errors",
        "notify",
    }
    if unknown:
        raise ConfigError(f"未知のキーがあります: {sorted(unknown)}")

    d = Config()
    b = _section(raw.get("backend"), "backend", BackendConfig)
    f = _section(raw.get("frontend"), "frontend", FrontendConfig)
    db = _section(raw.get("db"), "db", DbConfig)
    lg = _section(raw.get("log"), "log", LogConfig)
    ap = _section(raw.get("apps"), "apps", AppsConfig)
    hl = _section(raw.get("health"), "health", HealthConfig)
    er = _section(raw.get("errors"), "errors", ErrorsConfig)
    nt = _section(raw.get("notify"), "notify", NotifyConfig)
    days = _positive(hl.get("retention_days", d.health.retention_days), "health.retention_days")
    return Config(
        instance=_nonempty_str(raw.get("instance", d.instance), "instance"),
        backend=BackendConfig(port=_port(b.get("port", d.backend.port), "backend.port")),
        frontend=FrontendConfig(port=_port(f.get("port", d.frontend.port), "frontend.port")),
        db=DbConfig(path=_nonempty_str(db.get("path", d.db.path), "db.path")),
        log=LogConfig(dir=_nonempty_str(lg.get("dir", d.log.dir), "log.dir")),
        apps=AppsConfig(path=_nonempty_str(ap["path"], "apps.path") if "path" in ap else None),
        health=HealthConfig(retention_days=days),
        errors=ErrorsConfig(
            interval=_positive(er.get("interval", d.errors.interval), "errors.interval"),
            retention_days=_positive(
                er.get("retention_days", d.errors.retention_days), "errors.retention_days"
            ),
        ),
        notify=_notify(nt),
    )


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """設定を読み込む。

    暗黙のデフォルトパスが無い場合のみ既定値で動く。引数や THOTH_CONFIG で
    明示したパスが存在しない場合・不正な設定は ConfigError。
    """
    explicit = path if path is not None else os.environ.get(CONFIG_ENV)
    if explicit is not None and not str(explicit).strip():
        raise ConfigError("設定ファイルのパスが空です")
    p = Path(explicit if explicit is not None else DEFAULT_CONFIG_PATH)
    if not p.is_absolute():
        p = (BACKEND_ROOT / p).resolve()
    if not p.exists():
        if explicit is not None:
            raise ConfigError(f"設定ファイルが見つかりません: {p}")
        return Config()
    if not p.is_file():
        raise ConfigError(f"設定ファイルがファイルではありません: {p}")
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise ConfigError(f"YAML の解析に失敗しました: {e}") from e
    return parse_config(raw)
