# thoth

ローカルPCで動作する個人開発のWebアプリを管理（起動・停止・稼働確認・ログ/リソース監視）するWebアプリ。
構想は Inkdrop「thoth / Service Concept」、開発計画は GitHub issue（Phase 0〜6）を参照。

## 構成

- `backend/` Python 3.11+ / FastAPI / SQLite（SQLAlchemy + Alembic）
- `frontend/` Next.js（App Router）/ TypeScript
- `config/config.yaml.example` 設定（`config.yaml` にコピーして使う。未作成でも既定値で動く）
- `.env.example` 秘密情報（Slack の Webhook URL）。`.env` にコピーして使う（git 管理しない。未作成なら通知しない）

## 開発

```sh
# backend（127.0.0.1:8900）
cd backend && uv sync && uv run python -m thoth.main

# frontend（http://localhost:3900。/api/* は BACKEND_URL へ中継）
cd frontend && npm ci && BACKEND_URL=http://127.0.0.1:8900 npm run dev -- -H 127.0.0.1 -p 3900
```

## 起動・停止（スクリプト）

```sh
scripts/start.sh   # backend と frontend をバックグラウンド起動（frontend は未ビルドなら build）
scripts/stop.sh    # 停止
LAN_IP=192.168.10.101 scripts/start.sh   # frontend をその IP にのみ bind（TAILSCALE_IP も同様。両方指定はエラー）
THOTH_FRONTEND_MODE=dev scripts/start.sh # frontend を開発サーバで起動
```

- 既定ポートは backend 8900 / frontend 3900（`config/config.yaml` で変更。他アプリ: deep-tracker 8700/3700、focara 8800/3800、producer-desk 8787/3000 と衝突しない値）。使用中のポートがあるとエラー終了する。
- ログと PID は `log.dir`（既定 `logs/`）に置く。backend は常に `127.0.0.1`。
- 常時起動（macOS / launchd）: `scripts/service.sh install|uninstall|start|stop|restart|status`。plist のテンプレートは `scripts/com.nosetech.thoth.*.plist.example`。`start.sh` とは併用できない。事前に `backend/` で `uv sync`、`frontend/` で `npm ci` を済ませる。
- 動作確認用の別インスタンス（空きポート・専用の設定/DB/ログ・`apps` は空）: `scripts/dev-instance.sh start|stop|status`。

## テスト・検査

```sh
cd backend && uv run ruff format --check . && uv run ruff check . && uv run pytest
cd frontend && npm run format:check && npm run lint && npm run typecheck && npm test
```

注意: シェルに `NODE_ENV=development` が設定されていると `npm run build` が失敗する。`env -u NODE_ENV npm run build` で実行する。
