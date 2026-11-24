"""ログ閲覧 API（設計: docs/architecture.md「ログ閲覧（#15）」）。

読めるのはアプリ定義の ``log_paths`` とその世代ファイルだけ。受け取るのは
app_id / service_id / source（log_paths の添字）/ name（ファイル名のみ）で、パスは受け取らない。
参照専用（副作用なし）のため CSRF 検査は不要。
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from thoth.api.deps import get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.logreader.reader import (
    LEVELS,
    Level,
    LogError,
    list_files,
    read_after,
    read_tail,
    resolve_file,
    source_path,
)

router = APIRouter(prefix="/api/logs", tags=["logs"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
_STATUS = {"not_found": 404, "missing": 404, "denied": 403}


class LogFileOut(BaseModel):
    source: int
    name: str
    is_current: bool
    size: int | None
    modified_at: datetime | None
    exists: bool


class LogServiceOut(BaseModel):
    app_id: str
    app_name: str
    service_id: str
    service_name: str
    files: list[LogFileOut]


class LogLineOut(BaseModel):
    offset: int
    text: str
    level: Level | None


class LogReadOut(BaseModel):
    lines: list[LogLineOut]
    start_offset: int
    end_offset: int
    size: int
    inode: int
    has_more_before: bool
    rotated: bool
    scan_limited: bool


def _raise(e: LogError):
    raise HTTPException(status_code=_STATUS.get(e.kind, 500), detail=str(e)) from None


def _parse_levels(levels: str | None) -> frozenset[str] | None:
    if not levels:
        return None
    wanted = {v for v in levels.split(",") if v}
    if not wanted <= set(LEVELS):
        raise HTTPException(status_code=422, detail="invalid levels")
    return frozenset(wanted)


@router.get("")
def list_logs(holder: HolderDep) -> list[LogServiceOut]:
    """全サービスのログファイル一覧（log_paths 未設定のサービスは files が空）。"""
    out: list[LogServiceOut] = []
    for app in holder.registry.apps:
        for svc in app.services:
            files = [LogFileOut(**vars(f)) for f in list_files(app, svc)]
            out.append(
                LogServiceOut(
                    app_id=app.id,
                    app_name=app.name,
                    service_id=svc.id,
                    service_name=svc.name or svc.id,
                    files=files,
                )
            )
    return out


@router.get("/read")
def read_log(
    holder: HolderDep,
    app_id: str,
    service_id: str,
    source: Annotated[int, Query(ge=0)] = 0,
    name: str | None = None,
    lines: Annotated[int, Query(ge=1, le=1000)] = 200,
    before: Annotated[int | None, Query(ge=0)] = None,
    after: Annotated[int | None, Query(ge=0)] = None,
    inode: int | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    levels: str | None = None,
) -> LogReadOut:
    """末尾 N 行（既定）/ ``before`` の直前 N 行 / ``after`` 以降の追記分（追従）を返す。

    ``after`` と ``inode`` を渡すと、ローテーション（inode 変化・縮小）を検知して
    ``rotated: true`` とともに新しいファイルの末尾から返す。
    """
    app = holder.registry.get(app_id)
    svc = next((s for s in app.services if s.id == service_id), None) if app else None
    if app is None or svc is None:
        raise HTTPException(status_code=404, detail="service not found")
    if before is not None and after is not None:
        raise HTTPException(status_code=422, detail="before と after は同時に指定できません")
    wanted = _parse_levels(levels)
    query = q or None
    try:
        path = resolve_file(app, svc, source, name or source_path(app, svc, source).name)
        if after is not None:
            chunk = read_after(path, after, inode, lines, query=query, levels=wanted)
        else:
            chunk = read_tail(path, lines, before=before, query=query, levels=wanted)
    except LogError as e:
        _raise(e)
    return LogReadOut(
        lines=[LogLineOut(offset=ln.offset, text=ln.text, level=ln.level) for ln in chunk.lines],
        start_offset=chunk.start_offset,
        end_offset=chunk.end_offset,
        size=chunk.size,
        inode=chunk.inode,
        has_more_before=chunk.start_offset > 0 and after is None,
        rotated=chunk.rotated,
        scan_limited=chunk.scan_limited,
    )
