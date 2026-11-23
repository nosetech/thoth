"""アプリ登録定義のスキーマ（設計: docs/architecture.md「アプリ管理モデル」）。"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ID_PATTERN = r"^[a-z][a-z0-9-]{0,31}$"
_ID_RE = re.compile(ID_PATTERN)
_URL_HOST_RE = re.compile(
    r"^https?://(127\.0\.0\.1|localhost|\$\{LAN_IP\}|\$\{TAILSCALE_IP\})(:\d+)?([/?#]|$)"
)

Port = Annotated[int, Field(ge=1, le=65535, strict=True)]
Argv = Annotated[list[str], Field(min_length=1)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Healthcheck(_Strict):
    type: Literal["tcp", "http", "pid", "command"]
    url: str | None = None
    expect_status: list[int] = Field([200], min_length=1)
    command: Argv | None = None
    interval: int = Field(30, gt=0)
    timeout: int = Field(5, gt=0)
    start_grace: int = Field(30, ge=0)
    failure_threshold: int = Field(3, ge=1)

    @model_validator(mode="after")
    def _check(self) -> Healthcheck:
        if any(not 100 <= c <= 599 for c in self.expect_status):
            raise ValueError("expect_status は 100〜599 の HTTP ステータスで指定してください")
        if self.timeout > self.interval:
            raise ValueError("timeout は interval 以下にしてください")
        if self.type == "http":
            if not self.url:
                raise ValueError("type が http の場合は url が必須です")
            if not _URL_HOST_RE.match(self.url):
                raise ValueError(
                    "url のホストは 127.0.0.1 / localhost / ${LAN_IP} / ${TAILSCALE_IP} のみ"
                )
        elif self.url is not None:
            raise ValueError("url は type が http の場合のみ指定できます")
        if self.type == "command":
            if not self.command:
                raise ValueError("type が command の場合は command が必須です")
        elif self.command is not None:
            raise ValueError("command は type が command の場合のみ指定できます")
        return self


class AutoRestart(_Strict):
    """異常時の自動再起動（指定したサービスのみ。設計: architecture.md「自動再起動（#13）」）。"""

    max_retries: int = Field(5, ge=1)  # 連続して再起動を試みる上限回数
    backoff_initial: int = Field(5, gt=0)  # 1 回目と 2 回目の試行の間隔（秒）
    backoff_factor: float = Field(2.0, ge=1)  # 以降は間隔をこの倍率で延ばす
    backoff_max: int = Field(300, gt=0)  # 間隔の上限（秒）
    reset_after: int = Field(300, gt=0)  # 最後の試行からこの秒数、正常なら回数を 0 に戻す
    on_unhealthy: bool = True  # プロセスは生きていてもヘルスチェックが「異常」なら再起動する

    @model_validator(mode="after")
    def _check(self) -> AutoRestart:
        if self.backoff_initial > self.backoff_max:
            raise ValueError("backoff_initial は backoff_max 以下にしてください")
        return self


class _ServiceBase(_Strict):
    id: str
    name: str | None = None
    workdir: str | None = None
    env: dict[str, str] = {}
    log_paths: list[str] = []
    depends_on: list[str] = []

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not _ID_RE.match(v):
            raise ValueError(f"id は {ID_PATTERN} に一致させてください")
        return v


class ProcessService(_ServiceBase):
    kind: Literal["process"]
    start: Argv
    stop: Argv | None = None
    stop_timeout: int = Field(10, gt=0)
    start_timeout: int = Field(30, gt=0)
    port: Port | None = None
    pid_file: str | None = None
    pid_match: str | None = Field(
        None, min_length=1
    )  # pid_file の PID のコマンドラインに含まれる文字列
    healthcheck: Healthcheck | None = None
    auto_restart: AutoRestart | None = None  # 省略時は自動再起動しない

    @model_validator(mode="after")
    def _check_pid_match(self) -> ProcessService:
        if self.pid_match is not None and self.pid_file is None:
            raise ValueError("pid_match は pid_file と一緒に指定してください")
        if self.healthcheck is not None and self.healthcheck.type == "tcp" and self.port is None:
            raise ValueError("healthcheck.type が tcp の場合は port が必須です")
        return self


class ScheduledService(_ServiceBase):
    kind: Literal["scheduled"]
    launchd_label: str = Field(min_length=1)
    plist: str | None = None
    launchd_domain: str | None = None
    schedule: str | None = None
    expected_interval: int | None = Field(None, gt=0)


# kind: cloud は将来用。現状は discriminator の不一致として読み込み時にエラーになる
Service = Annotated[ProcessService | ScheduledService, Field(discriminator="kind")]


class Mode(_Strict):
    env: dict[str, str] = {}


class App(_Strict):
    id: str
    name: str = Field(min_length=1)
    description: str | None = None
    workdir: str = Field(min_length=1)
    env: dict[str, str] = {}
    modes: dict[Literal["local", "lan", "vpn"], Mode] = {"local": Mode()}
    services: list[Service] = Field(min_length=1)

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not _ID_RE.match(v):
            raise ValueError(f"id は {ID_PATTERN} に一致させてください")
        return v


class AppsFile(_Strict):
    apps: list[App] = []
