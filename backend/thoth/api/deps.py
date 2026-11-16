from collections.abc import Iterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from thoth.config import Config, load_config
from thoth.db.session import create_db_engine


@lru_cache
def get_config() -> Config:
    return load_config()


@lru_cache
def get_engine() -> Engine:
    cfg = get_config()
    return create_db_engine(cfg.resolve_path(cfg.db.path))


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
