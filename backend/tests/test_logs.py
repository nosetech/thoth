import os

import pytest
from fastapi.testclient import TestClient

from thoth.api.deps import get_registry_holder
from thoth.apps.schema import App
from thoth.logreader import reader
from thoth.logreader.reader import (
    LogError,
    detect_level,
    list_files,
    read_after,
    read_tail,
    resolve_file,
)
from thoth.main import app as fastapi_app

OLD = 1_000_000.0  # 十分古い時刻（未完行も確定扱いになる）


def make_app(tmp_path, log_paths):
    svc = {"id": "svc", "kind": "process", "start": ["true"], "log_paths": log_paths}
    return App.model_validate({"id": "x", "name": "X", "workdir": str(tmp_path), "services": [svc]})


def write(path, lines, trailing=True):
    path.write_text("\n".join(lines) + ("\n" if trailing else ""))


def test_detect_level():
    assert detect_level("2026-01-01 ERROR boom") == "error"
    assert detect_level("[WARNING] x") == "warn"
    assert detect_level("level=info ok") == "info"
    assert detect_level("DEBUG trace") == "debug"
    assert detect_level("plain") is None
    assert detect_level("terrorism") is None  # 単語境界


def test_tail_returns_last_lines_with_offsets(tmp_path):
    p = tmp_path / "a.log"
    write(p, [f"line{i}" for i in range(100)])
    c = read_tail(p, 5)
    assert [ln.text for ln in c.lines] == [f"line{i}" for i in range(95, 100)]
    assert c.start_offset == c.lines[0].offset > 0
    assert c.end_offset == c.size == p.stat().st_size
    assert open(p, "rb").read()[c.lines[0].offset :].startswith(b"line95")


def test_tail_whole_small_file(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["a", "b", "c"])
    c = read_tail(p, 50)
    assert [ln.text for ln in c.lines] == ["a", "b", "c"]
    assert c.start_offset == 0


def test_tail_before_pages_backwards(tmp_path):
    p = tmp_path / "a.log"
    write(p, [f"line{i:03d}" for i in range(500)])
    seen: list[str] = []
    c = read_tail(p, 100)
    seen = [ln.text for ln in c.lines] + seen
    while c.start_offset > 0:
        c = read_tail(p, 100, before=c.start_offset)
        seen = [ln.text for ln in c.lines] + seen
    assert seen == [f"line{i:03d}" for i in range(500)]


def test_tail_across_chunk_boundary(tmp_path, monkeypatch):
    monkeypatch.setattr(reader, "CHUNK_BYTES", 16)
    p = tmp_path / "a.log"
    write(p, [f"line-{i:03d}-" + "x" * (i % 20) for i in range(60)])
    expected = p.read_text().splitlines()
    c = read_tail(p, 60)
    assert [ln.text for ln in c.lines] == expected
    assert c.start_offset == 0
    c = read_tail(p, 7)
    assert [ln.text for ln in c.lines] == expected[-7:]


def test_tail_filters_by_query_and_level(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["INFO start", "ERROR db down", "INFO ok", "WARN slow db", "ERROR other"])
    assert [ln.text for ln in read_tail(p, 10, query="DB").lines] == [
        "ERROR db down",
        "WARN slow db",
    ]
    c = read_tail(p, 10, levels=frozenset({"error"}))
    assert [ln.text for ln in c.lines] == ["ERROR db down", "ERROR other"]
    assert read_tail(p, 10, query="zzz").lines == []


def test_scan_limit_on_big_file(tmp_path, monkeypatch):
    monkeypatch.setattr(reader, "MAX_SCAN_BYTES", 256)
    monkeypatch.setattr(reader, "CHUNK_BYTES", 64)
    p = tmp_path / "a.log"
    write(p, [f"INFO filler line number {i}" for i in range(200)])
    c = read_tail(p, 10, query="nomatch")
    assert c.lines == [] and c.scan_limited and c.start_offset > 0


def test_partial_last_line_is_held_back_while_fresh(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["one", "two", "thr"], trailing=False)
    now = p.stat().st_mtime + 1
    c = read_tail(p, 10, now=now)
    assert [ln.text for ln in c.lines] == ["one", "two"]
    assert c.end_offset == len("one\ntwo\n")
    c2 = read_tail(p, 10, now=now + 60)  # 更新が止まっていれば確定
    assert [ln.text for ln in c2.lines] == ["one", "two", "thr"]


