import uvicorn
from fastapi import FastAPI

from thoth.api import apps, health
from thoth.api.deps import get_config, get_engine, get_registry_holder
from thoth.db.migrate import upgrade_db

# backend は常に 127.0.0.1 に bind する（設定で変えられない）
BACKEND_HOST = "127.0.0.1"

app = FastAPI(title="thoth")
app.include_router(health.router)
app.include_router(apps.router)


def run() -> None:
    cfg = get_config()  # 不正な設定は ConfigError で起動時に失敗
    get_registry_holder()  # 不正なアプリ定義は AppsConfigError で起動時に失敗
    engine = get_engine()
    upgrade_db(engine)
    uvicorn.run("thoth.main:app", host=BACKEND_HOST, port=cfg.backend.port)


if __name__ == "__main__":
    run()
