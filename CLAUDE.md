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
- アプリ定義は `config/apps.yaml`（＋同階層 `apps.d/*.yaml`、`config.yaml` の `apps.path` で変更可。明示したパスが無ければエラー）。`GET /api/apps`、`POST /api/config/reload`（変更系は Origin/Referer と `X-Thoth-Request: 1` が必須）。
- プロセス制御（#5）: `POST /api/apps/{id}[/services/{id}]/(start|stop|restart)`（Origin/Referer と `X-Thoth-Request: 1` 必須）。実行は argv・`shell=False`・`start_new_session` で、`pkill` / ポート検索での kill はしない。動作確認は検証用ポートの thoth で行い、起動・停止を試すアプリは許可されたものだけにする。詳細は `docs/architecture.md`「プロセス制御（#5）」。
- 一括操作（#7）: `POST /api/bulk/(start|stop|restart)?on_failure=continue|abort`（CSRF 必須）。アプリごとの成否を 200 で返す。詳細は `docs/architecture.md`「一括操作（#7）」。

## 画面デザインの実装ルール

画面実装は、Claude の Artifacts にあるデザインを**正**として忠実に実装すること。レイアウト・配色・コンポーネント構成・インタラクションを独自解釈で変更しない。

- デザイン（アプリ一覧・操作 UI、#8）: https://claude.ai/artifact/3z5oGchGZ3Z6JKKooaVLy5（アーティファクト名「thoth — アプリ管理 UI プロトタイプ」。一覧は https://claude.ai/artifacts）
- 主なファイル: `index.html`（約99KB。スタイル（`:root` の CSS 変数など）・コンポーネント・状態ロジックを1ファイルに含む単一ページ。React はコンパイル済みの `React.createElement` 形式）。`Artifact` の `list`（`scope: "files"`）で実在を確認し、ファイルが増えた・分割された場合はすべて読む。
- 元になった指示プロンプトは `docs/design-prompt-ui-apps.md`。デザインと `docs/` や issue の仕様に齟齬がある場合は、実装前にどちらを正とするか確認する。デザインが更新されたら、この節の URL・ファイル一覧も更新する。
- デザインのモックは単一 HTML のプロトタイプ。ダミーデータ・デモ用スイッチ（画面状態の切替、失敗の強制）・仮画面（ログ・リソース）は**実装に含めない**。見た目・状態遷移・文言・操作フローを移植し、データは `/api/*` から取得する。
- 実装は既存の基盤（`docs/architecture.md`「フロントエンドのテーマとレイアウト（#3）」: Tailwind v4・cosmic-ui・`AppShell`）の上で行い、デザインの値（色・余白・border-radius・フォント・アニメーション）は `globals.css` の `@theme` やコンポーネントに反映する。基盤とデザインの値が食い違う場合は独自に折衷せず、確認する。

**重要**: 上記 URL は `claude.ai` の認証が必要なページで、`WebFetch` では取得できない。配色・余白などの値はデザインの実ソースにしかない。

**実装・レビュー時は必ず `Artifact` ツールでデザインの実ソースを直接取得し、実際の CSS/JS の値を確認してから実装すること。**

1. `Artifact` の `action: "list"`、`scope: "files"`、`url` に上記 URL を指定してファイル一覧を取得する
2. `action: "read"`、`url`、`path` でファイルを取得する（複数は `paths` でまとめて取得できる。取得したファイルはスクラッチパッド配下に保存されるので、そこから対象コンポーネントの値を検索して読む）
3. **取得結果が途中で欠けていないか必ず確認する。** 欠けて対象のスタイル定義を取りこぼした可能性があるときは、取得できた範囲だけで実装を進めず、その旨を明記して作業を停止し、Claude のチャットでのファイル分割を人間に依頼する

`Artifact` ツールの利用には `claude.ai` アカウントでの `/login` が必要。`claude -p`（ヘッドレス）では既定で無効なので、`CLAUDE_CODE_ARTIFACT=1` で有効化する。**`Artifact` ツールが使えない場合（未ログイン・ツール無効等）はフォールバックせず、その旨を明記して作業を停止し、人間の確認を仰ぐこと。**

**ブラウザ操作ツール（`mcp__claude-in-chrome__*`）で URL を開き、キャンバス上の要素のクリックやスクリーンショットの目視で値を推測して実装しないこと。** 値の取得手段は `Artifact` ツールのみ。実装後に、完成品とデザインのプレビューを並べて見た目の一致を確認する用途（セルフレビュー）に限り、ブラウザ操作ツールを使ってよい。

### デザインの作成・変更

デザインを新規に作る・変更するときは、Claude のチャットから指示する（Artifact のファイルを直接編集しない）。指示プロンプトは `docs/design-prompt-ui-*.md` に記録する。対象画面のデザインがまだ無い場合、自分でレイアウトや配色を創作せず、人間にデザイン作成を依頼する。

