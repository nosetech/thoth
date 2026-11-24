"""ログファイルの列挙と読み取り（設計: docs/architecture.md「ログ閲覧（#15）」）。

- 読めるのはサービスの ``log_paths`` と、その世代ファイル（``<ログ名>.<サフィックス>`` /
  ``<ログ名>-<サフィックス>`` / ``<ログ名>_<サフィックス>``。圧縮済みは除く）だけ。
  クライアントは ``source``（log_paths の添字）と ``name``（ファイル名のみ）を渡し、パスは渡せない。
- 読み取りはバイトオフセット基準。巨大ファイルは末尾から必要な分だけ読み、全体は読まない。
- ローテーション（inode の変化・ファイルの縮小）は ``after`` 読み取りで検知して先頭から読み直す。
"""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from thoth.apps.schema import App, Service

Level = Literal["error", "warn", "info", "debug"]
LEVELS: tuple[Level, ...] = ("error", "warn", "info", "debug")

MAX_GENERATIONS = 50
CHUNK_BYTES = 64 * 1024
MAX_SCAN_BYTES = 16 * 1024 * 1024  # 1 回の読み取りで走査する上限（絞り込み時の巨大ファイル対策）
MAX_FOLLOW_BYTES = 1024 * 1024  # after 読み取りで 1 回に読む上限
MAX_LINE_CHARS = 8192
MAX_LINES = 1000
SETTLE_SECONDS = 5  # 末尾が改行で終わらない行は、この秒数更新が無ければ完結した行とみなす
_COMPRESSED = (".gz", ".bz2", ".xz", ".zip", ".zst")
_LEVEL_RE = re.compile(
    r"\b(CRITICAL|FATAL|ERROR|ERR|WARNING|WARN|INFO|DEBUG|TRACE)\b", re.IGNORECASE
)
_LEVEL_MAP: dict[str, Level] = {
    "critical": "error",
    "fatal": "error",
    "error": "error",
    "err": "error",
    "warning": "warn",
    "warn": "warn",
    "info": "info",
    "debug": "debug",
    "trace": "debug",
}


