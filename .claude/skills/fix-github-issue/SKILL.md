---
name: fix-github-issue
description: github issueを対応する
disable-model-invocation: false
---

GitHub issueを分析して対応してください: issue番号 $ARGUMENTS

ブランチ運用・PR・コミットの詳細は CONTRIBUTING.md、基本ルールとコマンドは CLAUDE.md、設計方針は docs/architecture.md に従うこと。以下の手順で進めてください。

1. **Issue 詳細の取得**
   - `gh issue view <issue-number>` で issue 詳細を取得
   - `needs-human-decision` ラベルが付いている、または本文に未決事項がある場合は、実装に入らず人間に確認する

2. **問題の理解**
   - Issue の説明、背景、要件、受け入れ条件を理解する
   - 設計の共通方針は Inkdrop「Claude Rule / system design note」、サービス概要は「thoth / Service Concept」にある。issue と矛盾しそうな場合は人間に確認する

3. **関連ファイルの検索**
   - 実装に必要なファイルを特定する（backend: `backend/thoth/`、frontend: `frontend/`）
   - DB スキーマに関わる場合は `backend/thoth/db/models.py` と Alembic マイグレーション（`backend/thoth/db/migrations/versions/`）も対象になる
   - 設定（`config/*.yaml.example`）、`docs/architecture.md`、README / CLAUDE.md に修正すべき箇所があるかも特定する

3.5. **UI に関わる issue の場合**
   - 方針は CLAUDE.md「画面デザインの実装ルール」に従う。Artifacts のデザインは **UI の操作イメージ（画面構成・状態遷移・文言・操作フロー）を固めるためのもの**で、見た目の値を忠実に再現する対象ではない。実装は **cosmic-ui のコンポーネントを使って**行い、独自のコンポーネント・CSS は極力作らない
   - `Artifact` ツール（`action: "list"`、`scope: "files"` でファイル一覧 → `action: "read"` で対象ファイル）でデザインの実ソースを直接取得し、対象画面の構成・状態遷移・文言・操作フローを読み取る（`WebFetch` は認証エラーで使えない）。取得結果が途中で欠けていないか確認する
   - `Artifact` ツールが使えない場合（未ログイン・ツール無効等）はフォールバックしない。その旨を明記してその場で作業を停止し、人間に確認を求める
   - 必要な部品が `frontend/components/ui/` に無ければ、cosmic-ui（`rizznme/cosmic-ui`）から取り込む手順（`docs/architecture.md`）で追加する。npm の `cosmic-ui` は無関係の別パッケージなので使わない
   - **cosmic-ui で実装できないもの（該当する部品・表現が無い等）があれば、自分で独自実装せず、何が足りないかと代替案（cosmic-ui の組み合わせ、独自実装、デザイン側の変更）を示して人間に判断を仰ぐ。** 確認が取れるまでその部分の実装を進めない
   - Artifact の値（色・余白・border-radius・フォント・アニメーション）を独自 CSS や `globals.css` に移植しない。見た目は cosmic-ui のテーマ・コンポーネントに従う
   - `docs/` の設計文書や issue とデザインに齟齬があれば、実装前に人間に確認する
   - デザインのモック固有のもの（ダミーデータ、デモ用スイッチ、仮画面）は実装に含めない
   - **対象画面のデザインがまだ存在しない場合**、自分でレイアウトを創作しない。`Artifact` ツールで既存デザインを直接編集せず、人間に Claude のチャットでのデザイン作成を依頼する。`docs/design-prompt-ui-*.md` と同じ形式でチャットに貼る要件をまとめて提示し、既存のデザインを上書きせず作業ブランチ名を使った新規ファイルとして作るよう指示に明記する。作成後は `list` で新規ファイルの存在を確認し、`read` で取得して実装を進めてよい
   - 実装後は `mcp__claude-in-chrome__*` で完成品とデザインのプレビューを見比べ、操作イメージ（画面構成・状態遷移・文言・操作フロー）が一致することを確認する（セルフレビュー用途）。見た目の値の違いは cosmic-ui に従うため差異として扱わない

