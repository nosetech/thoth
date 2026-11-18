"""アプリ定義 YAML の読み込みと検証。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from thoth.apps.schema import App, AppsFile, ProcessService


class AppsConfigError(Exception):
    """アプリ定義が不正な場合のエラー。errors に全エラーを持つ。"""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("\n".join(errors))


@dataclass(frozen=True)
class AppRegistry:
    apps: tuple[App, ...] = ()

    def get(self, app_id: str) -> App | None:
        return next((a for a in self.apps if a.id == app_id), None)


def _fmt_loc(loc: tuple[Any, ...], prefix: str) -> str:
    out = prefix
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else f".{part}" if out else str(part)
    return out


def _parse_file(path: Path) -> tuple[list[App], list[str]]:
    name = path.name
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (yaml.YAMLError, UnicodeDecodeError) as e:
        return [], [f"{name}: YAML の解析に失敗しました: {e}"]
    if raw is None:
        raw = {}
    try:
        parsed = AppsFile.model_validate(raw)
    except ValidationError as e:
        errs = []
        for d in e.errors(include_url=False):
            loc = tuple(p for p in d["loc"])
            # discriminated union のタグ名（process/scheduled）は位置から除く
            loc = tuple(p for p in loc if p not in ("process", "scheduled"))
            errs.append(f"{name}: {_fmt_loc(loc, '')}: {d['msg']}")
        return [], errs
    return list(parsed.apps), []


def _resolve_dir(base: Path, value: str, app_workdir: Path | None = None) -> Path:
    p = Path(value).expanduser()
    if p.is_absolute():
        return p
    return (app_workdir or base) / p


def _validate_semantics(apps: list[App], sources: list[str]) -> list[str]:
    errs: list[str] = []
    seen_app: dict[str, int] = {}
    ports: dict[int, str] = {}
    for i, app in enumerate(apps):
        src = sources[i]
        base = f"{src}: apps[{i}]"
        if app.id in seen_app:
            errs.append(f"{base}.id: id '{app.id}' が重複しています")
        seen_app[app.id] = i
        wd = Path(app.workdir).expanduser()
        if not wd.is_absolute():
            errs.append(f"{base}.workdir: 絶対パス（~ 可）で指定してください")
        elif not wd.is_dir():
            errs.append(f"{base}.workdir: ディレクトリが存在しません: {wd}")
        ids = [s.id for s in app.services]
        for j, svc in enumerate(app.services):
            sp = f"{base}.services[{j}]"
            if ids.count(svc.id) > 1 and ids.index(svc.id) != j:
                errs.append(f"{sp}.id: id '{svc.id}' がアプリ内で重複しています")
            for dep in svc.depends_on:
                if dep not in ids:
                    errs.append(f"{sp}.depends_on: 存在しないサービス '{dep}' を参照しています")
                elif dep == svc.id:
                    errs.append(f"{sp}.depends_on: 自身を参照しています")
            if svc.workdir is not None and wd.is_absolute():
                swd = _resolve_dir(wd, svc.workdir, wd)
                if not swd.is_dir():
                    errs.append(f"{sp}.workdir: ディレクトリが存在しません: {swd}")
            if isinstance(svc, ProcessService) and svc.port is not None:
                owner = f"{app.id}/{svc.id}"
                if svc.port in ports:
                    errs.append(
                        f"{sp}.port: ポート {svc.port} が {ports[svc.port]} と重複しています"
                    )
                else:
                    ports[svc.port] = owner
        cycle = _find_cycle({s.id: list(s.depends_on) for s in app.services})
        if cycle:
            errs.append(f"{base}.services: depends_on が循環しています: {' -> '.join(cycle)}")
    return errs


def _find_cycle(graph: dict[str, list[str]]) -> list[str] | None:
    state: dict[str, int] = {}

    def visit(n: str, stack: list[str]) -> list[str] | None:
        state[n] = 1
        stack.append(n)
        for m in graph.get(n, []):
            if m not in graph:
                continue
            if state.get(m) == 1:
                return [*stack[stack.index(m) :], m]
            if state.get(m) is None and (c := visit(m, stack)):
                return c
        stack.pop()
        state[n] = 2
        return None

    for n in graph:
        if state.get(n) is None and (c := visit(n, [])):
            return c
    return None


def load_apps(path: str | Path, *, required: bool = False) -> AppRegistry:
    """``apps.yaml`` と同階層の ``apps.d/*.yaml``（辞書順）を読み込む。

    ファイルが無ければ空の定義。不正な場合は全エラーをまとめた AppsConfigError。
    """
    p = Path(path)
    files: list[Path] = []
    if required and not p.exists():
        raise AppsConfigError([f"{p}: アプリ定義ファイルが見つかりません"])
    if p.exists():
        if not p.is_file():
            raise AppsConfigError([f"{p}: ファイルではありません"])
        files.append(p)
    d = p.parent / "apps.d"
    if d.is_dir():
        files.extend(sorted(d.glob("*.yaml")))

    apps: list[App] = []
    sources: list[str] = []
    errors: list[str] = []
    for f in files:
        parsed, errs = _parse_file(f)
        errors.extend(errs)
        apps.extend(parsed)
        sources.extend([f.name] * len(parsed))
    if not errors:
        errors = _validate_semantics(apps, sources)
    if errors:
        raise AppsConfigError(errors)
    return AppRegistry(tuple(apps))
