"""サービスの起動・停止・再起動（設計: docs/architecture.md「プロセス制御（#5）」）。

- 実行は argv 配列・``shell=False``。コマンド・環境変数・作業ディレクトリは YAML の登録内容のみ。
- ``start_new_session`` で thoth と別のセッション・プロセスグループに分離し、thoth が再起動しても
  対象アプリは落ちない。出力はパイプではなくログファイルへ直接書く（thoth 終了で詰まらせない）。
- ``pkill`` / ポート検索による kill はしない。
  停止対象は PID ファイルまたは thoth が記録した PID のみ。
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from thoth.apps.schema import App, ProcessService, Service
from thoth.db.models import AppState, ServiceOperation, ServiceProcess, ServiceSupervision
from thoth.process.env import ALLOWED_THOTH_VARS, ProcessConfigError, build_env, resolve_argv
from thoth.process.ps import ProcInfo, process_info

logger = logging.getLogger(__name__)

_MESSAGE_LIMIT = 1000
_LOG_MAX_BYTES = 5 * 1024 * 1024  # 超えたら起動・停止のたびに 1 世代だけ退避する
_PID_FILE_START_WAIT = 10.0  # 起動コマンド正常終了後に PID ファイルの反映を待つ秒数
# PID ファイルの更新時刻より後に始まったプロセスは別物とみなす。起動スクリプトは対象を起動した
# 直後に PID ファイルを書くため、その遅れ（ps の lstart は秒精度）を吸収する猶予
_PID_REUSE_TOLERANCE = 2.0


class ProcessError(Exception):
    """kind: conflict（状態の競合）/ failed（実行失敗）/ unsupported / config（設定不備）。"""

    def __init__(self, kind: str, message: str):
        self.kind = kind
        super().__init__(message)


@dataclass(frozen=True)
class ServiceStatus:
    running: bool
    pid: int | None = None
    source: str | None = None  # "pid_file" / "thoth"
    busy: str | None = None  # 実行中の操作（start / stop / restart）
    started: str | None = None  # プロセスの起動時刻（kill 直前の再照合用。API には出さない）


@dataclass(frozen=True)
class ServiceResult:
    service_id: str
    action: str
    result: str  # ok / skipped / error
    message: str | None = None


@dataclass(frozen=True)
class ProbeInputs:
    running: bool
    pid: int | None
    env: dict[str, str]
    defined: dict[str, str]
    cwd: Path
    host: str
    allowed_hosts: tuple[str, ...]
    started_at: datetime | None  # thoth が記録した起動時刻（起動直後の猶予判定用）


@dataclass(frozen=True)
class _Record:
    pid: int
    proc_started: str


def ordered_services(app: App) -> list[Service]:
    """依存順（depends_on の先が前）。YAML の記載順を保つ。循環はローダーが拒否済み。"""
    by_id = {s.id: s for s in app.services}
    done: set[str] = set()
    out: list[Service] = []

    def visit(s: Service) -> None:
        if s.id in done:
            return
        done.add(s.id)
        for dep in s.depends_on:
            if dep in by_id:
                visit(by_id[dep])
        out.append(s)

    for s in app.services:
        visit(s)
    return out


def _port_in_use(port: int, hosts: list[str]) -> bool:
    for host in hosts:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            continue
    return False


def _wait_until(pred: Callable[[], bool], timeout: float, interval: float = 0.2) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if pred():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


class ProcessManager:
    def __init__(self, engine: Engine, log_dir: Path, *, settle: float = 1.0):
        self._engine = engine
        self._log_dir = log_dir
        self._settle = settle  # pid_file 無しの起動で「起動直後に終了していないか」を見る秒数
        self._guard = threading.Lock()
        self._locks: dict[tuple[str, str], threading.RLock] = {}
        self._busy: dict[tuple[str, str], str] = {}
        self._children: dict[tuple[str, str], subprocess.Popen] = {}

    # ---- 公開 API -------------------------------------------------------------------

    def status(self, app: App, svc: Service) -> ServiceStatus:
        proc = self._require_process(svc)
        st = self._inspect(app, proc)
        with self._guard:
            busy = self._busy.get((app.id, svc.id))
        return ServiceStatus(st.running, st.pid, st.source, busy)

    def probe_inputs(self, app: App, svc: ProcessService) -> ProbeInputs:
        """ヘルスチェックの実行に必要な入力（PID・環境・作業ディレクトリ・到達先ホスト）。"""
        st = self._inspect(app, svc)
        env, defined = self._env(app, svc)
        allowed = tuple(defined[k] for k in ALLOWED_THOTH_VARS if k in defined)
        started = None
        with Session(self._engine) as s:
            row = s.get(ServiceProcess, (app.id, svc.id))
            if row is not None:
                started = row.recorded_at
        return ProbeInputs(
            running=st.running,
            pid=st.pid,
            env=env,
            defined=defined,
            cwd=self._service_dir(app, svc),
            host=allowed[0]
            if allowed
            else "127.0.0.1",  # LAN/VPN モードは当該 IP にのみ bind し得る
            allowed_hosts=allowed,
            started_at=started,
        )

    def start(self, app: App, svc: Service) -> str | None:
        proc = self._require_process(svc)

        def run() -> str | None:
            msg = self._do_start(app, proc)
            self.set_desired((app.id, proc.id), True)
            return msg

        return self._operate(app, proc, "start", run)

    def stop(self, app: App, svc: Service) -> str | None:
        proc = self._require_process(svc)

        def run() -> str | None:
            # 停止の意思を先に記録する（停止に失敗しても、自動再起動で起動し直さない）
            self.set_desired((app.id, proc.id), False)
            return self._do_stop(app, proc)

        return self._operate(app, proc, "stop", run)

    def restart(self, app: App, svc: Service) -> str | None:
        proc = self._require_process(svc)

        def run() -> str | None:
            msg = self._restart_body(app, proc)
            self.set_desired((app.id, proc.id), True)
            return msg

        return self._operate(app, proc, "restart", run)

    def auto_restart(self, app: App, svc: ProcessService) -> str | None:
        """自動再起動（#13）。停止していれば起動、生きたままなら停止してから起動する。

        手動の操作と違い、試行回数などの状態はリセットしない。履歴の action は ``auto_restart``。
        """
        return self._operate(app, svc, "auto_restart", lambda: self._restart_body(app, svc))

    def _restart_body(self, app: App, proc: ProcessService) -> str | None:
        notes: list[str] = []
        port_wait = 0.0
        if self._inspect(app, proc).running:
            if msg := self._do_stop(app, proc):
                notes.append(msg)
            port_wait = 5.0
        if msg := self._do_start(app, proc, port_wait=port_wait):
            notes.append(msg)
        return " / ".join(notes) or None

    def start_app(self, app: App) -> list[ServiceResult]:
        results: list[ServiceResult] = []
        failed = False
        for svc in ordered_services(app):
            if not isinstance(svc, ProcessService):
                results.append(self._unsupported(svc, "start"))
            elif self.status(app, svc).running:
                results.append(ServiceResult(svc.id, "start", "skipped", "既に起動中です"))
            else:
                if failed:
                    results.append(
                        ServiceResult(
                            svc.id, "start", "skipped", "先に失敗したサービスがあるため未実行"
                        )
                    )
                    continue
                r = self._try(svc, "start", lambda svc=svc: self.start(app, svc))
                results.append(r)
                failed = r.result == "error"  # 依存される側が起動できないので以降は起動しない
        return results

    def stop_app(self, app: App) -> list[ServiceResult]:
        results: list[ServiceResult] = []
        for svc in reversed(ordered_services(app)):  # 起動の逆順
            if not isinstance(svc, ProcessService):
                results.append(self._unsupported(svc, "stop"))
            elif not self.status(app, svc).running:
                results.append(ServiceResult(svc.id, "stop", "skipped", "起動していません"))
            else:
                results.append(self._try(svc, "stop", lambda svc=svc: self.stop(app, svc)))
        return results

    def restart_app(self, app: App) -> list[ServiceResult]:
        """停止（逆順）→ 起動（依存順）。結果はサービスごとに 1 件（依存順）にまとめる。"""
        stopped = {r.service_id: r for r in self.stop_app(app)}
        order = [s.id for s in ordered_services(app)]
        if any(r.result == "error" for r in stopped.values()):
            out = []
            for sid in order:
                r = stopped[sid]
                if r.result == "error":
                    out.append(ServiceResult(sid, "restart", "error", f"停止に失敗: {r.message}"))
                else:
                    msg = "停止に失敗したサービスがあるため再起動を中断（起動は未実行）"
                    out.append(ServiceResult(sid, "restart", "skipped", msg))
            return out
        started = {r.service_id: r for r in self.start_app(app)}
        out = []
        for sid in order:
            a, b = stopped[sid], started[sid]
            if b.result == "error":
                out.append(ServiceResult(sid, "restart", "error", f"起動に失敗: {b.message}"))
            elif a.result == "ok" or b.result == "ok":
                out.append(ServiceResult(sid, "restart", "ok", b.message or a.message))
            else:
                out.append(ServiceResult(sid, "restart", "skipped", b.message or a.message))
        return out

    # ---- 操作の共通処理（排他・履歴） -------------------------------------------------

    @staticmethod
    def _require_process(svc: Service) -> ProcessService:
        if not isinstance(svc, ProcessService):
            raise ProcessError("unsupported", f"kind '{svc.kind}' の操作には未対応です")
        return svc

    @staticmethod
    def _unsupported(svc: Service, action: str) -> ServiceResult:
        return ServiceResult(svc.id, action, "skipped", f"kind '{svc.kind}' は未対応です")

    @staticmethod
    def _try(svc: Service, action: str, fn: Callable[[], str | None]) -> ServiceResult:
        try:
            return ServiceResult(svc.id, action, "ok", fn())
        except ProcessError as e:
            return ServiceResult(svc.id, action, "error", str(e))

    def _lock(self, key: tuple[str, str]) -> threading.RLock:
        with self._guard:
            return self._locks.setdefault(key, threading.RLock())

    def _operate(
        self, app: App, svc: ProcessService, action: str, fn: Callable[[], str | None]
    ) -> str | None:
        key = (app.id, svc.id)
        # 二重起動を防ぐため、同一サービスの操作は直列化する（待たずに拒否する）
        lock = self._lock(key)
        if not lock.acquire(blocking=False):
            with self._guard:
                busy = self._busy.get(key, "操作")
            raise ProcessError("conflict", f"別の操作（{busy}）を実行中です")
        started = datetime.now(UTC)
        with self._guard:
            self._busy[key] = action
        try:
            try:
                msg = fn()
            except ProcessError as e:
                status = "rejected" if e.kind in ("conflict", "unsupported", "config") else "failed"
                self._record_op(key, action, status, str(e), started)
                raise
            except Exception as e:  # 想定外の失敗も履歴に残し、API には失敗として返す
                # 例外の詳細（パス等）は API 応答・履歴に出さず、サーバーログにのみ残す
                logger.exception("想定外のエラー: %s/%s %s", key[0], key[1], action)
                text = "想定外のエラーが発生しました（詳細はサーバーログを参照）"
                self._record_op(key, action, "failed", text, started)
                raise ProcessError("failed", text) from e
            self._record_op(key, action, "succeeded", msg, started)
            return msg
        finally:
            with self._guard:
                self._busy.pop(key, None)
            lock.release()

    # ---- 状態の判定 ------------------------------------------------------------------

    def _inspect(self, app: App, svc: ProcessService) -> ServiceStatus:
        key = (app.id, svc.id)
        child = self._children.get(key)
        if child is not None and child.poll() is not None:  # 終了済みの子を回収（ゾンビ防止）
            self._children.pop(key, None)

        pid_path = self._pid_file(app, svc)
        if pid_path is not None:
            pid = self._read_pid(pid_path)
            info = process_info(pid) if pid is not None else None
            if info is None:
                return ServiceStatus(False)
            rec = self._get_record(key)
            rec = self._get_record(key)
            if rec is not None and rec.pid == info.pid:
                if rec.proc_started != info.started:  # PID が再利用された別プロセス
                    return ServiceStatus(False)
            else:
                # 初めて見る PID（thoth 再起動後など）。古い PID ファイルが無関係なプロセスを
                # 指している可能性があるため、次を満たさなければ別物として扱い、記録もしない
                # - PID ファイルより後に始まったプロセスではない
                # - thoth と同じユーザーのプロセスである
                # - pid_match が指定されていれば、コマンドラインに含まれる
                try:
                    mtime = pid_path.stat().st_mtime
                except OSError:
                    return ServiceStatus(False)
                if info.started_at is not None and info.started_at > mtime + _PID_REUSE_TOLERANCE:
                    return ServiceStatus(False)
                if info.uid is not None and info.uid != os.getuid():
                    return ServiceStatus(False)
                if svc.pid_match is not None and svc.pid_match not in info.command:
                    return ServiceStatus(False)
                self._save_record(key, info)
            return ServiceStatus(True, info.pid, "pid_file", started=info.started)

        rec = self._get_record(key)
        if rec is None:
            return ServiceStatus(False)
        info = process_info(rec.pid)
        if info is None or info.started != rec.proc_started:
            return ServiceStatus(False)
        return ServiceStatus(True, rec.pid, "thoth", started=rec.proc_started)

    @staticmethod
    def _service_dir(app: App, svc: ProcessService) -> Path:
        base = Path(app.workdir).expanduser()
        return base / Path(svc.workdir).expanduser() if svc.workdir else base

    def _pid_file(self, app: App, svc: ProcessService) -> Path | None:
        if not svc.pid_file:
            return None
        p = Path(svc.pid_file).expanduser()
        return p if p.is_absolute() else self._service_dir(app, svc) / p

    @staticmethod
    def _read_pid(path: Path) -> int | None:
        try:
            return int(path.read_text(encoding="utf-8").split()[0])
        except (OSError, ValueError, IndexError):
            return None

    # ---- 起動 ------------------------------------------------------------------------

    def _do_start(self, app: App, svc: ProcessService, *, port_wait: float = 0.0) -> str | None:
        key = (app.id, svc.id)
        st = self._inspect(app, svc)
        if st.running:
            raise ProcessError("conflict", f"既に起動中です（PID {st.pid}）")

        env, defined = self._env(app, svc)
        argv = self._resolve(svc.start, defined, "start")
        cwd = self._service_dir(app, svc)
        if not cwd.is_dir():
            raise ProcessError("config", f"作業ディレクトリが存在しません（サービス {svc.id}）")

        if svc.port is not None:
            hosts = ["127.0.0.1", *(defined[k] for k in ALLOWED_THOTH_VARS if k in defined)]
            if port_wait > 0:
                _wait_until(lambda: not _port_in_use(svc.port, hosts), port_wait)
            if _port_in_use(svc.port, hosts):
                raise ProcessError(
                    "conflict",
                    f"ポート {svc.port} は既に使用中です（thoth が管理していないプロセスの可能性）",
                )

        proc, log_path = self._spawn(app, svc, "start", argv, cwd, env)
        if svc.pid_file:
            # 起動スクリプト型: スクリプトが対象をバックグラウンド起動して終了する。
            # PID は PID ファイルが正
            try:
                rc = proc.wait(timeout=svc.start_timeout)
            except subprocess.TimeoutExpired:
                self._terminate_group(proc)
                raise ProcessError(
                    "failed",
                    f"起動コマンドが start_timeout（{svc.start_timeout} 秒）内に終了しません",
                ) from None
            if rc != 0:
                raise ProcessError(
                    "failed",
                    f"起動コマンドが終了コード {rc} で終了しました（ログ: apps/{log_path.name}）",
                )
            if not _wait_until(lambda: self._inspect(app, svc).running, _PID_FILE_START_WAIT):
                raise ProcessError(
                    "failed",
                    "起動コマンドは正常終了しましたが、"
                    "PID ファイルから稼働中のプロセスを確認できません",
                )
            return None

        # 常駐型: 起動したプロセス自体が対象。直後に終了していないかを確認して PID を記録する
        try:
            rc = proc.wait(timeout=self._settle)
        except subprocess.TimeoutExpired:
            pass
        else:
            raise ProcessError(
                "failed",
                f"プロセスが起動直後に終了しました（終了コード {rc}、ログ: apps/{log_path.name}）",
            )
        info = process_info(proc.pid)
        if info is None:
            raise ProcessError("failed", "起動したプロセスを確認できません")
        self._children[key] = proc
        self._save_record(key, info)
        return None

    def _env(self, app: App, svc: ProcessService) -> tuple[dict[str, str], dict[str, str]]:
        try:
            return build_env(app, svc, self._mode(app.id))
        except ProcessConfigError as e:
            raise ProcessError("config", str(e)) from None

    @staticmethod
    def _resolve(argv: list[str], defined: dict[str, str], what: str) -> list[str]:
        try:
            return resolve_argv(argv, defined, what)
        except ProcessConfigError as e:
            raise ProcessError("config", str(e)) from None

    def _spawn(
        self,
        app: App,
        svc: ProcessService,
        action: str,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
    ) -> tuple[subprocess.Popen, Path]:
        log_dir = self._log_dir / "apps"
        log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        log_path = log_dir / f"{app.id}.{svc.id}.log"
        try:
            if log_path.stat().st_size > _LOG_MAX_BYTES:
                os.replace(log_path, log_path.with_name(log_path.name + ".1"))
        except FileNotFoundError:
            pass
        fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.fchmod(fd, 0o600)  # 既存ファイルの権限も矯正する
        with os.fdopen(fd, "ab") as log:
            log.write(f"--- {datetime.now(UTC).isoformat()} {action} ---\n".encode())
            log.flush()
            try:
                proc = subprocess.Popen(
                    argv,
                    cwd=cwd,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,  # thoth と別セッション・別プロセスグループ
                    shell=False,
                )
            except OSError as e:
                raise ProcessError(
                    "failed", f"コマンドを実行できません: {e.strerror or type(e).__name__}"
                ) from None
        return proc, log_path

    # ---- 停止 ------------------------------------------------------------------------

    def _do_stop(self, app: App, svc: ProcessService) -> str | None:
        key = (app.id, svc.id)
        st = self._inspect(app, svc)
        if not st.running:
            raise ProcessError("conflict", "起動していません")

        def stopped() -> bool:
            return not self._inspect(app, svc).running

        note: str | None = None
        if svc.stop:
            env, defined = self._env(app, svc)
            argv = self._resolve(svc.stop, defined, "stop")
            cwd = self._service_dir(app, svc)
            if not cwd.is_dir():
                raise ProcessError("config", f"作業ディレクトリが存在しません（サービス {svc.id}）")
            proc, log_path = self._spawn(app, svc, "stop", argv, cwd, env)
            try:
                rc = proc.wait(timeout=svc.stop_timeout)
            except subprocess.TimeoutExpired:
                self._terminate_group(proc)
                raise ProcessError(
                    "failed",
                    f"停止コマンドが stop_timeout（{svc.stop_timeout} 秒）内に終了しません",
                ) from None
            if rc != 0:
                note = f"停止コマンドが終了コード {rc} で終了しました（ログ: apps/{log_path.name}）"
            if not _wait_until(stopped, svc.stop_timeout):
                raise ProcessError(
                    "failed", f"停止コマンドの実行後もプロセスが残っています（PID {st.pid}）"
                )
        else:
            # 既定: thoth が起動した常駐プロセスはプロセスグループへ（子プロセスを残さない）。
            # PID ファイル型は PID ファイルが指すプロセスのみ
            # （グループを共有する別プロセスを巻き込まない）
            group = svc.pid_file is None
            self._signal(st, signal.SIGTERM, group)
            if not _wait_until(stopped, svc.stop_timeout):
                self._signal(st, signal.SIGKILL, group)
                if not _wait_until(stopped, 5.0):
                    raise ProcessError(
                        "failed", f"SIGKILL 後もプロセスが残っています（PID {st.pid}）"
                    )
                note = (
                    f"stop_timeout（{svc.stop_timeout} 秒）内に終了しなかったため SIGKILL しました"
                )
        self._clear_record(key)
        return note

    @staticmethod
    def _signal(st: ServiceStatus, sig: signal.Signals, group: bool) -> None:
        pid = st.pid
        if pid is None:
            return
        # 送信直前に同じプロセスか再確認する（状態判定からの間に終了・PID 再利用された場合に備える）
        cur = process_info(pid)
        if cur is None or (st.started is not None and cur.started != st.started):
            return
        try:
            # グループへ送るのは、PID 自身がグループリーダー（thoth が新セッションで起動）の場合のみ
            if group and os.getpgid(pid) == pid:
                os.killpg(pid, sig)
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise ProcessError("failed", f"プロセス（PID {pid}）へシグナルを送れません") from None

    @staticmethod
    def _terminate_group(proc: subprocess.Popen) -> None:
        """thoth が起動したコマンドのグループを終了させ、回収する（タイムアウト時の後始末）。"""
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                break
            try:
                proc.wait(timeout=3.0)  # 子の回収（ゾンビ防止）を兼ねる
                return
            except subprocess.TimeoutExpired:
                continue
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass

    # ---- DB ----------------------------------------------------------------------------

    def set_desired(self, key: tuple[str, str], desired: bool) -> None:
        """手動の起動・停止の結果を記録する。自動再起動の試行状態はリセットする。"""
        with Session(self._engine) as s:
            s.merge(
                ServiceSupervision(
                    app_id=key[0],
                    service_id=key[1],
                    desired=desired,
                    attempts=0,
                    gave_up=False,
                    last_attempt_at=None,
                    next_attempt_at=None,
                    last_message=None,
                    updated_at=datetime.now(UTC),
                )
            )
            s.commit()

    def _mode(self, app_id: str) -> str:
        with Session(self._engine) as s:
            row = s.get(AppState, app_id)
            return row.mode if row is not None else "local"

    def _get_record(self, key: tuple[str, str]) -> _Record | None:
        with Session(self._engine) as s:
            row = s.get(ServiceProcess, key)
            return None if row is None else _Record(row.pid, row.proc_started)

    def _save_record(self, key: tuple[str, str], info: ProcInfo) -> None:
        with Session(self._engine) as s:
            s.merge(
                ServiceProcess(
                    app_id=key[0],
                    service_id=key[1],
                    pid=info.pid,
                    proc_started=info.started,
                    recorded_at=datetime.now(UTC),
                )
            )
            s.commit()

    def _clear_record(self, key: tuple[str, str]) -> None:
        with Session(self._engine) as s:
            row = s.get(ServiceProcess, key)
            if row is not None:
                s.delete(row)
                s.commit()

    def record_event(
        self, key: tuple[str, str], action: str, status: str, message: str, at: datetime
    ) -> None:
        """操作を伴わない出来事（自動再起動の停止など）を履歴に残す。"""
        self._record_op(key, action, status, message, at)

    def _record_op(
        self, key: tuple[str, str], action: str, status: str, message: str | None, started: datetime
    ) -> None:
        with Session(self._engine) as s:
            s.add(
                ServiceOperation(
                    app_id=key[0],
                    service_id=key[1],
                    action=action,
                    status=status,
                    message=message[:_MESSAGE_LIMIT] if message else None,
                    started_at=started,
                    finished_at=datetime.now(UTC),
                )
            )
            s.commit()
