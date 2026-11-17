import pytest

from thoth.config import Config, ConfigError, load_config, parse_config


def test_explicit_path_missing_raises(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "none.yaml")


def test_env_path_missing_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("THOTH_CONFIG", str(tmp_path / "none.yaml"))
    with pytest.raises(ConfigError):
        load_config()


def test_explicit_path_directory_raises(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path)


def test_empty_env_raises(monkeypatch):
    monkeypatch.setenv("THOTH_CONFIG", "")
    with pytest.raises(ConfigError):
        load_config()


def test_default_path_missing_uses_defaults(tmp_path, monkeypatch):
    monkeypatch.delenv("THOTH_CONFIG", raising=False)
    monkeypatch.setattr("thoth.config.DEFAULT_CONFIG_PATH", str(tmp_path / "none.yaml"))
    assert load_config() == Config()


def test_override(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("backend:\n  port: 9000\n", encoding="utf-8")
    cfg = load_config(p)
    assert cfg.backend.port == 9000
    assert cfg.frontend.port == 3900


@pytest.mark.parametrize(
    "raw",
    [
        {"unknown": 1},
        {"backend": {"host": "0.0.0.0"}},
        {"backend": {"port": 0}},
        {"frontend": {"port": 70000}},
        {"backend": {"port": True}},
        {"db": {"path": ""}},
        {"instance": " "},
        [],
    ],
)
def test_invalid(raw):
    with pytest.raises(ConfigError):
        parse_config(raw)
