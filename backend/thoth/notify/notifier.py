"""Slack 通知の常駐ループ（設計: docs/architecture.md「Slack 通知（#17）」）。

- ``notify.interval`` ごとに、新しいエラー検知（#16）・ヘルスチェックの異常と回復（#12）・
  自動再起動の上限到達（#13）を調べ、条件に一致したものを 1 通の Slack メッセージにまとめて送る。
- 連投の抑制: 同じ対象（エラー検知はアプリ・サービス・ルール、ヘルスと自動再起動はサービス）は
  ``notify.cooldown`` 秒の間は再通知しない。その間の件数は数えておき、期間が明けたら
  「前回の通知後に n 件」とまとめて 1 回通知する。
- 状態はメモリに持つ。thoth 起動時点の検知結果・上限到達は通知済みとみなす（再起動で再送しない）。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import ProcessService
from thoth.config import NOTIFY_SEVERITIES, NotifyConfig
from thoth.db.models import ErrorEvent, ServiceSupervision
from thoth.health.monitor import ServiceHealth, service_health
from thoth.notify import slack
from thoth.process.manager import ProcessManager

logger = logging.getLogger(__name__)

MAX_ITEMS = 20  # 1 通に載せる上限（超えた分は件数のみ）
LINE_PREVIEW = 200
MAX_EVENTS_PER_TICK = 5000

Key = tuple[str, ...]


@dataclass
class _Held:
    count: int = 0
    label: str = ""


@dataclass
class Throttle:
    """対象ごとに ``cooldown`` 秒の間は 1 回しか通知しない。抑えた件数は ``due`` で後から出す。"""

    cooldown: float
    _last: dict[Key, float] = field(default_factory=dict)
    _held: dict[Key, _Held] = field(default_factory=dict)

    def submit(self, key: Key, now: float, count: int, label: str) -> int | None:
        """通知してよければ、抑えていた件数を足した合計を返す。抑える場合は None。"""
        last = self._last.get(key)
        if last is not None and now - last < self.cooldown:
            held = self._held.setdefault(key, _Held())
            held.count += count
            held.label = label
            return None
        self._last[key] = now
        held = self._held.pop(key, None)
        return count + (held.count if held else 0)

    def discard(self, key: Key) -> int:
        """抑えていた件数を捨てて返す（回復の通知に含めた場合など）。"""
        held = self._held.pop(key, None)
        return held.count if held else 0

    def due(self, now: float) -> list[tuple[Key, int, str]]:
        """抑えた件数があり、期間が明けた対象を取り出す（通知済みとして記録する）。"""
        out: list[tuple[Key, int, str]] = []
        for key, held in list(self._held.items()):
            if now - self._last.get(key, 0.0) >= self.cooldown:
                del self._held[key]
                self._last[key] = now
                out.append((key, held.count, held.label))
        return out


def _line(text: str) -> str:
    s = " ".join(text.split())
    if len(s) > LINE_PREVIEW:
        s = s[:LINE_PREVIEW] + "…"
    return slack.escape(s.replace("`", "'"))


def _target(app_id: str, service_id: str) -> str:
    return slack.escape(f"{app_id}/{service_id}")


class Notifier:
    def __init__(
        self,
        engine: Engine,
        holder: RegistryHolder,
        mgr: ProcessManager,
        cfg: NotifyConfig,
        webhook_url: str,
        instance: str = "default",
        sender: Callable[[str, str], bool] = slack.send,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._engine = engine
        self._holder = holder
        self._mgr = mgr
        self._cfg = cfg
        self._url = webhook_url
        self._instance = instance
        self._send = sender
        self._clock = clock
        self._throttle = Throttle(cfg.cooldown)
        self._severities = NOTIFY_SEVERITIES[: NOTIFY_SEVERITIES.index(cfg.min_severity) + 1]
        self._last_event_id: int | None = (
            None  # None = 未初期化（起動時点の最大 id を通知済みとする）
        )
        self._gave_up: set[tuple[str, str]] | None = None
        self._health: dict[tuple[str, str], str] = {}
        self._alerted: set[tuple[str, str]] = set()  # 異常を通知済みのサービス（回復を通知する）
        self._failing = False
        self._task: asyncio.Task | None = None

    # --- 収集 ---

    def _collect_errors(self, now: float) -> list[str]:
        with Session(self._engine) as s:
            max_id = s.scalar(select(func.max(ErrorEvent.id))) or 0
            if self._last_event_id is None:
                self._last_event_id = max_id
                return []
            if max_id < self._last_event_id:
                # 保持期間切れで表が空になると id が振り直される（AUTOINCREMENT なし）
                self._last_event_id = 0
            rows = list(
                s.scalars(
                    select(ErrorEvent)
                    .where(ErrorEvent.id > self._last_event_id)
                    .order_by(ErrorEvent.id)
                    .limit(MAX_EVENTS_PER_TICK)
                )
            )
        if not rows:
            return []
        self._last_event_id = rows[-1].id
        groups: dict[Key, list[ErrorEvent]] = {}
        for ev in rows:
            if ev.severity in self._severities:
                groups.setdefault(("error", ev.app_id, ev.service_id, ev.rule_id), []).append(ev)
        items: list[str] = []
        for key, evs in groups.items():
            latest = evs[-1]
            label = self._error_label(latest)
            total = self._throttle.submit(key, now, len(evs), label)
            if total is None:
                continue
            text = f"{label} {total} 件"
            if total > len(evs):
                text += f"（うち {total - len(evs)} 件は前回の通知後に抑制）"
            if self._cfg.include_line:
                text += f": `{_line(latest.line)}`"
            items.append(text)
        return items

    @staticmethod
    def _error_label(ev: ErrorEvent) -> str:
        icon = ":red_circle:" if ev.severity == "error" else ":warning:"
        return (
            f"{icon} ログ検知 [{ev.severity}] {_target(ev.app_id, ev.service_id)}"
            f" 「{slack.escape(ev.rule_name)}」"
        )

    def _collect_health(self, now: float) -> list[str]:
        items: list[str] = []
        live: set[tuple[str, str]] = set()
        for app in self._holder.registry.apps:
            for svc in app.services:
                if not isinstance(svc, ProcessService):
                    continue
                key = (app.id, svc.id)
                live.add(key)
                h: ServiceHealth = service_health(self._engine, self._mgr, app, svc)
                prev = self._health.get(key)
                self._health[key] = h.state
                target = _target(app.id, svc.id)
                if h.state == "unhealthy" and prev != "unhealthy":
                    label = f":rotating_light: ヘルスチェック異常 {target}"
                    self._alerted.add(key)  # 抑制しても回復は通知する
                    total = self._throttle.submit(("health", *key), now, 1, label)
                    if total is None:
                        continue
                    text = label
                    if total > 1:
                        text += f"（前回の通知後に {total - 1} 回異常になりました）"
                    if h.message:
                        text += f": {_line(h.message)}"
                    items.append(text)
                elif h.state == "healthy" and key in self._alerted:
                    self._alerted.discard(key)
                    text = f":white_check_mark: ヘルスチェック回復 {target}"
                    held = self._throttle.discard(("health", *key))
                    if held:  # 抑えていた異常は回復と一緒に伝え、後から「異常」を送らない
                        text += f"（通知を抑制した間に {held} 回異常になりました）"
                    items.append(text)
                elif h.state == "unknown":
                    # 停止・再起動直後など。回復は通知せず、抑えていた異常も後から送らない
                    self._alerted.discard(key)
                    self._throttle.discard(("health", *key))
        for key in set(self._health) - live:  # 定義から消えたサービス
            del self._health[key]
            self._alerted.discard(key)
        return items

    def _collect_auto_restart(self, now: float) -> list[str]:
        targets = {
            (app.id, svc.id)
            for app in self._holder.registry.apps
            for svc in app.services
            if isinstance(svc, ProcessService) and svc.auto_restart is not None
        }
        with Session(self._engine) as s:
            rows = list(s.scalars(select(ServiceSupervision).where(ServiceSupervision.gave_up)))
        now_gave_up = {
            (r.app_id, r.service_id): r for r in rows if (r.app_id, r.service_id) in targets
        }
        prev, self._gave_up = self._gave_up, set(now_gave_up)
        if prev is None:  # 起動時点の上限到達は通知済みとみなす
            return []
        items: list[str] = []
        for key in sorted(set(now_gave_up) - prev):
            label = f":octagonal_sign: 自動再起動を停止（上限到達） {_target(*key)}"
            total = self._throttle.submit(("auto_restart", *key), now, 1, label)
            if total is None:
                continue
            text = label
            if total > 1:
                text += f"（前回の通知後に {total - 1} 回上限に達しました）"
            msg = now_gave_up[key].last_message
            if msg:
                text += f": {_line(msg)}"
            items.append(text)
        return items

    # --- 送信 ---

    def collect(self) -> list[str]:
        now = self._clock()
        items = self._collect_errors(now)
        if self._cfg.health:
            items += self._collect_health(now)
        if self._cfg.auto_restart:
            items += self._collect_auto_restart(now)
        for _key, count, label in self._throttle.due(now):
            items.append(f"{label}: 前回の通知後に {count} 件（通知を抑制していました）")
        return items

    def format(self, items: list[str]) -> str:
        head = f"*thoth* ({slack.escape(self._instance)}) の通知"
        lines = [f"• {t}" for t in items[:MAX_ITEMS]]
        if len(items) > MAX_ITEMS:
            lines.append(f"…ほか {len(items) - MAX_ITEMS} 件")
        return "\n".join([head, *lines])

    def run_once(self) -> int:
        """1 回分を調べて送る。送った項目数を返す（失敗・対象なしは 0）。"""
        items = self.collect()
        if not items:
            return 0
        if not self._send(self._url, self.format(items)):
            if not self._failing:
                logger.warning("Slack 通知を送れませんでした（%d 項目は再送しません）", len(items))
            self._failing = True
            return 0
        self._failing = False
        return len(items)

    # --- ループ ---

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
                # DB 読み取り・ヘルス判定・HTTP 送信はイベントループを止めないようスレッドで行う
                await asyncio.to_thread(self.run_once)
            except asyncio.CancelledError:
                raise
            except Exception:  # 1 回の失敗でループを止めない
                logger.exception("Slack 通知のループで想定外のエラー")
            await asyncio.sleep(self._cfg.interval)
