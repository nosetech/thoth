"""変更系 API の CSRF 対策（docs/architecture.md「セキュリティ方針」）。"""

import ipaddress
import os
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request

from thoth.api.deps import get_config
from thoth.config import Config

CSRF_HEADER = "x-thoth-request"


def _public_hosts() -> list[str]:
    """thoth の環境変数 LAN_IP / TAILSCALE_IP のうち、有効な IP のみ返す。

    frontend を LAN / VPN に公開している場合、ブラウザの Origin はそのホストになる。
    0.0.0.0 / :: / ループバック / マルチキャストは起動時検証と同様に除外する。
    """
    hosts: list[str] = []
    for name in ("LAN_IP", "TAILSCALE_IP"):
        raw = os.environ.get(name, "").strip()
        if not raw:
            continue
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if ip.is_unspecified or ip.is_loopback or ip.is_multicast:
            continue
        hosts.append(f"[{ip}]" if ip.version == 6 else str(ip))
    return hosts


def require_same_origin(request: Request, cfg: Annotated[Config, Depends(get_config)]) -> None:
    """Origin（無ければ Referer）が frontend オリジンと一致し、カスタムヘッダがあること。

    frontend オリジン: ループバック、および thoth の環境変数 LAN_IP / TAILSCALE_IP。
    """
    port = cfg.frontend.port
    allowed = {f"http://{h}:{port}" for h in ("127.0.0.1", "localhost", *_public_hosts())}
    origin = request.headers.get("origin")
    if origin is None:
        ref = request.headers.get("referer")
        if ref:
            u = urlsplit(ref)
            origin = f"{u.scheme}://{u.netloc}"
    if origin not in allowed or request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(status_code=403, detail="forbidden")
