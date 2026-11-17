from pathlib import Path

from sqlalchemy import Engine, create_engine, event, text


def create_db_engine(path: str | Path) -> Engine:
    """SQLite エンジンを作る。

    - foreign_keys / busy_timeout は接続ごとの設定なので connect ごとに実行する。
    - journal_mode=WAL は DB ファイルに永続化されるため、作成時に一度だけ設定する。
      ``:memory:`` では WAL が無意味なので設定せず、親ディレクトリも作らない。
    """
    p = Path(path)
    is_memory = str(p) == ":memory:"
    if not is_memory:
        p.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{p}")

    @event.listens_for(engine, "connect")
    def _set_pragma(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    if not is_memory:
        with engine.connect() as conn:
            conn.execute(text("PRAGMA journal_mode=WAL"))

    return engine
