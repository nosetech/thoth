"""アプリの起動モード（local / lan / vpn）の取得・切替 API
（設計: docs/architecture.md「起動モード」）。

モードは状態として DB（app_state）に保存する。受け取るのはモード名のみ。
"""

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from thoth.api.csrf import require_same_origin
from thoth.api.deps import SessionDep, get_process_manager, get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, ProcessService
from thoth.db.models import AppState
from thoth.process.env import ProcessConfigError, build_env
from thoth.process.manager import ProcessManager

router = APIRouter(prefix="/api", tags=["mode"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
ManagerDep = Annotated[ProcessManager, Depends(get_process_manager)]
ModeName = Literal["local", "lan", "vpn"]


class ModeOption(BaseModel):
    name: str
    available: bool
    reason: str | None = None


class ModeOut(BaseModel):
    mode: str
    modes: list[ModeOption]


class ModeIn(BaseModel):
    mode: ModeName


def _find(holder: RegistryHolder, app_id: str) -> App:
    app = holder.registry.get(app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="app not found")
    return app


def _unavailable_reason(app: App, mode: str) -> str | None:
    """そのモードで起動できない理由（変数未設定・排他違反など）。選択可能なら None。"""
    for svc in app.services:
        if isinstance(svc, ProcessService):
            try:
                build_env(app, svc, mode)
            except ProcessConfigError as e:
                return str(e)
    return None


def _current(session: Session, app: App) -> str:
    row = session.get(AppState, app.id)
    return row.mode if row is not None and row.mode in app.modes else "local"


def _out(session: Session, app: App) -> ModeOut:
    opts = []
    for name in app.modes:
        reason = _unavailable_reason(app, name)
        opts.append(ModeOption(name=name, available=reason is None, reason=reason))
    return ModeOut(mode=_current(session, app), modes=opts)


@router.get("/apps/{app_id}/mode")
def get_mode(app_id: str, holder: HolderDep, session: SessionDep) -> ModeOut:
    return _out(session, _find(holder, app_id))


@router.put("/apps/{app_id}/mode", dependencies=[Depends(require_same_origin)])
def set_mode(
    app_id: str, body: ModeIn, holder: HolderDep, mgr: ManagerDep, session: SessionDep
) -> ModeOut:
    app = _find(holder, app_id)
    if body.mode not in app.modes:
        raise HTTPException(status_code=422, detail=f"モード '{body.mode}' は定義されていません")
    reason = _unavailable_reason(app, body.mode)
    if reason is not None:
        raise HTTPException(status_code=422, detail=reason)
    if body.mode != _current(session, app):
        if any(isinstance(s, ProcessService) and mgr.status(app, s).running for s in app.services):
            raise HTTPException(
                status_code=409, detail="起動中のサービスがあります。停止してから切り替えてください"
            )
        session.merge(AppState(app_id=app.id, mode=body.mode, updated_at=datetime.now(UTC)))
        session.commit()
    return _out(session, app)
