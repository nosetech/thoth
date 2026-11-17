import textwrap

import pytest
from fastapi.testclient import TestClient

from thoth.api.deps import get_registry_holder
from thoth.apps.loader import AppsConfigError, load_apps
from thoth.apps.registry import RegistryHolder
from thoth.config import ConfigError, parse_config
from thoth.main import app

CSRF = {"Origin": "http://127.0.0.1:3900", "X-Thoth-Request": "1"}


def write(path, body):
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


def valid_yaml(wd, extra=""):
    return f"""
    apps:
      - id: sample
        name: Sample
        workdir: {wd}
        env: {{SECRET: abc}}
        services:
          - id: backend
            kind: process
            start: [uv, run, app]
            port: 8000
            healthcheck: {{type: http, url: "http://127.0.0.1:8000/h"}}
          - id: job
            kind: scheduled
            launchd_label: com.example.job
            depends_on: [backend]
    {extra}
    """


def errors_of(path):
    with pytest.raises(AppsConfigError) as e:
        load_apps(path)
    return "\n".join(e.value.errors)


def test_load_valid(tmp_path):
    reg = load_apps(write(tmp_path / "apps.yaml", valid_yaml(tmp_path)))
    a = reg.get("sample")
    assert [s.id for s in a.services] == ["backend", "job"]
    assert list(a.modes) == ["local"]


def test_missing_file_is_empty(tmp_path):
    assert load_apps(tmp_path / "apps.yaml").apps == ()


def test_apps_d_merged_and_duplicate_id(tmp_path):
    write(tmp_path / "apps.yaml", valid_yaml(tmp_path))
    d = tmp_path / "apps.d"
    d.mkdir()
    write(
        d / "b.yaml",
        f"""
        apps:
          - id: other
            name: O
            workdir: {tmp_path}
            services: [{{id: s, kind: process, start: [x]}}]
        """,
    )
    assert {a.id for a in load_apps(tmp_path / "apps.yaml").apps} == {"sample", "other"}
    write(d / "c.yaml", valid_yaml(tmp_path))
    assert "重複" in errors_of(tmp_path / "apps.yaml")


@pytest.mark.parametrize(
    "mutate,msg",
    [
        ("            start: [uv, run, app]\n", "start"),  # コマンド欠落
        ("port: 8000", "port"),
    ],
)
def test_invalid_command_and_port(tmp_path, mutate, msg):
    body = valid_yaml(tmp_path)
    if msg == "start":
        body = body.replace(mutate, "")
    else:
        body = body.replace(mutate, "port: 70000")
    assert f"services[0].{msg}" in errors_of(write(tmp_path / "apps.yaml", body))


def test_empty_command_rejected(tmp_path):
    body = valid_yaml(tmp_path).replace("start: [uv, run, app]", "start: []")
    assert "services[0].start" in errors_of(write(tmp_path / "apps.yaml", body))


def test_unknown_key_rejected(tmp_path):
    body = valid_yaml(tmp_path).replace("name: Sample", "name: Sample\n        bogus: 1")
    assert "bogus" in errors_of(write(tmp_path / "apps.yaml", body))


def test_invalid_yaml_syntax(tmp_path):
    assert "YAML" in errors_of(write(tmp_path / "apps.yaml", "apps: [\n"))


def test_cloud_kind_rejected(tmp_path):
    body = valid_yaml(tmp_path).replace("kind: scheduled", "kind: cloud")
    assert errors_of(write(tmp_path / "apps.yaml", body))


