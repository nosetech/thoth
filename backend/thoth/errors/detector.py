"""ログのエラー検知（設計: docs/architecture.md「エラー検知（#16）」）。

- ``ErrorDetector`` は lifespan の常駐ループ。``errors.interval`` ごとに、エラー検知ルールを持つ
  アプリの ``log_paths`` の追記分を読み、ルールに一致した行を ``error_event`` に保存する。
- 読み取り位置は ``log_cursor`` に保存し、thoth 再起動後も続きから読む。初めて見るファイルは
  末尾から読み始める（過去のログを一度に検知しない）。
- ローテーション: inode が変わったら（リネーム方式）、同じディレクトリの世代ファイルから旧 inode の
  ファイルを探して残りを読み、新しいファイルは先頭から読む。ファイルが縮んだら（copytruncate 方式）
  先頭から読み直す。
- 1 行が複数のルールに一致しても、定義順で最初に一致したルールで 1 件だけ記録する。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import Engine, delete, select
from sqlalchemy.orm import Session

from thoth.apps.loader import AppRegistry
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, ErrorRule, Service
from thoth.db.models import ErrorEvent, LogCursor
from thoth.logreader.reader import (
    LevelOf,
    decode_line,
    effective_log_format,
    end_of_complete,
    is_generation,
    level_detector,
    source_path,
    split_lines,
)

logger = logging.getLogger(__name__)

MAX_READ_BYTES = 1024 * 1024  # 1 ファイル・1 回あたりに読む上限（残りは次回）
MAX_EVENTS_PER_SCAN = 100  # 1 ファイル・1 回あたりに記録する上限（大量のエラー出力対策）
LINE_LIMIT = 2000  # 保存する行の最大文字数
PURGE_INTERVAL = 3600.0


@dataclass(frozen=True)
class CompiledRule:
    rule: ErrorRule
    pattern: re.Pattern[str] | None
    exclude: re.Pattern[str] | None

    @property
    def name(self) -> str:
        return self.rule.name or self.rule.id

    def applies_to(self, service_id: str) -> bool:
        return not self.rule.services or service_id in self.rule.services

    def matches(self, text: str, level: str | None) -> bool:
        if self.rule.levels and level not in self.rule.levels:
            return False
        if self.pattern is not None and not self.pattern.search(text):
            return False
        return self.exclude is None or not self.exclude.search(text)


def compile_rules(app: App) -> list[CompiledRule]:
    return [
        CompiledRule(
            r,
            re.compile(r.pattern) if r.pattern else None,
            re.compile(r.exclude) if r.exclude else None,
        )
        for r in app.effective_error_rules
    ]


def first_match(rules: list[CompiledRule], text: str, level: str | None) -> CompiledRule | None:
    return next((r for r in rules if r.matches(text, level)), None)


@dataclass(frozen=True)
class Cursor:
    path: str
    inode: int
    offset: int


@dataclass(frozen=True)
class ScannedLine:
    file_name: str
    offset: int
    text: str


@dataclass(frozen=True)
class Scan:
    cursor: Cursor
    lines: list[ScannedLine]


def _read_range(f, start: int, end: int) -> tuple[bytes, int]:
    """[start, end) を最大 MAX_READ_BYTES 読む。上限で切れたら最後の完結行まで。"""
    f.seek(start)
    data = f.read(min(end - start, MAX_READ_BYTES))
    if start + len(data) < end:
        i = data.rfind(b"\n")
        if i >= 0:
            data = data[: i + 1]
    return data, start + len(data)


def _find_by_inode(path: Path, inode: int) -> Path | None:
    try:
        entries = list(os.scandir(path.parent))
    except OSError:
        return None
    for e in entries:
        if not is_generation(path.name, e.name):
            continue
        try:
            st = e.stat(follow_symlinks=False)
        except OSError:
            continue
        if st.st_ino == inode:
            return Path(e.path)
    return None


def _lines(name: str, base: int, data: bytes) -> list[ScannedLine]:
    return [ScannedLine(name, off, decode_line(raw)) for off, raw in split_lines(base, data)]


def scan(path: Path, prev: Cursor | None, now: float | None = None) -> Scan:
    """``prev`` 以降の完結した行を読む。ファイルが無い・読めない場合は OSError。"""
    now = now if now is not None else time.time()
    with open(path, "rb") as f:
        st = os.fstat(f.fileno())
        end = end_of_complete(f, st.st_size, st.st_mtime, now)
        if prev is None or prev.path != str(path):  # 初めて見るファイルは末尾から
            return Scan(Cursor(str(path), st.st_ino, end), [])
        lines: list[ScannedLine] = []
        start = prev.offset
        if st.st_ino != prev.inode:
            old = _find_by_inode(path, prev.inode)
            if old is not None:  # ローテーション前のファイルの残り（もう書き込まれない）
                try:
                    with open(old, "rb") as g:
                        size = os.fstat(g.fileno()).st_size
                        if size > prev.offset:
                            data, _ = _read_range(g, prev.offset, size)
                            lines.extend(_lines(old.name, prev.offset, data))
                except OSError:
                    logger.warning("ローテーション前のログを読めません: %s", old)
            start = 0
        elif st.st_size < prev.offset:
            start = 0
        if end <= start:
            return Scan(Cursor(str(path), st.st_ino, start), lines)
        data, consumed = _read_range(f, start, end)
        lines.extend(_lines(path.name, start, data))
        return Scan(Cursor(str(path), st.st_ino, consumed), lines)


def _targets(app: App) -> list[tuple[Service, list[CompiledRule], LevelOf]]:
    rules = compile_rules(app)
    out: list[tuple[Service, list[CompiledRule], LevelOf]] = []
    if not rules:
        return out
    for svc in app.services:
        applied = [r for r in rules if r.applies_to(svc.id)]
        if applied and svc.log_paths:
            out.append((svc, applied, level_detector(effective_log_format(app, svc))))
    return out


def detect_once(engine: Engine, registry: AppRegistry, now: float | None = None) -> int:
    """全対象を 1 回走査し、記録した件数を返す。1 ファイルの失敗で他を止めない。"""
    total = 0
    with Session(engine) as s:
        cursors = {(c.app_id, c.service_id, c.source): c for c in s.scalars(select(LogCursor))}
    for app in registry.apps:
        for svc, rules, level_of in _targets(app):
            for source in range(len(svc.log_paths)):
                key = (app.id, svc.id, source)
                row = cursors.get(key)
                prev = Cursor(row.path, row.inode, row.offset) if row else None
                try:
                    total += _scan_source(engine, app, svc, source, prev, rules, level_of, now)
                except OSError:
                    continue  # ファイルなし・読めない: 位置は保ったまま次回に再試行
                except Exception:
                    logger.exception("エラー検知に失敗: %s/%s[%d]", app.id, svc.id, source)
    return total


def _scan_source(
    engine: Engine,
    app: App,
    svc: Service,
    source: int,
    prev: Cursor | None,
    rules: list[CompiledRule],
    level_of: LevelOf,
    now: float | None,
) -> int:
    result = scan(source_path(app, svc, source), prev, now)
    detected_at = datetime.now(UTC)
    events: list[ErrorEvent] = []
    dropped = 0
    for ln in result.lines:
        level = level_of(ln.text)
        rule = first_match(rules, ln.text, level)
        if rule is None:
            continue
        if len(events) >= MAX_EVENTS_PER_SCAN:
            dropped += 1
            continue
        events.append(
            ErrorEvent(
                app_id=app.id,
                service_id=svc.id,
                rule_id=rule.rule.id,
                rule_name=rule.name,
                severity=rule.rule.severity,
                level=level,
                source=source,
                file_name=ln.file_name,
                offset=ln.offset,
                line=ln.text[:LINE_LIMIT],
                detected_at=detected_at,
            )
        )
    if dropped:
        logger.warning(
            "エラー検知: %s/%s で一致が多すぎるため %d 件を記録しませんでした",
            app.id,
            svc.id,
            dropped,
        )
    with Session(engine) as s:
        row = s.get(LogCursor, (app.id, svc.id, source))
        if row is None:
            row = LogCursor(app_id=app.id, service_id=svc.id, source=source)
            s.add(row)
        row.path = result.cursor.path
        row.inode = result.cursor.inode
        row.offset = result.cursor.offset
        row.updated_at = detected_at
        s.add_all(events)
        s.commit()
    return len(events)


def purge_old(engine: Engine, retention_days: int, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(UTC)) - timedelta(days=retention_days)
    with Session(engine) as s:
        n = s.execute(delete(ErrorEvent).where(ErrorEvent.detected_at < cutoff)).rowcount
        s.commit()
    return n or 0


class ErrorDetector:
    def __init__(self, engine: Engine, holder: RegistryHolder, interval: int, retention_days: int):
        self._engine = engine
        self._holder = holder
        self._interval = interval
        self._retention_days = retention_days
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
                logger.exception("エラー検知のループで想定外のエラー")
            await asyncio.sleep(self._interval)

    async def tick(self) -> None:
        now = time.monotonic()
        if now >= self._next_purge:
            self._next_purge = now + PURGE_INTERVAL
            try:
                n = await asyncio.to_thread(purge_old, self._engine, self._retention_days)
                if n:
                    logger.info("古いエラー検知結果を %d 件削除しました", n)
            except Exception:
                logger.exception("エラー検知結果の削除に失敗しました")
        # ファイルの読み取りと保存はイベントループを止めないようスレッドで行う
        await asyncio.to_thread(detect_once, self._engine, self._holder.registry)
