"""launchd 定期ジョブ（kind: scheduled）の状態判定（設計: architecture.md「定期ジョブ（#14）」）。

- 成否・実行中は ``launchctl print <domain>/<label>`` の ``state`` / ``last exit code`` から求める。
- 最終実行時刻は ``log_paths`` の最新の更新時刻（launchd は最終実行時刻を直接返さないため）。
- ``expected_interval`` を指定したジョブは、最終実行がその 1.5 倍を超えて古ければ「遅延」とする。
- ログの内容・launchctl の出力全文は返さない（定型メッセージのみ）。
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from thoth.apps.schema import App, ScheduledService

ScheduledState = Literal["ok", "running", "failed", "overdue", "never", "unloaded", "unknown"]
OVERDUE_FACTOR = 1.5
_TIMEOUT = 5.0
_STATE_RE = re.compile(r"^\s*state = (\S+)", re.M)
_EXIT_RE = re.compile(r"^\s*last exit code = (-?\d+)", re.M)
_RUNS_RE = re.compile(r"^\s*runs = (\d+)", re.M)

# (target) -> (returncode, stdout)。テストで差し替える
Runner = Callable[[str], tuple[int, str]]


def run_launchctl_print(target: str) -> tuple[int, str]:
    try:
        r = subprocess.run(
            ["launchctl", "print", target],
            shell=False,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return -1, ""
    return r.returncode, r.stdout


@dataclass(frozen=True)
class LaunchdInfo:
    running: bool
    exit_code: int | None  # 一度も終了していなければ None
    runs: int | None


def parse_print(out: str) -> LaunchdInfo:
    state = _STATE_RE.search(out)
    code = _EXIT_RE.search(out)
    runs = _RUNS_RE.search(out)
    return LaunchdInfo(
        running=bool(state and state.group(1) == "running"),
        exit_code=int(code.group(1)) if code else None,
        runs=int(runs.group(1)) if runs else None,
    )


@dataclass(frozen=True)
class ScheduledStatus:
    service_id: str
    state: ScheduledState
    message: str
    schedule: str | None = None
    expected_interval: int | None = None
    last_run_at: datetime | None = None
    exit_code: int | None = None


def default_domain() -> str:
    return f"gui/{os.getuid()}"


def last_run_time(app: App, svc: ScheduledService) -> datetime | None:
    """log_paths のうち最も新しい更新時刻（読めないものは無視）。"""
    base = Path(app.workdir).expanduser()
    wd = base / Path(svc.workdir).expanduser() if svc.workdir else base
    latest: float | None = None
    for p in svc.log_paths:
        try:
            m = (wd / Path(p).expanduser()).stat().st_mtime
        except OSError:
            continue
        latest = m if latest is None else max(latest, m)
    return None if latest is None else datetime.fromtimestamp(latest, UTC)


def _fmt_interval(sec: int) -> str:
    if sec % 86400 == 0:
        return f"{sec // 86400}日"
    if sec % 3600 == 0:
        return f"{sec // 3600}時間"
    if sec % 60 == 0:
        return f"{sec // 60}分"
    return f"{sec}秒"


def scheduled_status(
    app: App,
    svc: ScheduledService,
    now: datetime | None = None,
    runner: Runner = run_launchctl_print,
) -> ScheduledStatus:
    now = now or datetime.now(UTC)
    last = last_run_time(app, svc)

    def make(state: ScheduledState, message: str, exit_code: int | None = None):
        return ScheduledStatus(
            svc.id, state, message, svc.schedule, svc.expected_interval, last, exit_code
        )

    target = f"{svc.launchd_domain or default_domain()}/{svc.launchd_label}"
    rc, out = runner(target)
    if rc == -1:
        return make("unknown", "launchctl を実行できません")
    if rc != 0:
        return make("unloaded", "launchd に登録されていません")
    info = parse_print(out)
    if info.running:
        return make("running", "実行中です", info.exit_code)
    if info.exit_code not in (None, 0):
        return make(
            "failed", f"直近の実行が失敗しました（終了コード {info.exit_code}）", info.exit_code
        )
    if (
        svc.expected_interval is not None
        and last is not None
        and now - last > timedelta(seconds=svc.expected_interval * OVERDUE_FACTOR)
    ):
        return make(
            "overdue",
            f"最終実行が期待間隔（{_fmt_interval(svc.expected_interval)}）を超えています",
            info.exit_code,
        )
    if info.exit_code is None and not info.runs and last is None:
        return make("never", "まだ実行された形跡がありません")
    if last is None:
        return make(
            "ok", "直近の実行は成功（最終実行時刻は不明。log_paths 未設定）", info.exit_code
        )
    return make("ok", "直近の実行は成功しました", info.exit_code)
