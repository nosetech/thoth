"""起動コマンドと環境変数の組み立て（``${VAR}`` 展開は許可された変数のみ）。"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

from thoth.apps.schema import App, ProcessService

ALLOWED_THOTH_VARS = ("LAN_IP", "TAILSCALE_IP")
_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ProcessConfigError(Exception):
    """起動に必要な設定（モード・変数展開など）が解決できない場合のエラー。"""


def _expand(value: str, lookup: Mapping[str, str], what: str) -> str:
    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in lookup:
            raise ProcessConfigError(f"{what}: 未定義の変数 ${{{name}}} を参照しています")
        return lookup[name]

    return _VAR_RE.sub(repl, value)


def build_env(
    app: App, svc: ProcessService, mode: str, thoth_env: Mapping[str, str] | None = None
) -> tuple[dict[str, str], dict[str, str]]:
    """(子プロセスの環境変数, 定義済み env) を返す。

    thoth の LAN_IP / TAILSCALE_IP は選択中モードが参照した場合のみ子に渡す。
    定義済み env は argv の ``${VAR}`` 展開元になる。
    """
    src = os.environ if thoth_env is None else thoth_env
    if mode not in app.modes:
        raise ProcessConfigError(f"モード '{mode}' はアプリ '{app.id}' に定義されていません")
    raw = {**app.env, **svc.env, **app.modes[mode].env}
    # 展開元: thoth の許可リスト変数 + ``${`` を含まない（リテラルの）定義済み env
    lookup = {k: src[k] for k in ALLOWED_THOTH_VARS if k in src}
    lookup.update({k: v for k, v in raw.items() if "${" not in v})
    merged = {k: _expand(v, lookup, f"env.{k}") for k, v in raw.items()}
    if "LAN_IP" in merged and "TAILSCALE_IP" in merged:
        raise ProcessConfigError("LAN_IP と TAILSCALE_IP は同時に指定できません")
    child = {k: v for k, v in src.items() if k not in ALLOWED_THOTH_VARS}
    child.update(merged)
    return child, merged


def resolve_argv(argv: list[str], defined: Mapping[str, str], what: str) -> list[str]:
    """argv の ``${VAR}`` を定義済み env のみで展開する（シェルは経由しない）。"""
    return [_expand(a, defined, what) for a in argv]
