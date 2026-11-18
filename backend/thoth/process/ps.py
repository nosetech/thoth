"""``ps`` によるプロセス情報の取得（PID の再利用検知に使う起動時刻を含む）。"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class ProcInfo:
    pid: int
    started: str  # ps の lstart（"Tue Nov 18 10:00:00 2026"）。PID 再利用の照合に使う
    command: str
    started_at: float | None  # started の epoch 秒（解釈できなければ None）
    uid: int | None = None  # プロセスの実行ユーザー


def process_info(pid: int) -> ProcInfo | None:
    """生存中（ゾンビでない）のプロセス情報。存在しない・ゾンビなら None。"""
    if pid <= 0:
        return None
    env = {"LC_ALL": "C", "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    try:
        out = subprocess.run(
            [
                "ps",
                "-ww",
                "-o",
                "stat=",
                "-o",
                "uid=",
                "-o",
                "lstart=",
                "-o",
                "command=",
                "-p",
                str(pid),
            ],
            capture_output=True,
            text=True,
            timeout=5,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    parts = out.stdout.strip().split(None, 7)
    if len(parts) < 7 or parts[0].startswith("Z"):
        return None
    started = " ".join(parts[2:7])
    try:
        uid: int | None = int(parts[1])
    except ValueError:
        uid = None
    try:
        started_at = datetime.strptime(started, "%a %b %d %H:%M:%S %Y").timestamp()
    except ValueError:
        started_at = None
    return ProcInfo(pid, started, parts[7] if len(parts) > 7 else "", started_at, uid)
