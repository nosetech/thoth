"""ヘルスチェックの 1 回分の実行（設計: docs/architecture.md「Healthcheck」）。

方式は tcp / http / pid / command。スケジューリング・連続失敗の集計は呼び出し側で行う。
応答本文・コマンド出力・環境変数の値は結果に含めない。
"""

from __future__ import annotations

import http.client
import socket
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from thoth.apps.schema import Healthcheck, ProcessService
from thoth.process.ps import process_info


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    message: str


def probe(
    svc: ProcessService,
    *,
    pid: int | None = None,
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
    host: str = "127.0.0.1",
    url: str | None = None,
) -> ProbeResult:
    """healthcheck（省略時は port があれば tcp、無ければ pid）を 1 回実行する。

    url は ``${LAN_IP}`` 等を解決済みの URL（省略時は設定値）。
    """
    hc = svc.healthcheck
    if hc is None:
        hc = Healthcheck(type="tcp" if svc.port is not None else "pid")
    try:
        if hc.type == "tcp":
            return _tcp(svc.port, host, hc.timeout)
        if hc.type == "http":
            return _http(url or hc.url or "", hc)
        if hc.type == "pid":
            return _pid(pid)
        return _command(hc, env, cwd)
    except Exception as e:  # 想定外の例外でも「失敗」として返す
        return ProbeResult(False, f"チェックを実行できません: {type(e).__name__}")


def _tcp(port: int | None, host: str, timeout: float) -> ProbeResult:
    if port is None:
        return ProbeResult(False, "port が未設定です")
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return ProbeResult(True, f"{host}:{port} に接続できました")
    except OSError:
        return ProbeResult(False, f"{host}:{port} に接続できません")


def _http(url: str, hc: Healthcheck) -> ProbeResult:
    u = urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        return ProbeResult(False, "url が不正です")
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    conn = cls(u.hostname, u.port, timeout=hc.timeout)
    try:
        target = u.path or "/"
        if u.query:
            target += f"?{u.query}"
        conn.request("GET", target)  # リダイレクトは追従しない
        status = conn.getresponse().status
    except (OSError, http.client.HTTPException):
        return ProbeResult(False, "HTTP 接続に失敗しました")
    finally:
        conn.close()
    if status in hc.expect_status:
        return ProbeResult(True, f"HTTP {status}")
    return ProbeResult(False, f"HTTP {status}（期待: {hc.expect_status}）")


def _pid(pid: int | None) -> ProbeResult:
    if pid is not None and process_info(pid) is not None:
        return ProbeResult(True, "プロセスが生存しています")
    return ProbeResult(False, "プロセスが存在しません")


def _command(hc: Healthcheck, env: Mapping[str, str] | None, cwd: Path | None) -> ProbeResult:
    assert hc.command is not None
    try:
        r = subprocess.run(
            hc.command,
            shell=False,
            cwd=cwd,
            env=None if env is None else dict(env),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=hc.timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ProbeResult(False, "コマンドがタイムアウトしました")
    except OSError:
        return ProbeResult(False, "コマンドを実行できません")
    if r.returncode == 0:
        return ProbeResult(True, "終了コード 0")
    return ProbeResult(False, f"終了コード {r.returncode}")
