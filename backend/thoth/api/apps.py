from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from thoth.api.csrf import require_same_origin
from thoth.api.deps import get_registry_holder
from thoth.apps.loader import AppsConfigError
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App, ProcessService, Service

router = APIRouter(prefix="/api", tags=["apps"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]


class ServiceOut(BaseModel):
    id: str
    name: str
    kind: str
    workdir: str
    env_keys: list[str]
    log_paths: list[str]
    depends_on: list[str]
    detail: dict[str, Any]


class AppOut(BaseModel):
    id: str
    name: str
    description: str | None
    workdir: str
    env_keys: list[str]
    modes: list[str]
    services: list[ServiceOut]


def _service_out(app: App, s: Service) -> ServiceOut:
    base_wd = Path(app.workdir).expanduser()
    wd = base_wd / Path(s.workdir).expanduser() if s.workdir else base_wd  # 絶対パスはそのまま
    exclude = {"id", "name", "kind", "workdir", "env", "log_paths", "depends_on"}
    detail = s.model_dump(exclude=exclude, exclude_none=True)
    if isinstance(s, ProcessService):
        detail["start"] = list(s.start)
    return ServiceOut(
        id=s.id,
        name=s.name or s.id,
        kind=s.kind,
        workdir=str(wd),
        env_keys=sorted(s.env),  # 値はマスクしキー名のみ返す
        log_paths=s.log_paths,
        depends_on=s.depends_on,
        detail=detail,
    )


def _app_out(app: App) -> AppOut:
    return AppOut(
        id=app.id,
        name=app.name,
        description=app.description,
        workdir=str(Path(app.workdir).expanduser()),
        env_keys=sorted(app.env),
        modes=list(app.modes),
        services=[_service_out(app, s) for s in app.services],
    )


@router.get("/apps")
def list_apps(holder: HolderDep) -> list[AppOut]:
    return [_app_out(a) for a in holder.registry.apps]


@router.get("/apps/{app_id}")
def get_app(app_id: str, holder: HolderDep) -> AppOut:
    app = holder.registry.get(app_id)
    if app is None:
        raise HTTPException(status_code=404, detail="app not found")
    return _app_out(app)


@router.post("/config/reload", dependencies=[Depends(require_same_origin)])
def reload_config(holder: HolderDep) -> dict[str, Any]:
    try:
        reg = holder.reload()
    except AppsConfigError as e:
        raise HTTPException(status_code=422, detail={"errors": e.errors}) from None
    return {"status": "ok", "apps": len(reg.apps)}
