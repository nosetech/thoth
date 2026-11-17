"""設定ローダー（dataclass + 検証）。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml

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
class AppsConfig:
    path: str = "../config/apps.yaml"


@dataclass(frozen=True)
class Config:
    instance: str = "default"
    backend: BackendConfig = field(default_factory=BackendConfig)
    frontend: FrontendConfig = field(default_factory=FrontendConfig)
    db: DbConfig = field(default_factory=DbConfig)
    log: LogConfig = field(default_factory=LogConfig)
    apps: AppsConfig = field(default_factory=AppsConfig)

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


def parse_config(raw: Any) -> Config:
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError("設定ファイルのトップレベルはマッピングで指定してください")
    unknown = set(raw) - {"instance", "backend", "frontend", "db", "log", "apps"}
    if unknown:
        raise ConfigError(f"未知のキーがあります: {sorted(unknown)}")

    d = Config()
    b = _section(raw.get("backend"), "backend", BackendConfig)
    f = _section(raw.get("frontend"), "frontend", FrontendConfig)
    db = _section(raw.get("db"), "db", DbConfig)
    lg = _section(raw.get("log"), "log", LogConfig)
    ap = _section(raw.get("apps"), "apps", AppsConfig)
    return Config(
        instance=_nonempty_str(raw.get("instance", d.instance), "instance"),
        backend=BackendConfig(port=_port(b.get("port", d.backend.port), "backend.port")),
        frontend=FrontendConfig(port=_port(f.get("port", d.frontend.port), "frontend.port")),
        db=DbConfig(path=_nonempty_str(db.get("path", d.db.path), "db.path")),
        log=LogConfig(dir=_nonempty_str(lg.get("dir", d.log.dir), "log.dir")),
        apps=AppsConfig(path=_nonempty_str(ap.get("path", d.apps.path), "apps.path")),
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
