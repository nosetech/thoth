from datetime import UTC, datetime

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.orm import Session

from thoth.db.base import Base
from thoth.db.migrate import upgrade_db
from thoth.db.models import SchemaInfo
from thoth.db.session import create_db_engine


@pytest.fixture
def engine(tmp_path):
    e = create_db_engine(tmp_path / "t.db")
    upgrade_db(e)
    yield e
    e.dispose()


def test_pragmas(engine):
    with engine.connect() as c:
        assert c.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert c.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert c.execute(text("PRAGMA busy_timeout")).scalar() == 5000


def test_migration_matches_models(engine):
    with engine.connect() as c:
        diff = compare_metadata(MigrationContext.configure(c), Base.metadata)
    assert diff == []


def test_utc_roundtrip(engine):
    now = datetime.now(UTC)
    with Session(engine) as s:
        s.add(SchemaInfo(id=1, note="x", created_at=now))
        s.commit()
        row = s.get(SchemaInfo, 1)
        assert row.created_at == now


def test_naive_datetime_rejected(engine):
    with Session(engine) as s:
        s.add(SchemaInfo(id=1, note="x", created_at=datetime(2026, 1, 1)))
        with pytest.raises(Exception, match="naive"):
            s.commit()
