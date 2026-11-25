"""Slack Incoming Webhook の URL の読み込みと送信（#17）。

URL は秘密情報なので設定ファイル・ログ・API 応答には出さない。読み込み元は thoth の環境変数
``THOTH_SLACK_WEBHOOK_URL``、無ければリポジトリ直下の ``.env``（git 管理しない）。
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from collections.abc import Mapping
from pathlib import Path

from thoth.config import BACKEND_ROOT

logger = logging.getLogger(__name__)

WEBHOOK_ENV = "THOTH_SLACK_WEBHOOK_URL"
DOTENV_PATH = BACKEND_ROOT.parent / ".env"
WEBHOOK_PREFIX = "https://hooks.slack.com/"
_WEBHOOK_RE = re.compile(r"https://hooks\.slack\.com/[A-Za-z0-9/_\-]+")
SEND_TIMEOUT = 5.0


def read_dotenv(path: Path) -> dict[str, str]:
    """``KEY=VALUE`` 形式（``export`` 前置・引用符・``#`` コメント行に対応）を読む。無ければ空。"""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if value[:1] in "'\"" and value[0] in value[1:]:  # 引用符の後ろは捨てる（行末コメント）
            value = value[: value.index(value[0], 1) + 1]
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value)  # 引用符なしの値の行末コメント
        out[key.strip()] = value
    return out


def load_webhook_url(
    environ: Mapping[str, str] | None = None, dotenv: Path = DOTENV_PATH
) -> str | None:
    """Webhook URL を返す。未設定・形式が不正なら None（通知しない。起動は止めない）。"""
    env = os.environ if environ is None else environ
    url = env.get(WEBHOOK_ENV, "").strip() or read_dotenv(dotenv).get(WEBHOOK_ENV, "").strip()
    if not url:
        return None
    if not _WEBHOOK_RE.fullmatch(url):  # 値はログに出さない
        logger.warning(
            "%s が %s で始まる URL ではないため Slack 通知を無効にします",
            WEBHOOK_ENV,
            WEBHOOK_PREFIX,
        )
        return None
    return url


def escape(text: str) -> str:
    """Slack の mrkdwn で特別な意味を持つ文字をエスケープする。"""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def send(url: str, text: str, timeout: float = SEND_TIMEOUT) -> bool:
    """1 件送信する。失敗は False（例外は出さない。URL はログに出さない）。"""
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # https 固定（WEBHOOK_PREFIX）
            return 200 <= res.status < 300
    except urllib.error.HTTPError as e:
        logger.warning("Slack 通知に失敗しました（HTTP %d）", e.code)
    except Exception as e:  # 例外メッセージは URL を含みうるので型名だけ残す
        logger.warning("Slack 通知に失敗しました: %s", type(e).__name__)
    return False