def test_follow_appended_lines(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["a", "b"])
    c = read_tail(p, 10)
    with open(p, "a") as f:
        f.write("c\nd\n")
    n = read_after(p, c.end_offset, c.inode, 10)
    assert [ln.text for ln in n.lines] == ["c", "d"] and not n.rotated
    assert n.end_offset == p.stat().st_size
    assert read_after(p, n.end_offset, n.inode, 10).lines == []


def test_follow_limits_lines_and_continues(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["a"])
    c = read_tail(p, 10)
    with open(p, "a") as f:
        f.write("".join(f"n{i}\n" for i in range(5)))
    n1 = read_after(p, c.end_offset, c.inode, 3)
    n2 = read_after(p, n1.end_offset, c.inode, 3)
    assert [ln.text for ln in n1.lines + n2.lines] == [f"n{i}" for i in range(5)]


def test_follow_detects_rename_rotation(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["old1", "old2"])
    c = read_tail(p, 10)
    os.rename(p, tmp_path / "a.log.1")
    write(p, ["new1"])
    n = read_after(p, c.end_offset, c.inode, 10)
    assert n.rotated and [ln.text for ln in n.lines] == ["new1"]
    assert n.inode != c.inode


def test_follow_detects_truncate_rotation(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["old line one", "old line two"])
    c = read_tail(p, 10)
    write(p, ["x"])  # 同じ inode のまま縮む（copytruncate）
    n = read_after(p, c.end_offset, c.inode, 10)
    assert n.rotated and [ln.text for ln in n.lines] == ["x"]


def test_follow_filters_apply(tmp_path):
    p = tmp_path / "a.log"
    write(p, ["INFO a"])
    c = read_tail(p, 10)
    with open(p, "a") as f:
        f.write("INFO b\nERROR c\n")
    n = read_after(p, c.end_offset, c.inode, 10, levels=frozenset({"error"}))
    assert [ln.text for ln in n.lines] == ["ERROR c"]
    assert n.end_offset == p.stat().st_size  # 絞り込みで除外した行も読み進める


def test_invalid_utf8_and_long_line(tmp_path):
    p = tmp_path / "a.log"
    p.write_bytes(b"bad \xff\xfe byte\n" + b"y" * 20000 + b"\n")
    c = read_tail(p, 10)
    assert "�" in c.lines[0].text
    assert len(c.lines[1].text) <= reader.MAX_LINE_CHARS + 2


def test_missing_and_unreadable(tmp_path):
    with pytest.raises(LogError) as e:
        read_tail(tmp_path / "nope.log", 5)
    assert e.value.kind == "missing"
    p = tmp_path / "a.log"
    p.write_text("x\n")
    p.chmod(0)
    try:
        if os.access(p, os.R_OK):
            pytest.skip("root は読めてしまう")
        with pytest.raises(LogError) as e2:
            read_tail(p, 5)
        assert e2.value.kind == "denied"
    finally:
        p.chmod(0o644)


def test_list_files_includes_generations_only(tmp_path):
    a = make_app(tmp_path, ["app.log", "other/x.log"])
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "x.log").write_text("x")
    for n in ["app.log", "app.log.1", "app.log.2026-11-23", "app.log.2.gz", "app.logger", "b.log"]:
        (tmp_path / n).write_text("x")
    (tmp_path / "app.log.dir").mkdir()
    files = list_files(a, a.services[0])
    names = [(f.source, f.name) for f in files]
    assert names[0] == (0, "app.log")
    assert {n for s, n in names if s == 0} == {"app.log", "app.log.1", "app.log.2026-11-23"}
    assert (1, "x.log") in names


def test_list_files_marks_missing_current(tmp_path):
    a = make_app(tmp_path, ["gone.log"])
    (f,) = list_files(a, a.services[0])
    assert not f.exists and f.is_current and f.size is None


def test_resolve_file_rejects_outside_names(tmp_path):
    a = make_app(tmp_path, ["app.log"])
    svc = a.services[0]
    (tmp_path / "app.log.1").write_text("x")
    (tmp_path / "secret.txt").write_text("s")
    assert resolve_file(svc=svc, app=a, source=0, name="app.log.1").name == "app.log.1"
    for bad in [
        "secret.txt",
        "../secret.txt",
        "app.log/../secret.txt",
        "..",
        "app.logx",
        "app.log.",
    ]:
        with pytest.raises(LogError):
            resolve_file(a, svc, 0, bad)
    with pytest.raises(LogError):
        resolve_file(a, svc, 5, "app.log")


