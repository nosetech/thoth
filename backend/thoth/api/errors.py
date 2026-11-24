"""エラー検知 API（設計: docs/architecture.md「エラー検知（#16）」）。

- ``GET /api/errors``: 検知結果（新しい順）と、未確認の集計（フィルタに依らない全体）。
- ``GET /api/errors/rules``: アプリごとのルール・パーサ設定（YAML が正。画面は参照のみ）。
- ``POST /api/errors/ack``: 確認済みにする（CSRF 必須）。
"""

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.sql.elements import ColumnElement

from thoth.api.csrf import require_same_origin
from thoth.api.deps import SessionDep, get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import LogFormat
from thoth.db.models import ErrorEvent

router = APIRouter(prefix="/api/errors", tags=["errors"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
Severity = Literal["error", "warn"]


class ErrorEventOut(BaseModel):
    id: int
    app_id: str
    app_name: str
    service_id: str
    service_name: str
    rule_id: str
    rule_name: str
    severity: Severity
    level: str | None
    source: int
    file_name: str
    offset: int
    line: str
    detected_at: datetime
    acknowledged_at: datetime | None


class ServiceSummaryOut(BaseModel):
    app_id: str
    app_name: str
    service_id: str
    service_name: str
    unacknowledged: int
    error: int
    warn: int
    latest_at: datetime
    latest_line: str
    latest_severity: Severity


class ErrorSummaryOut(BaseModel):
    unacknowledged: int
    error: int
    warn: int
    last_detected_at: datetime | None
    services: list[ServiceSummaryOut]


class ErrorListOut(BaseModel):
    events: list[ErrorEventOut]
    total: int  # フィルタに一致する件数（events は limit 件まで）
    summary: ErrorSummaryOut


class RuleOut(BaseModel):
    id: str
    name: str
    severity: Severity
    levels: list[str]
    pattern: str | None
    exclude: str | None
    services: list[str]


class ParserOut(BaseModel):
    kind: Literal["auto", "regex"]
    origin: Literal["service", "app"] | None  # どこの log_format か（auto は None）
    level_pattern: str | None
    level_map: dict[str, str]


class RuleServiceOut(BaseModel):
    service_id: str
    service_name: str
    monitored: bool  # log_paths があり、いずれかのルールが適用される
    has_log_paths: bool
    parser: ParserOut


class AppRulesOut(BaseModel):
    app_id: str
    app_name: str
    mode: Literal["default", "custom", "disabled"]
    rules: list[RuleOut]
    services: list[RuleServiceOut]


class RulesOut(BaseModel):
    apps: list[AppRulesOut]
    monitored_services: int


class AckIn(BaseModel):
    ids: list[int] | None = Field(None, max_length=1000)
    # ids の代わりに、条件に一致する未確認をまとめて確認済みにする
    all: bool = False
    app_id: str | None = None
    service_id: str | None = None
    rule_id: str | None = None
    severity: Severity | None = None


class AckOut(BaseModel):
    acknowledged: int


def _names(holder: RegistryHolder) -> tuple[dict[str, str], dict[tuple[str, str], str]]:
    apps: dict[str, str] = {}
    services: dict[tuple[str, str], str] = {}
    for app in holder.registry.apps:
        apps[app.id] = app.name
        for svc in app.services:
            services[(app.id, svc.id)] = svc.name or svc.id
    return apps, services


def _filters(
    app_id: str | None,
    service_id: str | None,
    rule_id: str | None,
    severity: str | None,
) -> list[ColumnElement[bool]]:
    conds: list[ColumnElement[bool]] = []
    if app_id:
        conds.append(ErrorEvent.app_id == app_id)
    if service_id:
        conds.append(ErrorEvent.service_id == service_id)
    if rule_id:
        conds.append(ErrorEvent.rule_id == rule_id)
    if severity:
        conds.append(ErrorEvent.severity == severity)
    return conds


def _summary(session, holder: RegistryHolder) -> ErrorSummaryOut:
    apps, services = _names(holder)
    unacked = ErrorEvent.acknowledged_at.is_(None)
    rows = session.execute(
        select(ErrorEvent.app_id, ErrorEvent.service_id, ErrorEvent.severity, func.count())
        .where(unacked)
        .group_by(ErrorEvent.app_id, ErrorEvent.service_id, ErrorEvent.severity)
    ).all()
    counts: dict[tuple[str, str], dict[str, int]] = {}
    for app_id, service_id, severity, n in rows:
        counts.setdefault((app_id, service_id), {"error": 0, "warn": 0})[severity] = n
    out: list[ServiceSummaryOut] = []
    for (app_id, service_id), c in counts.items():
        latest = session.scalars(
            select(ErrorEvent)
            .where(unacked, ErrorEvent.app_id == app_id, ErrorEvent.service_id == service_id)
            .order_by(ErrorEvent.detected_at.desc(), ErrorEvent.id.desc())
            .limit(1)
        ).first()
        if latest is None:
            continue
        out.append(
            ServiceSummaryOut(
                app_id=app_id,
                app_name=apps.get(app_id, app_id),
                service_id=service_id,
                service_name=services.get((app_id, service_id), service_id),
                unacknowledged=c["error"] + c["warn"],
                error=c["error"],
                warn=c["warn"],
                latest_at=latest.detected_at,
                latest_line=latest.line[:300],
                latest_severity=latest.severity,  # type: ignore[arg-type]
            )
        )
    out.sort(key=lambda x: x.latest_at, reverse=True)
    last = session.scalar(select(func.max(ErrorEvent.detected_at)))
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    return ErrorSummaryOut(
        unacknowledged=sum(s.unacknowledged for s in out),
        error=sum(s.error for s in out),
        warn=sum(s.warn for s in out),
        last_detected_at=last,
        services=out,
    )


@router.get("")
def list_errors(
    session: SessionDep,
    holder: HolderDep,
    app_id: str | None = None,
    service_id: str | None = None,
    rule_id: str | None = None,
    severity: Severity | None = None,
    include_acknowledged: bool = False,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> ErrorListOut:
    apps, services = _names(holder)
    conds = _filters(app_id, service_id, rule_id, severity)
    if not include_acknowledged:
        conds.append(ErrorEvent.acknowledged_at.is_(None))
    total = session.scalar(select(func.count()).select_from(ErrorEvent).where(*conds)) or 0
    rows = session.scalars(
        select(ErrorEvent)
        .where(*conds)
        .order_by(ErrorEvent.detected_at.desc(), ErrorEvent.id.desc())
        .limit(limit)
    ).all()
    events = [
        ErrorEventOut(
            id=r.id,
            app_id=r.app_id,
            app_name=apps.get(r.app_id, r.app_id),
            service_id=r.service_id,
            service_name=services.get((r.app_id, r.service_id), r.service_id),
            rule_id=r.rule_id,
            rule_name=r.rule_name,
            severity=r.severity,  # type: ignore[arg-type]
            level=r.level,
            source=r.source,
            file_name=r.file_name,
            offset=r.offset,
            line=r.line,
            detected_at=r.detected_at,
            acknowledged_at=r.acknowledged_at,
        )
        for r in rows
    ]
    return ErrorListOut(events=events, total=total, summary=_summary(session, holder))


def _parser(fmt: LogFormat | None, origin: Literal["service", "app"]) -> ParserOut:
    if fmt is None:
        return ParserOut(kind="auto", origin=None, level_pattern=None, level_map={})
    return ParserOut(
        kind="regex",
        origin=origin,
        level_pattern=fmt.level_pattern,
        level_map=dict(fmt.level_map),
    )


@router.get("/rules")
def list_rules(holder: HolderDep) -> RulesOut:
    out: list[AppRulesOut] = []
    monitored_total = 0
    for app in holder.registry.apps:
        rules = app.effective_error_rules
        mode: Literal["default", "custom", "disabled"] = (
            "default" if app.error_rules is None else "custom" if rules else "disabled"
        )
        svcs: list[RuleServiceOut] = []
        for svc in app.services:
            applied = any(not r.services or svc.id in r.services for r in rules)
            monitored = bool(svc.log_paths) and applied
            monitored_total += monitored
            parser = (
                _parser(svc.log_format, "service")
                if svc.log_format
                else _parser(app.log_format, "app")
            )
            svcs.append(
                RuleServiceOut(
                    service_id=svc.id,
                    service_name=svc.name or svc.id,
                    monitored=monitored,
                    has_log_paths=bool(svc.log_paths),
                    parser=parser,
                )
            )
        out.append(
            AppRulesOut(
                app_id=app.id,
                app_name=app.name,
                mode=mode,
                rules=[
                    RuleOut(
                        id=r.id,
                        name=r.name or r.id,
                        severity=r.severity,
                        levels=list(r.levels),
                        pattern=r.pattern,
                        exclude=r.exclude,
                        services=list(r.services),
                    )
                    for r in rules
                ],
                services=svcs,
            )
        )
    return RulesOut(apps=out, monitored_services=monitored_total)


@router.post("/ack", dependencies=[Depends(require_same_origin)])
def acknowledge(body: AckIn, session: SessionDep) -> AckOut:
    if (body.ids is None) == (not body.all):
        raise HTTPException(status_code=422, detail="ids か all のどちらか一方を指定してください")
    conds = [ErrorEvent.acknowledged_at.is_(None)]
    if body.ids is not None:
        if not body.ids:
            return AckOut(acknowledged=0)
        conds.append(ErrorEvent.id.in_(body.ids))
    else:
        conds.extend(_filters(body.app_id, body.service_id, body.rule_id, body.severity))
    n = session.execute(
        update(ErrorEvent).where(*conds).values(acknowledged_at=datetime.now(UTC))
    ).rowcount
    session.commit()
    return AckOut(acknowledged=n or 0)
