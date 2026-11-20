from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from thoth.api import apps, bulk, health, mode, process, service_health
from thoth.api.deps import get_config, get_engine, get_process_manager, get_registry_holder
from thoth.db.migrate import upgrade_db
from thoth.health.monitor import HealthMonitor

# backend は常に 127.0.0.1 に bind する（設定で変えられない）
BACKEND_HOST = "127.0.0.1"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """ヘルスチェックの常駐ループ（#12）。設定・DB が解決できない場合は起動しない。"""
    monitor = HealthMonitor(
        get_engine(),
        get_registry_holder(),
        get_process_manager(),
        get_config().health.retention_days,
    )
    monitor.start()
    try:
        yield
    finally:
        await monitor.stop()


app = FastAPI(title="thoth", lifespan=lifespan)
app.include_router(health.router)
app.include_router(service_health.router)
app.include_router(apps.router)
app.include_router(process.router)
app.include_router(bulk.router)
app.include_router(mode.router)


def run() -> None:
    cfg = get_config()  # 不正な設定は ConfigError で起動時に失敗
    get_registry_holder()  # 不正なアプリ定義は AppsConfigError で起動時に失敗
    engine = get_engine()
    upgrade_db(engine)
    uvicorn.run("thoth.main:app", host=BACKEND_HOST, port=cfg.backend.port)


if __name__ == "__main__":
    run()
