from collections.abc import Iterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from thoth.apps.registry import RegistryHolder
from thoth.config import DEFAULT_APPS_PATH, Config, load_config
from thoth.db.session import create_db_engine


@lru_cache
def get_config() -> Config:
    return load_config()


@lru_cache
def get_engine() -> Engine:
    cfg = get_config()
    return create_db_engine(cfg.resolve_path(cfg.db.path))


@lru_cache
def get_registry_holder() -> RegistryHolder:
    cfg = get_config()
    explicit = cfg.apps.path is not None
    return RegistryHolder(cfg.resolve_path(cfg.apps.path or DEFAULT_APPS_PATH), required=explicit)


def get_session() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
