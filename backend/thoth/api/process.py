"""サービスの起動・停止・再起動 API（設計: docs/architecture.md「プロセス制御（#5）」）。

受け取るのは app_id / service_id と操作種別のみ。
コマンド・環境変数・作業ディレクトリは受け取らない。
"""

from typing import Annotated, Literal, NoReturn

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from thoth.api.csrf import require_same_origin
from thoth.api.deps import get_process_manager, get_registry_holder
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, ProcessService, Service
from thoth.process.manager import ProcessError, ProcessManager, ServiceResult

router = APIRouter(prefix="/api", tags=["process"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
ManagerDep = Annotated[ProcessManager, Depends(get_process_manager)]
Action = Literal["start", "stop", "restart"]

_STATUS = {"conflict": 409, "unsupported": 400, "config": 422, "failed": 500}


class ServiceStatusOut(BaseModel):
    service_id: str
    kind: str
    state: Literal["running", "stopped", "unsupported"]
    pid: int | None = None
    source: str | None = None
    busy: str | None = None


class ServiceActionOut(BaseModel):
    status: Literal["ok"] = "ok"
    message: str | None = None


class ServiceResultOut(BaseModel):
    service_id: str
    action: str
    result: Literal["ok", "skipped", "error"]
    message: str | None = None


class AppActionOut(BaseModel):
    status: Literal["ok"] = "ok"
    results: list[ServiceResultOut]


def _raise(e: ProcessError) -> NoReturn:
    raise HTTPException(status_code=_STATUS.get(e.kind, 500), detail=str(e)) from None


def _find(holder: RegistryHolder, app_id: str, service_id: str | None = None):
    app = holder.registry.get(app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="app not found")
    if service_id is None:
        return app, None
    svc = next((s for s in app.services if s.id == service_id), None)
    if svc is None:
        raise HTTPException(status_code=404, detail="service not found")
    return app, svc


def _status_out(mgr: ProcessManager, app: App, svc: Service) -> ServiceStatusOut:
    if not isinstance(svc, ProcessService):
        return ServiceStatusOut(service_id=svc.id, kind=svc.kind, state="unsupported")
    st = mgr.status(app, svc)
    return ServiceStatusOut(
        service_id=svc.id,
        kind=svc.kind,
        state="running" if st.running else "stopped",
        pid=st.pid,
        source=st.source,
        busy=st.busy,
    )


@router.get("/apps/{app_id}/status")
def app_status(app_id: str, holder: HolderDep, mgr: ManagerDep) -> list[ServiceStatusOut]:
    app, _ = _find(holder, app_id)
    return [_status_out(mgr, app, s) for s in app.services]


@router.get("/apps/{app_id}/services/{service_id}/status")
def service_status(
    app_id: str, service_id: str, holder: HolderDep, mgr: ManagerDep
) -> ServiceStatusOut:
    app, svc = _find(holder, app_id, service_id)
    return _status_out(mgr, app, svc)


@router.post(
    "/apps/{app_id}/services/{service_id}/{action}",
    dependencies=[Depends(require_same_origin)],
)
def service_action(
    app_id: str, service_id: str, action: Action, holder: HolderDep, mgr: ManagerDep
) -> ServiceActionOut:
    app, svc = _find(holder, app_id, service_id)
    try:
        message = getattr(mgr, action)(app, svc)
    except ProcessError as e:
        _raise(e)
    return ServiceActionOut(message=message)


@router.post("/apps/{app_id}/{action}", dependencies=[Depends(require_same_origin)])
def app_action(app_id: str, action: Action, holder: HolderDep, mgr: ManagerDep) -> AppActionOut:
    app, _ = _find(holder, app_id)
    results: list[ServiceResult] = getattr(mgr, f"{action}_app")(app)
    out = [ServiceResultOut(**vars(r)) for r in results]
    errors = [r for r in out if r.result == "error"]
    if errors:
        raise HTTPException(status_code=500, detail={"results": [r.model_dump() for r in out]})
    # 何も操作できなかった（起動なら全サービスが起動中、停止なら全サービスが停止中）場合は競合エラー
    if action in ("start", "stop") and out and all(r.result == "skipped" for r in out):
        raise HTTPException(status_code=409, detail={"results": [r.model_dump() for r in out]})
    return AppActionOut(results=out)
