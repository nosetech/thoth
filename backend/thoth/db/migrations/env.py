from alembic import context

from thoth.db import models  # noqa: F401  (モデル登録)
from thoth.db.base import Base

target_metadata = Base.metadata


def run_migrations_online() -> None:
    engine = context.config.attributes["engine"]
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