4. **コードの実装**
   - 着手時に issue のラベルを `status:todo` から `status:in-progress` に変更する（`gh issue edit <番号> --remove-label status:todo --add-label status:in-progress`）
   - `develop` から `feature/<issue番号>-<概要>` ブランチを切って実装する（`master` / `develop` に直接コミットしない）
   - 守るべき設計ルール（詳細は CLAUDE.md / docs/architecture.md）
     - backend は常に `127.0.0.1` に bind する。ブラウザは同一オリジンの `/api/*` を呼び、frontend の Route Handler が `BACKEND_URL` へ中継する
     - 設定は YAML（未知キーはエラー）。アプリ登録定義も YAML を正とし、DB は状態・履歴用
     - 日時は UTC 保存（`UtcDateTime`）。モデルを変更したらマイグレーションを追加し、`test_migration_matches_models` を通す
     - 監視対象アプリの起動コマンドは設定ファイルでの登録のみ。API から任意のコマンド・環境変数・作業ディレクトリを受け取らない。実行は argv 配列・`shell=False`
     - ログ・API 応答に環境変数の値や機密情報を出さない
   - UI に関わる場合は、ステップ 3.5 で取得したデザインの操作イメージをもとに、cosmic-ui のコンポーネントで実装する。cosmic-ui で実装できないものは独自実装せず判断を仰ぐ。実装後に同じブラウザ操作ツールで実装結果とデザインを見比べ、画面構成・状態遷移・文言・操作フローが一致することを確認する
   - 実装後、変更した側のチェックを通す
     - backend（`backend/` で実行）: `uv run ruff format . && uv run ruff check .`、`uv run pytest`
     - frontend（`frontend/` で実行）: `npm run lint`、`npm run typecheck`、`npm test`、必要に応じて `env -u NODE_ENV npm run build`
   - 画面・API の動作確認が必要な場合は、既定ポート（backend 8900 / frontend 3900）と衝突しないよう別ポートの設定で起動する。`pkill` / `killall` / ポート検索による kill はしない（監視対象アプリや他 worktree のプロセスを巻き込むため）。自分が起動したプロセスのみ、確認後に停止する

5. **プルリクエスト作成**
   - コミットメッセージ・PR 説明の末尾の署名は、システムから指示された形式に従う
   - `develop` ブランチへのプルリクエストを作成する
   - PR の説明に対応 issue を独立した行で `Closes #<issue番号>` と記載する（直後に日本語を続けない）
   - UI に関わる場合は、参照したデザイン（URL・ファイル）と、使用した cosmic-ui のコンポーネント、デザインの操作イメージに合わせた点・合わせられなかった点、cosmic-ui で実装できず判断を仰いだ点（あれば）を PR 説明に書く
   - issue のラベルを `status:in-review` に変更する
   - **PR 作成完了をコンソールに表示する**

6. **CI 完了待機と確認**
   - GitHub Actions による CI が実行される
   - CI 完了を待つ（`gh pr view <PR-number> --json statusCheckRollup` で確認）。**CI 実行中であること自体は人間の判断が必要な状況ではない。**
   - CI が失敗した場合は原因を調査して修正し、再度 push する

7. **コードレビュー実施**
   - `code-reviewer` エージェント（`.claude/agents/code-reviewer.md`）を Agent ツールで呼び出し、PR 番号を渡して実装コードの詳細レビューを実施させる
   - UI に関わる場合は、デザインの操作イメージに沿っているか、cosmic-ui のコンポーネントを使い独自のコンポーネント・CSS を不必要に作っていないかのレビューも含まれる。ステップ 3.5 で新規デザインファイルを使った場合は、そのパスもエージェントに伝える
   - 重大な問題、改善提案を含むレビュー結果を取得する
   - 「デザイン照合は未実施」と報告された場合は、原因（`Artifact` ツールが使えない等）を確認して人間に伝える

8. **レビュー結果をプルリクエストに投稿**
   - 取得したレビュー結果を、以下のコマンドでプルリクエストに投稿する（長い場合は `--body-file` を使う）：

   ```bash
   gh pr comment <PR-number> --body "レビュー結果のテキスト"
   ```

   - **コメント投稿完了まで、このステップは完了とはみなさない**
   - コメント投稿後、PR の URL をコンソールに表示する
   - マージは人間が行う。マージ後の `status:closed` への変更もこのスキルの範囲外
