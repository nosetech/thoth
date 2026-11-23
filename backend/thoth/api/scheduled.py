"""launchd 定期ジョブの状態 API（設計: docs/architecture.md「定期ジョブ（#14）」）。"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from thoth.api.deps import get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import ScheduledService
from thoth.scheduled.status import ScheduledState, scheduled_status

router = APIRouter(prefix="/api/scheduled", tags=["scheduled"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]


class ScheduledOut(BaseModel):
    app_id: str
    service_id: str
    state: ScheduledState
    message: str
    schedule: str | None
    expected_interval: int | None
    last_run_at: datetime | None
    exit_code: int | None


@router.get("")
def list_scheduled(holder: HolderDep) -> list[ScheduledOut]:
    """全アプリの scheduled サービスの状態（一覧表示用。launchctl の参照のみで副作用なし）。"""
    out: list[ScheduledOut] = []
    for app in holder.registry.apps:
        for svc in app.services:
            if isinstance(svc, ScheduledService):
                st = scheduled_status(app, svc)
                out.append(ScheduledOut(app_id=app.id, **vars(st)))
    return out
