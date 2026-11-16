# アーキテクチャ

## 技術スタック
- backend: Python 3.11+ / FastAPI / uvicorn / pydantic、uv 管理、ruff（line-length 100）、pytest
- DB: SQLite（WAL）/ SQLAlchemy 2.x（同期）/ Alembic（`backend/thoth/db/migrations/`、パッケージ内）
- frontend: Next.js（App Router）/ TypeScript strict / npm、ESLint + Prettier、`node --test`
- 設定: YAML（`config/config.yaml.example`）

## 既定ポート
backend 8900 / frontend 3900。既存アプリ（deep-tracker 8700/3700、focara 8800/3800、ほか 3000・4000・8787）と衝突しない値。

## 構成
- backend は `127.0.0.1` 固定。frontend の `app/api/[...path]/route.ts` が実行時に `BACKEND_URL` へ中継する（ビルド時固定の `rewrites` は使わない）。
- 起動時に設定読込 → DB 作成 → 自動マイグレーション → uvicorn 起動。
- 以降の設計は GitHub issue（#2 アプリ管理モデルなど）で追加する。
