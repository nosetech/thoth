"""サービスの健全性（状態・履歴）API（設計: docs/architecture.md「定期実行（#12）」）。"""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import Engine

from thoth.api.deps import get_engine, get_process_manager, get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import ProcessService
from thoth.health.monitor import load_samples, service_health
from thoth.process.manager import ProcessManager

router = APIRouter(prefix="/api/service-health", tags=["service-health"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
ManagerDep = Annotated[ProcessManager, Depends(get_process_manager)]
EngineDep = Annotated[Engine, Depends(get_engine)]


class ServiceHealthOut(BaseModel):
    app_id: str
    service_id: str
    state: Literal["healthy", "unhealthy", "starting", "unknown"]
    message: str | None = None
    checked_at: datetime | None = None


class HealthSampleOut(BaseModel):
    ok: bool
    message: str | None
    checked_at: datetime


@router.get("")
def list_health(holder: HolderDep, mgr: ManagerDep, engine: EngineDep) -> list[ServiceHealthOut]:
    """全アプリの process サービスの状態（一覧表示用）。"""
    out: list[ServiceHealthOut] = []
    for app in holder.registry.apps:
        for svc in app.services:
            if isinstance(svc, ProcessService):
                h = service_health(engine, mgr, app, svc)
                out.append(ServiceHealthOut(app_id=app.id, **vars(h)))
    return out


@router.get("/{app_id}/{service_id}/history")
def history(
    app_id: str,
    service_id: str,
    holder: HolderDep,
    engine: EngineDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[HealthSampleOut]:
    app = holder.registry.get(app_id)
    svc = next((s for s in app.services if s.id == service_id), None) if app else None
    if svc is None or not isinstance(svc, ProcessService):
        raise HTTPException(status_code=404, detail="service not found")
    rows = load_samples(engine, app_id, service_id, limit)
    return [HealthSampleOut(ok=r.ok, message=r.message, checked_at=r.checked_at) for r in rows]
