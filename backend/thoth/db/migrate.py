from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import Engine

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def upgrade_db(engine: Engine) -> None:
    """最新リビジョンまで自動マイグレーションする。"""
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.attributes["engine"] = engine
    command.upgrade(cfg, "head")