def test_semantic_errors(tmp_path):
    body = f"""
    apps:
      - id: a
        name: A
        workdir: {tmp_path}/missing
        services:
          - {{id: s1, kind: process, start: [x], port: 9000, depends_on: [s2]}}
          - {{id: s2, kind: process, start: [x], port: 9000, depends_on: [s1]}}
          - {{id: s3, kind: process, start: [x], depends_on: [nope]}}
          - {{id: s3, kind: process, start: [x]}}
          - id: s4
            kind: process
            start: [x]
            healthcheck: {{type: http, url: "http://evil.example.com/"}}
    """
    out = errors_of(write(tmp_path / "apps.yaml", body))
    # ホスト限定は pydantic 段階で検出されるため、まず形式エラーのみ
    assert "url のホスト" in out
    body = body.replace('url: "http://evil.example.com/"', 'url: "http://localhost/"')
    out = errors_of(write(tmp_path / "apps.yaml", body))
    for expected in ["workdir", "重複", "循環", "存在しないサービス 'nope'"]:
        assert expected in out


def test_registry_reload_keeps_old_on_failure(tmp_path):
    p = write(tmp_path / "apps.yaml", valid_yaml(tmp_path))
    holder = RegistryHolder(p)
    p.write_text("apps: [{id: BAD}]", encoding="utf-8")
    with pytest.raises(AppsConfigError):
        holder.reload()
    assert holder.registry.get("sample") is not None
    write(p, valid_yaml(tmp_path).replace("id: sample", "id: renamed"))
    holder.reload()
    assert holder.registry.get("renamed") is not None


def test_apps_config_unknown_key():
    with pytest.raises(ConfigError):
        parse_config({"apps": {"bogus": 1}})
    assert parse_config({"apps": {"path": "x.yaml"}}).apps.path == "x.yaml"
    assert parse_config({}).apps.path is None


@pytest.fixture
def client(tmp_path):
    p = write(tmp_path / "apps.yaml", valid_yaml(tmp_path))
    holder = RegistryHolder(p)
    app.dependency_overrides[get_registry_holder] = lambda: holder
    yield TestClient(app, headers=CSRF), p
    app.dependency_overrides.clear()


def test_api_list_get_and_masking(client):
    c, _ = client
    res = c.get("/api/apps")
    assert res.status_code == 200
    body = res.json()
    assert body[0]["id"] == "sample"
    assert [s["id"] for s in body[0]["services"]] == ["backend", "job"]
    assert body[0]["env_keys"] == ["SECRET"]
    assert "abc" not in res.text
    assert c.get("/api/apps/sample").json()["services"][0]["detail"]["port"] == 8000
    assert c.get("/api/apps/none").status_code == 404


def test_api_reload(client):
    c, p = client
    assert c.post("/api/config/reload").json() == {"status": "ok", "apps": 1}
    p.write_text("apps: [{bogus: 1}]", encoding="utf-8")
    res = c.post("/api/config/reload")
    assert res.status_code == 422
    assert res.json()["detail"]["errors"]
    assert c.get("/api/apps").json()[0]["id"] == "sample"


def test_reload_requires_same_origin_and_header(client):
    c, _ = client
    bare = TestClient(app)
    assert bare.post("/api/config/reload").status_code == 403
    assert bare.post("/api/config/reload", headers={"X-Thoth-Request": "1"}).status_code == 403
    evil = {"Origin": "http://evil.example.com", "X-Thoth-Request": "1"}
    assert bare.post("/api/config/reload", headers=evil).status_code == 403
    ok = {"Referer": "http://localhost:3900/x", "X-Thoth-Request": "1"}
    assert bare.post("/api/config/reload", headers=ok).status_code == 200


def test_explicit_path_missing_is_error(tmp_path):
    with pytest.raises(AppsConfigError):
        RegistryHolder(tmp_path / "nope.yaml", required=True)
    assert RegistryHolder(tmp_path / "nope.yaml").registry.apps == ()


def test_example_file_is_valid(tmp_path):
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2] / "config" / "apps.yaml.example").read_text()
    (tmp_path / "svc").mkdir()
    src = src.replace("~/repo/sample-app", str(tmp_path)).replace(
        "workdir: backend", "workdir: svc"
    )
    assert load_apps(write(tmp_path / "apps.yaml", src)).get("sample-app")
