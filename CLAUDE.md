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
- 自動再起動（#13）: サービスの `auto_restart` を指定したものだけ。手動停止したものは再起動しない。`GET /api/auto-restart` で状況を返す。詳細は `docs/architecture.md`「自動再起動（#13）」。

## 画面デザインの実装ルール

Claude の Artifacts にあるデザインは、**UI の操作イメージ（レイアウト・状態遷移・文言・操作フロー）を固めるためのもの**であり、見た目（色・余白・border-radius・フォント・アニメーションなどの値）を忠実に再現する対象ではない。画面は、Artifact のデザインをもとに **cosmic-ui のコンポーネントを使って**実装する。

- **cosmic-ui を最優先で使う。** 独自のコンポーネント・独自の CSS は極力作らない。必要な部品は cosmic-ui から取り込む（取り込み手順は `docs/architecture.md`「フロントエンドのテーマとレイアウト（#3）」。取り込み元は `rizznme/cosmic-ui`。npm の `cosmic-ui` は無関係の別パッケージなので使わない）。
- **cosmic-ui で実装できないものは、自分で作らず判断を仰ぐ。** 該当する部品・表現が無い場合は、何が足りないか・代替案（cosmic-ui の組み合わせ、独自実装、デザイン側の変更）を示して人間に確認する。確認が取れるまで独自実装を進めない。
- Artifact の値（色・余白など）を `globals.css` や独自 CSS に移植しない。見た目は cosmic-ui のテーマ・コンポーネントに従う。デザインと cosmic-ui の見た目が違っても、Artifact に合わせるために独自 CSS を足さない（どうしても必要なら判断を仰ぐ）。
- デザイン（アプリ一覧・操作 UI、#8）: https://claude.ai/artifact/3z5oGchGZ3Z6JKKooaVLy5（アーティファクト名「thoth — アプリ管理 UI プロトタイプ」。一覧は https://claude.ai/artifacts）
- 主なファイル: `index.html`（約107KB。スタイル・コンポーネント・状態ロジックを1ファイルに含む単一ページ。React はコンパイル済みの `React.createElement` 形式。cosmic-ui は使っておらず、独自 CSS で cosmic-ui 風にしたモック）。`Artifact` の `list`（`scope: "files"`）で実在を確認し、ファイルが増えた・分割された場合はすべて読む。
- 元になった指示プロンプトは `docs/design-prompt-ui-apps.md`（ヘルスチェックの状態・履歴表示 #12 は `docs/design-prompt-ui-health.md`、自動再起動の状態表示 #13 は `docs/design-prompt-ui-auto-restart.md` で追記。`index.html` は約156KBになった）。デザインと `docs/` や issue の仕様に齟齬がある場合は、実装前にどちらを正とするか確認する。デザインが更新されたら、この節の URL・ファイル一覧も更新する。
- デザインのモックは単一 HTML のプロトタイプ。ダミーデータ・デモ用スイッチ（画面状態の切替、失敗の強制）・仮画面（ログ・リソース）は**実装に含めない**。画面構成・状態遷移・文言・操作フローを移植し、データは `/api/*` から取得する。
- 実装は既存の基盤（`docs/architecture.md`「フロントエンドのテーマとレイアウト（#3）」: Tailwind v4・cosmic-ui・`AppShell`）の上で行う。

**重要**: 上記 URL は `claude.ai` の認証が必要なページで、`WebFetch` では取得できない。

**実装・レビュー時は `Artifact` ツールでデザインの実ソースを直接取得し、画面構成・状態遷移・文言・操作フローを確認してから実装すること。**

1. `Artifact` の `action: "list"`、`scope: "files"`、`url` に上記 URL を指定してファイル一覧を取得する
2. `action: "read"`、`url`、`path` でファイルを取得する（複数は `paths` でまとめて取得できる。取得したファイルはスクラッチパッド配下に保存されるので、そこから対象コンポーネントの構成・状態ロジックを検索して読む）
3. **取得結果が途中で欠けていないか必ず確認する。** 欠けて対象の画面・状態の定義を取りこぼした可能性があるときは、取得できた範囲だけで実装を進めず、その旨を明記して作業を停止し、Claude のチャットでのファイル分割を人間に依頼する

`Artifact` ツールの利用には `claude.ai` アカウントでの `/login` が必要。`claude -p`（ヘッドレス）では既定で無効なので、`CLAUDE_CODE_ARTIFACT=1` で有効化する。**`Artifact` ツールが使えない場合（未ログイン・ツール無効等）はフォールバックせず、その旨を明記して作業を停止し、人間の確認を仰ぐこと。**

ブラウザ操作ツール（`mcp__claude-in-chrome__*`）は、デザインの操作イメージの確認や、完成品との比較（セルフレビュー）に使ってよい。ただし値の取得元にはしない（見た目は cosmic-ui に従う）。

### デザインの作成・変更

デザインを新規に作る・変更するときは、Claude のチャットから指示する（Artifact のファイルを直接編集しない）。指示プロンプトは `docs/design-prompt-ui-*.md` に記録する。対象画面のデザインがまだ無い場合、自分でレイアウトや配色を創作せず、人間にデザイン作成を依頼する。

