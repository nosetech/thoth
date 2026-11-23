"""自動再起動の状況 API（設計: docs/architecture.md「自動再起動（#13）」）。"""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from thoth.api.deps import get_engine, get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import ProcessService
from thoth.db.models import ServiceSupervision

router = APIRouter(prefix="/api/auto-restart", tags=["auto-restart"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
EngineDep = Annotated[Engine, Depends(get_engine)]


class AutoRestartOut(BaseModel):
    app_id: str
    service_id: str
    # watching: 監視中 / retrying: 再起動を試行中 / gave_up: 上限到達で停止 / idle: 稼働させない状態
    state: Literal["watching", "retrying", "gave_up", "idle"]
    attempts: int
    max_retries: int
    last_attempt_at: datetime | None = None
    next_attempt_at: datetime | None = None
    message: str | None = None


@router.get("")
def list_auto_restart(holder: HolderDep, engine: EngineDep) -> list[AutoRestartOut]:
    """``auto_restart`` を指定した process サービスの状況（上限到達の表示用）。"""
    out: list[AutoRestartOut] = []
    with Session(engine) as s:
        for app in holder.registry.apps:
            for svc in app.services:
                if not isinstance(svc, ProcessService) or svc.auto_restart is None:
                    continue
                r = s.get(ServiceSupervision, (app.id, svc.id))
                if r is None or not r.desired:
                    state = "idle"
                elif r.gave_up:
                    state = "gave_up"
                elif r.attempts > 0:
                    state = "retrying"
                else:
                    state = "watching"
                out.append(
                    AutoRestartOut(
                        app_id=app.id,
                        service_id=svc.id,
                        state=state,
                        attempts=r.attempts if r else 0,
                        max_retries=svc.auto_restart.max_retries,
                        last_attempt_at=r.last_attempt_at if r else None,
                        next_attempt_at=r.next_attempt_at if r and state == "retrying" else None,
                        message=r.last_message if r else None,
                    )
                )
    return out
