from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from thoth.api.deps import get_engine
from thoth.db.migrate import upgrade_db
from thoth.db.session import create_db_engine
from thoth.main import BACKEND_HOST, app


def test_health(tmp_path):
    engine = create_db_engine(tmp_path / "t.db")
    upgrade_db(engine)
    app.dependency_overrides[get_engine] = lambda: engine
    try:
        res = TestClient(app).get("/api/health")
        assert res.status_code == 200
        assert res.json() == {"status": "ok"}
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_health_returns_503_when_db_unavailable():
    class BrokenEngine:
        def connect(self):
            raise OperationalError("SELECT 1", {}, Exception("locked"))

    app.dependency_overrides[get_engine] = lambda: BrokenEngine()
    try:
        res = TestClient(app).get("/api/health")
        assert res.status_code == 503
        assert res.json() != {"status": "ok"}
    finally:
        app.dependency_overrides.clear()


def test_backend_binds_localhost_only():
    assert BACKEND_HOST == "127.0.0.1"
