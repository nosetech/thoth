#!/usr/bin/env bash
# backend と frontend をバックグラウンドで起動する。
#   THOTH_FRONTEND_MODE=start(既定。未ビルドなら build する) | dev
# frontend の bind 先は LAN_IP / TAILSCALE_IP(どちらか一方)で指定する。未指定なら 127.0.0.1。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
resolve_frontend_host
mkdir -p "$LOG_DIR"

MODE="${THOTH_FRONTEND_MODE:-start}"
case "$MODE" in start | dev) ;; *) echo "THOTH_FRONTEND_MODE は start か dev を指定してください: $MODE" >&2; exit 1 ;; esac

for svc in backend frontend; do
  if [ "$(uname)" = Darwin ] && service_loaded "$svc"; then
    echo "$svc は launchd(常時起動)に登録されています。scripts/service.sh stop か uninstall を実行してください" >&2
    exit 1
  fi
  if is_running "$svc"; then
    echo "$svc は既に起動しています(pid $(cat "$(pid_file "$svc")"))。先に scripts/stop.sh を実行してください" >&2
    exit 1
  fi
done

# 使用中のポートはエラー終了する(バックグラウンド起動後に失敗に気づけないため、先に検査する)
check_port_free backend 127.0.0.1 "$BACKEND_PORT"
check_port_free frontend "$FRONTEND_HOST" "$FRONTEND_PORT"

if [ "$MODE" = start ] && [ ! -f "$ROOT/frontend/.next/BUILD_ID" ]; then
  echo "frontend をビルドします"
  (cd "$ROOT/frontend" && npm run build)
fi

(cd "$ROOT/backend" && nohup uv run python -m thoth.main \
  >>"$LOG_DIR/backend.log" 2>&1 & echo $! >"$(pid_file backend)")

# BACKEND_URL は /api/* の中継先。backend は常に 127.0.0.1
# 開発サーバは bind 先を許可オリジンの既定にする(未指定だと /_next/* が403になる)
DEV_ORIGINS="${ALLOWED_DEV_ORIGINS:-}"
if [ -z "$DEV_ORIGINS" ] && [ "$FRONTEND_PUBLIC" = 1 ]; then DEV_ORIGINS="$FRONTEND_HOST"; fi

(cd "$ROOT/frontend" && \
  ALLOWED_DEV_ORIGINS="$DEV_ORIGINS" BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
  nohup npm run "$MODE" -- -H "$FRONTEND_HOST" -p "$FRONTEND_PORT" >>"$LOG_DIR/frontend.log" 2>&1 & echo $! >"$(pid_file frontend)")

echo "起動しました: backend http://127.0.0.1:$BACKEND_PORT / frontend http://$FRONTEND_HOST:$FRONTEND_PORT"
if [ "$FRONTEND_PUBLIC" = 1 ]; then
  echo "frontend の bind 先: $FRONTEND_HOST (http://$FRONTEND_HOST:$FRONTEND_PORT)"
else
  echo "frontend はローカルのみ(127.0.0.1)で待ち受けています。LAN/Tailscale に公開するには LAN_IP か TAILSCALE_IP を指定してください"
fi
echo "ログ: $LOG_DIR/{backend,frontend}.log"
