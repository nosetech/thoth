"""ヘルスチェックの定期実行・結果保存・状態判定（設計: docs/architecture.md「定期実行（#12）」）。

- ``HealthMonitor`` は lifespan の常駐ループ。サービスごとの ``interval`` で ``probe`` を実行し、
  結果を ``health_result`` に保存する。1 回の失敗（例外含む）でループを止めない。
- 状態は保存済みの結果から求める（thoth 再起動後も続きから判定できる）。
- thoth が稼働中と把握していない process サービスはチェックしない（状態は「不明」）。
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import Engine, delete, select
from sqlalchemy.orm import Session

from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, Healthcheck, ProcessService
from thoth.db.models import HealthResult
from thoth.health.probe import ProbeResult, probe
from thoth.process.env import ProcessConfigError, resolve_argv
from thoth.process.manager import ProcessError, ProcessManager

logger = logging.getLogger(__name__)

HealthState = Literal["healthy", "unhealthy", "starting", "unknown"]
TICK_SECONDS = 1.0
PURGE_INTERVAL = 3600.0
_MESSAGE_LIMIT = 500


def effective_healthcheck(svc: ProcessService) -> Healthcheck:
    """healthcheck 省略時は port があれば tcp、無ければ pid。"""
    return svc.healthcheck or Healthcheck(type="tcp" if svc.port is not None else "pid")


@dataclass(frozen=True)
class Sample:
    ok: bool
    checked_at: datetime


def evaluate(
    samples: list[Sample],
    hc: Healthcheck,
    now: datetime,
    started_at: datetime | None = None,
) -> HealthState:
    """新しい順の結果（少なくとも failure_threshold 件）から状態を求める。

    - 結果が無い / 最新が古すぎる（interval の 3 倍。下限 60 秒）→ unknown
    - 最新が成功 → healthy
    - 失敗: 起動直後の猶予（start_grace）内 → starting
    - failure_threshold 回連続で失敗 → unhealthy
    - それ未満は直前の成功が残っていれば healthy、無ければ unknown
    """
    if started_at is not None:  # 今回の起動より前の結果は引き継がない
        samples = [x for x in samples if x.checked_at >= started_at]
    if not samples:
        return "unknown"
    last = samples[0]
    if now - last.checked_at > timedelta(seconds=max(hc.interval * 3, 60)):
        return "unknown"
    if last.ok:
        return "healthy"
    if started_at is not None and now - started_at < timedelta(seconds=hc.start_grace):
        return "starting"
    head = samples[: hc.failure_threshold]
    if len(head) == hc.failure_threshold and not any(s.ok for s in head):
        return "unhealthy"
    return "healthy" if any(s.ok for s in head) else "unknown"


@dataclass(frozen=True)
class ServiceHealth:
    service_id: str
    state: HealthState
    message: str | None = None
    checked_at: datetime | None = None


def load_samples(engine: Engine, app_id: str, service_id: str, limit: int) -> list[HealthResult]:
    with Session(engine) as s:
        return list(
            s.scalars(
                select(HealthResult)
                .where(HealthResult.app_id == app_id, HealthResult.service_id == service_id)
                .order_by(HealthResult.checked_at.desc(), HealthResult.id.desc())
                .limit(limit)
            )
        )


def service_health(
    engine: Engine,
    mgr: ProcessManager,
    app: App,
    svc: ProcessService,
    now: datetime | None = None,
) -> ServiceHealth:
    now = now or datetime.now(UTC)
    try:
        inputs = mgr.probe_inputs(app, svc)
    except ProcessError:
        return ServiceHealth(svc.id, "unknown", "設定を解決できません")
    if not inputs.running:
        return ServiceHealth(svc.id, "unknown", "停止中のためチェックしていません")
    hc = effective_healthcheck(svc)
    rows = load_samples(engine, app.id, svc.id, hc.failure_threshold)
    samples = [Sample(r.ok, r.checked_at) for r in rows]
    state = evaluate(samples, hc, now, inputs.started_at)
    last = rows[0] if rows else None
    return ServiceHealth(
        svc.id, state, last.message if last else None, last.checked_at if last else None
    )


def run_probe(mgr: ProcessManager, app: App, svc: ProcessService) -> ProbeResult | None:
    """1 回チェックする。thoth が稼働中と把握していなければ None（チェックしない）。"""
    try:
        inputs = mgr.probe_inputs(app, svc)
    except ProcessError as e:
        return ProbeResult(False, f"設定を解決できません: {e}"[:_MESSAGE_LIMIT])
    if not inputs.running:
        return None
    hc = effective_healthcheck(svc)
    url = None
    if hc.type == "http":
        try:
            url = resolve_argv([hc.url or ""], inputs.defined, "healthcheck.url")[0]
        except ProcessConfigError as e:
            return ProbeResult(False, str(e)[:_MESSAGE_LIMIT])
    return probe(
        svc,
        pid=inputs.pid,
        env=inputs.env,
        cwd=inputs.cwd,
        host=inputs.host,
        url=url,
        allowed_hosts=inputs.allowed_hosts,
    )


def purge_old(engine: Engine, retention_days: int, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(UTC)) - timedelta(days=retention_days)
    with Session(engine) as s:
        n = s.execute(delete(HealthResult).where(HealthResult.checked_at < cutoff)).rowcount
        s.commit()
    return n or 0


class HealthMonitor:
    def __init__(
        self,
        engine: Engine,
        holder: RegistryHolder,
        mgr: ProcessManager,
        retention_days: int,
    ):
        self._engine = engine
        self._holder = holder
        self._mgr = mgr
        self._retention_days = retention_days
        self._due: dict[tuple[str, str], float] = {}
        self._next_purge = 0.0
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # 1 回の失敗でループを止めない
                logger.exception("ヘルスチェックのループで想定外のエラー")
            await asyncio.sleep(TICK_SECONDS)

    async def tick(self) -> None:
        now = time.monotonic()
        if now >= self._next_purge:
            self._next_purge = now + PURGE_INTERVAL
            try:
                n = await asyncio.to_thread(purge_old, self._engine, self._retention_days)
                if n:
                    logger.info("古いヘルスチェック履歴を %d 件削除しました", n)
            except Exception:
                logger.exception("ヘルスチェック履歴の削除に失敗しました")

        targets: list[tuple[App, ProcessService, Healthcheck]] = []
        live: set[tuple[str, str]] = set()
        for app in self._holder.registry.apps:
            for svc in app.services:
                if not isinstance(svc, ProcessService):
                    continue
                key = (app.id, svc.id)
                live.add(key)
                hc = effective_healthcheck(svc)
                if self._due.get(key, 0.0) <= now:
                    self._due[key] = now + hc.interval
                    targets.append((app, svc, hc))
        for key in set(self._due) - live:  # 定義から消えたサービス
            del self._due[key]
        if targets:
            await asyncio.gather(*(self._check(a, s) for a, s, _ in targets))

    def _check_sync(self, app: App, svc: ProcessService) -> None:
        result = run_probe(self._mgr, app, svc)
        if result is None:
            return
        with Session(self._engine) as s:
            s.add(
                HealthResult(
                    app_id=app.id,
                    service_id=svc.id,
                    ok=result.ok,
                    message=result.message[:_MESSAGE_LIMIT],
                    checked_at=datetime.now(UTC),
                )
            )
            s.commit()

    async def _check(self, app: App, svc: ProcessService) -> None:
        try:  # チェックと保存はイベントループを止めないようスレッドで行う
            await asyncio.to_thread(self._check_sync, app, svc)
        except Exception:
            logger.exception("ヘルスチェックに失敗: %s/%s", app.id, svc.id)
