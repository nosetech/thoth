"""変更系 API の CSRF 対策（docs/architecture.md「セキュリティ方針」）。"""

from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request

from thoth.api.deps import get_config
from thoth.config import Config

CSRF_HEADER = "x-thoth-request"


def require_same_origin(request: Request, cfg: Annotated[Config, Depends(get_config)]) -> None:
    """Origin（無ければ Referer）が frontend オリジンと一致し、カスタムヘッダがあること。"""
    allowed = {f"http://127.0.0.1:{cfg.frontend.port}", f"http://localhost:{cfg.frontend.port}"}
    origin = request.headers.get("origin")
    if origin is None:
        ref = request.headers.get("referer")
        if ref:
            u = urlsplit(ref)
            origin = f"{u.scheme}://{u.netloc}"
    if origin not in allowed or request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(status_code=403, detail="forbidden")
