# thoth

ローカルPCで動作する個人開発のWebアプリを管理（起動・停止・稼働確認・ログ/リソース監視）するWebアプリ。
構想は Inkdrop「thoth / Service Concept」、開発計画は GitHub issue（Phase 0〜6）を参照。

## 構成

- `backend/` Python 3.11+ / FastAPI / SQLite（SQLAlchemy + Alembic）
- `frontend/` Next.js（App Router）/ TypeScript
- `config/config.yaml.example` 設定（`config.yaml` にコピーして使う。未作成でも既定値で動く）

## 開発

```sh
# backend（127.0.0.1:8900）
cd backend && uv sync && uv run python -m thoth.main

# frontend（http://localhost:3900。/api/* は BACKEND_URL へ中継）
cd frontend && npm ci && BACKEND_URL=http://127.0.0.1:8900 npm run dev -- -H 127.0.0.1 -p 3900
```

`scripts/start.sh` などの起動スクリプトは #10 で追加予定。

## テスト・検査

```sh
cd backend && uv run ruff format --check . && uv run ruff check . && uv run pytest
cd frontend && npm run format:check && npm run lint && npm run typecheck && npm test
```

注意: シェルに `NODE_ENV=development` が設定されていると `npm run build` が失敗する。`env -u NODE_ENV npm run build` で実行する。