def test_resolve_file_rejects_symlink_generation(tmp_path):
    a = make_app(tmp_path, ["app.log"])
    (tmp_path / "secret.txt").write_text("s")
    os.symlink(tmp_path / "secret.txt", tmp_path / "app.log.1")
    with pytest.raises(LogError):
        resolve_file(a, a.services[0], 0, "app.log.1")


@pytest.fixture
def client(tmp_path):
    a = make_app(tmp_path, ["app.log"])
    write(tmp_path / "app.log", ["INFO a", "ERROR b", "INFO c"])

    class Holder:
        class registry:  # noqa: N801
            apps = [a]

            @staticmethod
            def get(i):
                return a if i == "x" else None

    fastapi_app.dependency_overrides[get_registry_holder] = lambda: Holder
    try:
        yield TestClient(fastapi_app), tmp_path
    finally:
        fastapi_app.dependency_overrides.clear()


def test_api_list_and_read(client):
    c, tmp = client
    assert c.get("/api/logs").json() == [
        {
            "app_id": "x",
            "app_name": "X",
            "service_id": "svc",
            "service_name": "svc",
            "files": [
                {
                    "source": 0,
                    "name": "app.log",
                    "is_current": True,
                    "size": 22,
                    "modified_at": c.get("/api/logs").json()[0]["files"][0]["modified_at"],
                    "exists": True,
                }
            ],
        }
    ]
    r = c.get("/api/logs/read", params={"app_id": "x", "service_id": "svc", "lines": 2}).json()
    assert [ln["text"] for ln in r["lines"]] == ["ERROR b", "INFO c"]
    assert [ln["level"] for ln in r["lines"]] == ["error", "info"]
    assert r["has_more_before"] is True and not r["rotated"]


def test_api_filters_and_errors(client):
    c, tmp = client
    base = {"app_id": "x", "service_id": "svc"}
    r = c.get("/api/logs/read", params={**base, "levels": "error"}).json()
    assert [ln["text"] for ln in r["lines"]] == ["ERROR b"]
    assert c.get("/api/logs/read", params={**base, "levels": "bogus"}).status_code == 422
    assert c.get("/api/logs/read", params={**base, "before": 1, "after": 1}).status_code == 422
    assert c.get("/api/logs/read", params={**base, "name": "../x"}).status_code == 404
    assert c.get("/api/logs/read", params={**base, "source": 3}).status_code == 404
    assert c.get("/api/logs/read", params={"app_id": "no", "service_id": "svc"}).status_code == 404
    (tmp / "app.log").unlink()
    assert c.get("/api/logs/read", params=base).status_code == 404


def test_api_follow_and_rotation(client):
    c, tmp = client
    base = {"app_id": "x", "service_id": "svc"}
    r = c.get("/api/logs/read", params=base).json()
    with open(tmp / "app.log", "a") as f:
        f.write("WARN d\n")
    n = c.get(
        "/api/logs/read", params={**base, "after": r["end_offset"], "inode": r["inode"]}
    ).json()
    assert [ln["text"] for ln in n["lines"]] == ["WARN d"] and not n["rotated"]
    os.rename(tmp / "app.log", tmp / "app.log.1")
    write(tmp / "app.log", ["INFO fresh"])
    n2 = c.get(
        "/api/logs/read", params={**base, "after": n["end_offset"], "inode": n["inode"]}
    ).json()
    assert n2["rotated"] and [ln["text"] for ln in n2["lines"]] == ["INFO fresh"]
    names = [f["name"] for f in c.get("/api/logs").json()[0]["files"]]
    assert "app.log.1" in names


def test_follow_offset_not_past_unterminated_chunk(tmp_path, monkeypatch):
    monkeypatch.setattr(reader, "MAX_FOLLOW_BYTES", 8)
    p = tmp_path / "a.log"
    write(p, ["x"])
    c = read_tail(p, 10)
    with open(p, "a") as f:
        f.write("y" * 30 + "\n")
    n = read_after(p, c.end_offset, c.inode, 10, now=OLD + p.stat().st_mtime)
    assert n.end_offset <= p.stat().st_size
    assert n.end_offset == c.end_offset + 8
