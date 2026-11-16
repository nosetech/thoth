import pytest

from thoth.config import Config, ConfigError, load_config, parse_config


def test_defaults_when_file_missing(tmp_path):
    assert load_config(tmp_path / "none.yaml") == Config()


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
