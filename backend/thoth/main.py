import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI

from thoth.api import (
    apps,
    auto_restart,
    bulk,
    errors,
    health,
    logs,
    mode,
    process,
    scheduled,
    service_health,
)
from thoth.api.deps import get_config, get_engine, get_process_manager, get_registry_holder
from thoth.db.migrate import upgrade_db
from thoth.errors.detector import ErrorDetector
from thoth.health.monitor import HealthMonitor
from thoth.notify import slack
from thoth.notify.notifier import Notifier
from thoth.process.supervisor import Supervisor

logger = logging.getLogger(__name__)

# backend は常に 127.0.0.1 に bind する（設定で変えられない）
BACKEND_HOST = "127.0.0.1"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """ヘルスチェック（#12）・自動再起動（#13）・エラー検知（#16）・Slack 通知（#17）の常駐ループ。

    設定・DB が不正なら起動しない。Slack の Webhook が未設定なら通知だけ無効にして起動する。
    """
    monitor = HealthMonitor(
        get_engine(),
        get_registry_holder(),
        get_process_manager(),
        get_config().health.retention_days,
    )
    supervisor = Supervisor(get_engine(), get_registry_holder(), get_process_manager())
    cfg = get_config()
    detector = ErrorDetector(
        get_engine(), get_registry_holder(), cfg.errors.interval, cfg.errors.retention_days
    )
    notifier = None
    url = slack.load_webhook_url()
    if url is None:
        logger.info("Slack の Webhook が未設定のため通知しません（%s）", slack.WEBHOOK_ENV)
    else:
        notifier = Notifier(
            get_engine(),
            get_registry_holder(),
            get_process_manager(),
            cfg.notify,
            url,
            cfg.instance,
        )
    monitor.start()
    supervisor.start()
    detector.start()
    if notifier is not None:
        notifier.start()
    try:
        yield
    finally:
        if notifier is not None:
            await notifier.stop()
        await detector.stop()
        await supervisor.stop()
        await monitor.stop()


app = FastAPI(title="thoth", lifespan=lifespan)
app.include_router(health.router)
app.include_router(service_health.router)
app.include_router(scheduled.router)
app.include_router(logs.router)
app.include_router(errors.router)
app.include_router(auto_restart.router)
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
