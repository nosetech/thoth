"""読み込み済みアプリ定義の保持と原子的な差し替え。"""

from __future__ import annotations

import threading
from pathlib import Path

from thoth.apps.loader import AppRegistry, load_apps


class RegistryHolder:
    def __init__(self, path: Path, *, required: bool = False):
        self._path = path
        self._required = required
        self._lock = threading.Lock()
        self._registry = load_apps(path, required=required)  # 不正なら AppsConfigError

    @property
    def registry(self) -> AppRegistry:
        return self._registry

    def reload(self) -> AppRegistry:
        """全体を検証し、成功時のみ差し替える。失敗時は AppsConfigError で旧定義を維持。"""
        with self._lock:  # 読み込みもロック内で行い、並行 reload の順序を保証する
            new = load_apps(self._path, required=self._required)
            self._registry = new
        return new
