"""異常終了・異常判定時の自動再起動（設計: docs/architecture.md「自動再起動（#13）」）。

- ``Supervisor`` は lifespan の常駐ループ。``auto_restart`` を指定したサービスだけを見る。
- 再起動するのは「稼働させたい」サービス（thoth の API で起動に成功し、その後に停止を要求して
  いない）が、プロセスの終了、またはヘルスチェックの「異常」で落ちているとき。手動で停止したものは対象外。
- 試行の間隔は指数バックオフ。連続の試行が上限に達しても直らなければ再起動を止める（``gave_up``）。
  手動の起動・停止で状態はリセットされる。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, AutoRestart, ProcessService
from thoth.db.models import ServiceSupervision
from thoth.health.monitor import service_health
from thoth.process.manager import ProcessError, ProcessManager

logger = logging.getLogger(__name__)

TICK_SECONDS = 1.0
Decision = Literal["none", "adopt", "reset", "wait", "restart", "give_up"]


@dataclass(frozen=True)
class SupState:
    desired: bool
    attempts: int
    gave_up: bool
    last_attempt_at: datetime | None
    next_attempt_at: datetime | None


def backoff(cfg: AutoRestart, attempts: int) -> float:
    """``attempts`` 回目の試行のあと、次の試行までに空ける秒数。"""
    return min(cfg.backoff_initial * cfg.backoff_factor ** max(attempts - 1, 0), cfg.backoff_max)


def decide(
    now: datetime,
    cfg: AutoRestart,
    state: SupState | None,
    *,
    running: bool,
    unhealthy: bool,
    busy: bool,
) -> Decision:
    """今回の巡回で何をするか。

    - 記録が無い: 起動中なら adopt（この機能の導入前から動いているものを「稼働させたい」とする）
    - 稼働させたくない / 上限到達済み / 操作中: none
    - 正常: 最後の試行から ``reset_after`` 経っていれば reset（試行回数を 0 に戻す）
    - 異常（停止、または ``on_unhealthy`` で異常判定）:
        試行の待ち時間中は wait、上限に達していて待ち時間も過ぎたら give_up、それ以外は restart
    """
    if state is None:
        return "adopt" if running else "none"
    if not state.desired or state.gave_up or busy:
        return "none"
    failed = not running or (cfg.on_unhealthy and unhealthy)
    if not failed:
        last = state.last_attempt_at
        if state.attempts > 0 and last is not None:
            if now - last >= timedelta(seconds=cfg.reset_after):
                return "reset"
        return "none"
    waiting = state.next_attempt_at is not None and now < state.next_attempt_at
    if state.attempts >= cfg.max_retries:
        return "wait" if waiting else "give_up"
    return "wait" if waiting else "restart"


def _load(engine: Engine, key: tuple[str, str]) -> SupState | None:
    with Session(engine) as s:
        r = s.get(ServiceSupervision, key)
        if r is None:
            return None
        return SupState(r.desired, r.attempts, r.gave_up, r.last_attempt_at, r.next_attempt_at)


def _save(engine: Engine, key: tuple[str, str], **values) -> None:
    with Session(engine) as s:
        r = s.get(ServiceSupervision, key)
        if r is None:
            r = ServiceSupervision(
                app_id=key[0], service_id=key[1], desired=False, attempts=0, gave_up=False
            )
            s.add(r)
        for k, v in values.items():
            setattr(r, k, v)
        r.updated_at = datetime.now(UTC)
        s.commit()


class Supervisor:
    def __init__(self, engine: Engine, holder: RegistryHolder, mgr: ProcessManager):
        self._engine = engine
        self._holder = holder
        self._mgr = mgr
        self._task: asyncio.Task | None = None
        self._inflight: dict[tuple[str, str], asyncio.Task] = {}

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        tasks = [t for t in (self._task, *self._inflight.values()) if t is not None]
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        self._task = None
        self._inflight.clear()

    async def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # 1 回の失敗でループを止めない
                logger.exception("自動再起動のループで想定外のエラー")
            await asyncio.sleep(TICK_SECONDS)

    def tick(self) -> None:
        """対象サービスごとに処理を起動する。長い操作（起動待ち）で他の巡回を止めない。"""
        for app in self._holder.registry.apps:
            for svc in app.services:
                if not isinstance(svc, ProcessService) or svc.auto_restart is None:
                    continue
                key = (app.id, svc.id)
                t = self._inflight.get(key)
                if t is not None and not t.done():
                    continue
                self._inflight[key] = asyncio.create_task(self._run(app, svc))

    async def _run(self, app: App, svc: ProcessService) -> None:
        try:
            await asyncio.to_thread(self.step, app, svc)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("自動再起動の処理に失敗: %s/%s", app.id, svc.id)

    def step(self, app: App, svc: ProcessService, now: datetime | None = None) -> Decision:
        """1 サービス分の判定と実行（同期）。"""
        cfg = svc.auto_restart
        if cfg is None:
            return "none"
        key = (app.id, svc.id)
        now = now or datetime.now(UTC)
        status = self._mgr.status(app, svc)
        state = _load(self._engine, key)
        unhealthy = False
        if status.running and cfg.on_unhealthy:
            unhealthy = service_health(self._engine, self._mgr, app, svc, now).state == "unhealthy"
        d = decide(
            now,
            cfg,
            state,
            running=status.running,
            unhealthy=unhealthy,
            busy=status.busy is not None,
        )
        if d == "adopt":
            _save(self._engine, key, desired=True)
        elif d == "reset":
            _save(self._engine, key, attempts=0, last_attempt_at=None, next_attempt_at=None)
        elif d == "give_up":
            msg = (
                f"再起動を {cfg.max_retries} 回試みても復旧しないため、自動再起動を停止しました"
                "（原因を確認し、手動で起動してください）"
            )
            _save(self._engine, key, gave_up=True, next_attempt_at=None, last_message=msg)
            self._mgr.record_event(key, "auto_restart", "failed", msg, now)
            logger.warning("自動再起動を停止: %s/%s（上限 %d 回）", app.id, svc.id, cfg.max_retries)
        elif d == "restart":
            assert state is not None
            self._restart(app, svc, cfg, key, state, now, unhealthy)
        return d

    def _restart(
        self,
        app: App,
        svc: ProcessService,
        cfg: AutoRestart,
        key: tuple[str, str],
        state: SupState,
        started: datetime,
        unhealthy: bool,
    ) -> None:
        n = state.attempts + 1
        why = "ヘルスチェックが異常" if unhealthy else "プロセスが停止"
        try:
            self._mgr.auto_restart(app, svc)
            msg = f"{why}したため自動再起動しました（{n}/{cfg.max_retries} 回目）"
        except ProcessError as e:
            if e.kind == "conflict":  # 別の操作が先に始まった。試行にはカウントしない
                return
            msg = f"{why}したため自動再起動を試みましたが失敗: {e}（{n}/{cfg.max_retries} 回目）"
        finished = datetime.now(UTC)
        _save(
            self._engine,
            key,
            attempts=n,
            last_attempt_at=finished,
            next_attempt_at=finished + timedelta(seconds=backoff(cfg, n)),
            last_message=msg[:1000],
        )
