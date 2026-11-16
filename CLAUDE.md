# CLAUDE.md

thoth: ローカルPCのWebアプリを管理・監視するアプリ。設計の共通方針は Inkdrop「Claude Rule / system design note」に従う。

## コマンド
- backend（`backend/` で実行）: `uv sync` / `uv run python -m thoth.main` / `uv run ruff format . && uv run ruff check .` / `uv run pytest`
- frontend（`frontend/` で実行）: `npm ci` / `npm run dev` / `npm run lint` / `npm run typecheck` / `npm test` / `env -u NODE_ENV npm run build`

## ルール
- backend は常に `127.0.0.1` に bind（`BACKEND_HOST`）。ブラウザは同一オリジンの `/api/*` を呼び、frontend の Route Handler が `BACKEND_URL` へ中継する。
- 設定は YAML（`config/config.yaml`、未知キーはエラー）。アプリ登録定義も YAML を正とし、DB は状態・履歴用（#2）。
- 日時は UTC 保存（`UtcDateTime`）。マイグレーションは `0001_*.py` の連番で、`test_migration_matches_models` で乖離を検出する。
- ブランチ・PR・コミット規約は `CONTRIBUTING.md`。
