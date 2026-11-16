# Contributing

- `develop` から `feature/<issue番号>-<概要>` を切り、PR で `develop` に取り込む。`master` / `develop` へ直接コミットしない。
- PR 本文に対応 issue を独立した行で `Closes #<番号>` と書く（直後に日本語を続けない）。
- issue ラベル: `status:todo` / `status:in-progress` / `status:in-review` / `status:closed` / `needs-human-decision` / `phase:N`。
- CI（`.github/workflows/ci.yml`）が通ること。検査コマンドは README を参照。
- 設計方針は `docs/architecture.md` に従う。
