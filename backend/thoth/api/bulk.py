"""全登録アプリの一括起動・停止・再起動 API（設計: docs/architecture.md「一括操作（#7）」）。

受け取るのは操作種別と失敗時の挙動（`on_failure`）のみ。ボディは受け取らない。
アプリ単位の操作（`ProcessManager.*_app`）を順に呼び、結果をアプリごと・サービスごとに集約する。
"""

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from thoth.api.csrf import require_same_origin
from thoth.api.deps import get_process_manager, get_registry_holder
from thoth.api.process import Action, ServiceResultOut
from thoth.apps.registry import RegistryHolder
from thoth.apps.schema import App
from thoth.process.manager import ProcessManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bulk", tags=["bulk"])

HolderDep = Annotated[RegistryHolder, Depends(get_registry_holder)]
ManagerDep = Annotated[ProcessManager, Depends(get_process_manager)]
OnFailure = Literal["continue", "abort"]

_ABORTED = "先に失敗したアプリがあるため中断（未実行）"


class AppBulkResultOut(BaseModel):
    app_id: str
    # ok: 1 つ以上操作し失敗なし / error: 1 つでも失敗 / skipped: 操作したものなし・未実行
    status: Literal["ok", "error", "skipped"]
    message: str | None = None
    results: list[ServiceResultOut] = []


class BulkOut(BaseModel):
    action: str
    on_failure: OnFailure
    # ok: 失敗なし / partial: 成功と失敗が混在 / failed: 失敗のみ
    status: Literal["ok", "partial", "failed"]
    apps: list[AppBulkResultOut]


def _run_app(mgr: ProcessManager, app: App, action: Action) -> AppBulkResultOut:
    try:
        results = getattr(mgr, f"{action}_app")(app)
    except Exception:  # 1 アプリの想定外の失敗で一括操作全体を落とさない（詳細はログのみ）
        logger.exception("bulk %s failed for app %s", action, app.id)
        return AppBulkResultOut(
            app_id=app.id, status="error", message="想定外のエラーが発生しました"
        )
    out = [ServiceResultOut(**vars(r)) for r in results]
    if any(r.result == "error" for r in out):
        status = "error"
    elif any(r.result == "ok" for r in out):
        status = "ok"
    else:
        status = "skipped"
    return AppBulkResultOut(app_id=app.id, status=status, results=out)


@router.post("/{action}", dependencies=[Depends(require_same_origin)])
def bulk_action(
    action: Action,
    holder: HolderDep,
    mgr: ManagerDep,
    on_failure: Annotated[OnFailure, Query()] = "continue",
) -> BulkOut:
    """全アプリに操作する。常に 200 を返し、成否は `apps[].status` と `results` で判断する。"""
    apps = list(holder.registry.apps)
    if action == "stop":
        apps.reverse()  # 起動の逆順
    out: list[AppBulkResultOut] = []
    aborted = False
    for app in apps:
        if aborted:
            out.append(AppBulkResultOut(app_id=app.id, status="skipped", message=_ABORTED))
            continue
        r = _run_app(mgr, app, action)
        out.append(r)
        aborted = on_failure == "abort" and r.status == "error"
    failed = sum(r.status == "error" for r in out)
    succeeded = sum(r.status == "ok" for r in out)
    if not failed:
        status = "ok"
    elif succeeded or any(x.result == "ok" for r in out for x in r.results):
        status = "partial"
    else:
        status = "failed"
    return BulkOut(action=action, on_failure=on_failure, status=status, apps=out)