class LogError(Exception):
    """kind: not_found（対象なし）/ missing（ファイルなし）/ denied（読めない）。"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class LogFile:
    source: int
    name: str
    is_current: bool  # log_paths に指定された本体（世代ファイルでない）
    size: int | None
    modified_at: datetime | None
    exists: bool


@dataclass(frozen=True)
class LogLine:
    offset: int
    text: str
    level: Level | None


@dataclass
class LogChunk:
    lines: list[LogLine] = field(default_factory=list)
    start_offset: int = 0  # 返した範囲の先頭（これより前がまだある: start_offset > 0）
    end_offset: int = 0  # 次の after 読み取りの起点
    size: int = 0
    inode: int = 0
    rotated: bool = False
    scan_limited: bool = False  # 走査上限に達し、絞り込み結果が全体を網羅していない


def service_dir(app: App, svc: Service) -> Path:
    base = Path(app.workdir).expanduser()
    return base / Path(svc.workdir).expanduser() if svc.workdir else base


def source_path(app: App, svc: Service, source: int) -> Path:
    if not 0 <= source < len(svc.log_paths):
        raise LogError("not_found", "log source not found")
    return service_dir(app, svc) / Path(svc.log_paths[source]).expanduser()


def _is_generation(base: str, name: str) -> bool:
    if name == base or not name.startswith(base) or name.endswith(_COMPRESSED):
        return False
    return name[len(base)] in ".-_" and len(name) > len(base) + 1


def list_files(app: App, svc: Service) -> list[LogFile]:
    """log_paths ごとに、本体と世代ファイル（更新が新しい順）を返す。"""
    out: list[LogFile] = []
    for i in range(len(svc.log_paths)):
        path = source_path(app, svc, i)
        found: list[tuple[float, LogFile]] = []
        try:
            entries = list(os.scandir(path.parent))
        except OSError:
            entries = []
        for e in entries:
            if not _is_generation(path.name, e.name):
                continue
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            found.append(
                (
                    st.st_mtime,
                    LogFile(
                        i, e.name, False, st.st_size, datetime.fromtimestamp(st.st_mtime, UTC), True
                    ),
                )
            )
        found.sort(key=lambda t: (-t[0], t[1].name))
        try:
            st = path.stat()
            current = LogFile(
                i, path.name, True, st.st_size, datetime.fromtimestamp(st.st_mtime, UTC), True
            )
        except OSError:
            current = LogFile(i, path.name, True, None, None, False)
        out.append(current)
        out.extend(f for _, f in found[:MAX_GENERATIONS])
    return out


def resolve_file(app: App, svc: Service, source: int, name: str) -> Path:
    """``source`` / ``name`` を実ファイルのパスにする。log_paths 外のファイルは許可しない。"""
    base = source_path(app, svc, source)
    if Path(name).name != name or name in ("", ".", ".."):
        raise LogError("not_found", "log file not found")
    if name == base.name:
        return base
    if not _is_generation(base.name, name):
        raise LogError("not_found", "log file not found")
    path = base.parent / name
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise LogError("not_found", "log file not found")
    except OSError:
        raise LogError("missing", "log file not found") from None
    return path


def detect_level(text: str) -> Level | None:
    m = _LEVEL_RE.search(text)
    return _LEVEL_MAP[m.group(1).lower()] if m else None


def _make_line(offset: int, raw: bytes) -> LogLine:
    text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
    if len(text) > MAX_LINE_CHARS:
        text = text[:MAX_LINE_CHARS] + " …"
    return LogLine(offset, text, detect_level(text))


def _matches(line: LogLine, query: str | None, levels: frozenset[str] | None) -> bool:
    if levels is not None and line.level not in levels:
        return False
    return not query or query.lower() in line.text.lower()


def _open(path: Path):
    try:
        f = open(path, "rb")  # noqa: SIM115 - 呼び出し側で with 管理
    except FileNotFoundError:
        raise LogError("missing", "log file not found") from None
    except OSError:
        raise LogError("denied", "log file cannot be read") from None
    return f


def _end_of_complete(f, size: int, mtime: float, now: float) -> int:
    """完結した行の終端オフセット。末尾の未完行は、更新が止まっていれば含める。"""
    if size == 0:
        return 0
    f.seek(size - 1)
    if f.read(1) == b"\n" or now - mtime >= SETTLE_SECONDS:
        return size
    pos = size
    while pos > 0:
        start = max(0, pos - CHUNK_BYTES)
        f.seek(start)
        buf = f.read(pos - start)
        i = buf.rfind(b"\n")
        if i >= 0:
            return start + i + 1
        pos = start
    return 0


def _split_lines(base: int, data: bytes) -> list[tuple[int, bytes]]:
    """``base`` から始まる完結した行の並び（末尾が改行で終わるなら空要素は作らない）。"""
    parts = data.split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    out: list[tuple[int, bytes]] = []
    off = base
    for raw in parts:
        out.append((off, raw))
        off += len(raw) + 1
    return out


def read_tail(
    path: Path,
    lines: int,
    *,
    before: int | None = None,
    query: str | None = None,
    levels: frozenset[str] | None = None,
    now: float | None = None,
) -> LogChunk:
    """末尾（``before`` 指定時はその直前）から最大 ``lines`` 行を、ファイル全体を読まずに返す。"""
    lines = max(1, min(lines, MAX_LINES))
    now = now if now is not None else datetime.now(UTC).timestamp()
    with _open(path) as f:
        st = os.fstat(f.fileno())
        end = _end_of_complete(f, st.st_size, st.st_mtime, now)
        tail_end = end
        if before is not None:
            end = max(0, min(before, end))
        chunk = LogChunk(size=st.st_size, inode=st.st_ino, end_offset=tail_end)
        result: list[LogLine] = []
        pos = end
        buf = b""  # [pos, 未処理の先頭) の、先頭が行の途中かもしれない部分
        frontier = end  # ここより後ろは走査済み
        scanned = 0
        while pos > 0 and len(result) < lines:
            if scanned >= MAX_SCAN_BYTES:
                chunk.scan_limited = True
                break
            start = max(0, pos - CHUNK_BYTES)
            f.seek(start)
            buf = f.read(pos - start) + buf
            scanned += pos - start
            pos = start
            if start > 0:
                idx = buf.find(b"\n")
                if idx < 0:
                    continue
                body_base, body, buf = start + idx + 1, buf[idx + 1 :], buf[: idx + 1]
            else:
                body_base, body, buf = 0, buf, b""
            raws = _split_lines(body_base, body)
            if raws:
                frontier = raws[0][0]
            matched = [
                ln for off, raw in raws if _matches(ln := _make_line(off, raw), query, levels)
            ]
            result = (matched + result)[-lines:]
        chunk.lines = result
        if len(result) >= lines:
            chunk.start_offset = result[0].offset
        elif pos == 0 and not chunk.scan_limited:
            chunk.start_offset = 0
        else:
            chunk.start_offset = frontier
    return chunk


def read_after(
    path: Path,
    offset: int,
    inode: int | None,
    lines: int,
    *,
    query: str | None = None,
    levels: frozenset[str] | None = None,
    now: float | None = None,
) -> LogChunk:
    """``offset`` 以降に追記された行を返す（追従用）。

    inode が変わった・ファイルが ``offset`` より小さくなった場合はローテーションとみなし、
    新しいファイルの末尾から読み直して ``rotated`` を立てる。
    """
    lines = max(1, min(lines, MAX_LINES))
    now = now if now is not None else datetime.now(UTC).timestamp()
    with _open(path) as f:
        st = os.fstat(f.fileno())
        if (inode is not None and st.st_ino != inode) or st.st_size < offset:
            chunk = read_tail(path, lines, query=query, levels=levels, now=now)
            chunk.rotated = True
            return chunk
        end = _end_of_complete(f, st.st_size, st.st_mtime, now)
        chunk = LogChunk(start_offset=offset, end_offset=offset, size=st.st_size, inode=st.st_ino)
        if end <= offset:
            return chunk
        f.seek(offset)
        data = f.read(min(end - offset, MAX_FOLLOW_BYTES))
        if offset + len(data) < end:  # 上限で切れた: 最後の完結行までにする
            i = data.rfind(b"\n")
            if i >= 0:
                data = data[: i + 1]
        raws = _split_lines(offset, data)[:lines]
        consumed = offset
        out: list[LogLine] = []
        for off, raw in raws:
            consumed = off + len(raw) + 1
            line = _make_line(off, raw)
            if _matches(line, query, levels):
                out.append(line)
        chunk.lines = out
        chunk.end_offset = min(consumed, st.st_size)
        return chunk
