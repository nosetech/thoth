"""読み込み済みアプリ定義の保持と原子的な差し替え。"""

from __future__ import annotations

import threading
from pathlib import Path

from thoth.apps.loader import AppRegistry, load_apps


class RegistryHolder:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()
        self._registry = load_apps(path)  # 不正なら AppsConfigError

    @property
    def registry(self) -> AppRegistry:
        return self._registry

    def reload(self) -> AppRegistry:
        """全体を検証し、成功時のみ差し替える。失敗時は AppsConfigError で旧定義を維持。"""
        new = load_apps(self._path)
        with self._lock:
            self._registry = new
        return new
