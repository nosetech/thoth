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

# アプリ管理モデル（#2）

監視対象は構成が異なる（producer-desk: orchestrator / dashboard / litellm-proxy、deep-tracker: backend / frontend + launchd 定期ジョブ、focara: backend / frontend）。起動コマンドを直書きせず、YAML 設定で登録できる汎用モデルとする。

## 基本方針
- **登録定義は YAML を正**とする。DB は状態・履歴（ヘルスチェック結果、検知したエラー、リソース推移）のみ保存し、登録定義は DB に複製しない（DB 側は `app_id` / `service_id` 文字列で参照）。
- 起動/停止コマンドは設定ファイルでの登録のみ。UI・API からの自由入力は不可（UI は登録済みサービスの「起動/停止/再起動」操作のみ）。

## 階層
```
アプリ(App) ─┬─ サービス(Service, 1..N)
             └─ 起動モード(Mode)の選択（アプリ単位）
```

## スキーマ

### App
| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | str | ○ | 一意。`^[a-z][a-z0-9-]{0,31}$` |
| `name` | str | ○ | 表示名 |
| `description` | str | | 説明 |
| `workdir` | path | ○ | アプリのルート。サービスの既定作業ディレクトリ（絶対パス、`~` 展開可） |
| `env` | map[str,str] | | アプリ共通の環境変数 |
| `modes` | map | | 起動モード定義（後述）。省略時は `local` のみ |
| `services` | list[Service] | ○ | 1 件以上。`id` はアプリ内で一意 |

### Service（共通）
| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | str | ○ | アプリ内で一意 |
| `name` | str | | 表示名（省略時 `id`） |
| `kind` | enum | ○ | `process`（常駐プロセス）/ `scheduled`（launchd 定期ジョブ）/ `cloud`（将来用、現状は読み込み時にエラー） |
| `workdir` | path | | 省略時 App の `workdir`。相対パスは App の `workdir` 基準 |
| `env` | map[str,str] | | App の `env` にマージ（Service 側が優先） |
| `log_paths` | list[path] | | 監視対象ログ（エラー検知・表示用） |
| `depends_on` | list[str] | | 同一アプリ内の先に起動すべきサービス `id`。循環はエラー |

### `kind: process`
| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `start` | list[str] | ○ | 起動コマンド（argv 配列。シェル経由にしない）。`${VAR}` は env / モード変数のみ展開 |
| `stop` | list[str] | | 停止コマンド。省略時は PID に SIGTERM → `stop_timeout` 後 SIGKILL |
| `stop_timeout` | int(秒) | | 既定 10 |
| `port` | int | | 待ち受けポート（死活判定・競合検知に使用） |
| `pid_file` | path | | あれば PID の正とする。無ければ thoth が起動したプロセスの PID を `data/` 配下に保持 |
| `healthcheck` | Healthcheck | | 省略時は `port` があれば `tcp`、無ければ PID 生存のみ |

### `kind: scheduled`（launchd）
| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `launchd_label` | str | ○ | `launchctl` で参照するラベル |
| `plist` | path | | 指定時は load/unload 対象のパス |
| `schedule` | str | | 表示用の説明（例: `毎日 03:00`）。実際のスケジュールは plist が正 |
| `expected_interval` | int(秒) | | 最終実行がこの間隔 ×1.5 を超えたら「遅延」と判定 |

起動/停止は `launchctl load/unload`（または `bootstrap/bootout`）、状態は `launchctl print` / 終了コードと `log_paths` から判定する。

### Healthcheck
| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `type` | enum | | `tcp` / `http` / `command` |
| `url` | str | | `http` 用。ホストは `127.0.0.1` / `localhost` 等のループバックに限定 |
| `expect_status` | list[int] | `[200]` | `http` の期待ステータス |
| `command` | list[str] | | `command` 用。終了コード 0 を正常とする |
| `interval` | int(秒) | 30 | 実行間隔 |
| `timeout` | int(秒) | 5 | 1 回のタイムアウト |
| `start_grace` | int(秒) | 30 | 起動直後の猶予（この間の失敗は「起動中」扱い） |
| `failure_threshold` | int | 3 | 連続失敗でサービスを「異常」とする回数 |

## 起動モード（local / LAN / VPN）
アプリ単位で選択する。`modes.<name>` は、そのモード選択時に Service の `start` / `env` へ渡す変数・環境変数を定義する。

```yaml
modes:
  local: {}                                  # 127.0.0.1 のみ
  lan:  { env: { LAN_IP: "${LAN_IP}" } }     # LAN 内に公開
  vpn:  { env: { TAILSCALE_IP: "${TAILSCALE_IP}" } }
```
- 排他ルール（既存アプリを踏襲）: **`LAN_IP` と `TAILSCALE_IP` は同時に設定しない**。`lan` と `vpn` は排他で、両方の変数が解決された場合は起動を拒否しエラーとする。
- `LAN_IP` / `TAILSCALE_IP` の値は thoth 起動時の環境変数から取得し、YAML に IP を直書きしない。未解決のモードは選択不可（UI で無効表示）。
- thoth 自身の backend は常に `127.0.0.1` 固定（#1）。モードは監視対象アプリにのみ作用する。
- 現在のモードは状態として DB に保存する（登録定義ではない）。

## 3 アプリの表現例
```yaml
apps:
  - id: producer-desk
    name: producer-desk
    workdir: ~/repo/producer-desk
    modes: { local: {}, lan: { env: { LAN_IP: "${LAN_IP}" } }, vpn: { env: { TAILSCALE_IP: "${TAILSCALE_IP}" } } }
    services:
      - { id: orchestrator, kind: process, start: [./bin/orchestrator], port: 8787,
          healthcheck: { type: http, url: "http://127.0.0.1:8787/health" } }
      - { id: dashboard, kind: process, start: [npm, run, start], workdir: dashboard, port: 3000,
          depends_on: [orchestrator] }
      - { id: litellm-proxy, kind: process, start: [./bin/litellm-proxy], port: 4000 }
  - id: deep-tracker
    name: deep-tracker
    workdir: ~/repo/deep-tracker
    services:
      - { id: backend, kind: process, start: [uv, run, python, -m, app.main], workdir: backend, port: 8700 }
      - { id: frontend, kind: process, start: [npm, run, start], workdir: frontend, port: 3700, depends_on: [backend] }
      - { id: daily-job, kind: scheduled, launchd_label: com.example.deep-tracker.daily,
          schedule: "毎日 03:00", expected_interval: 86400 }
  - id: focara
    name: focara
    workdir: ~/repo/focara
    services:
      - { id: backend, kind: process, start: [uv, run, python, -m, focara.main], workdir: backend, port: 8800 }
      - { id: frontend, kind: process, start: [npm, run, start], workdir: frontend, port: 3800, depends_on: [backend] }
```
（コマンド・ラベルは例。実際の値は各アプリのリポジトリに合わせて登録する。）

## YAML 設定の扱い

### ファイル配置
- 本体設定 `config/config.yaml` に加え、アプリ定義は `config/apps.yaml`（雛形 `config/apps.yaml.example` をコミット、実ファイルは git 管理しない）。最上位キーは `apps:`。
- アプリ数が増えた場合は `config/apps.d/*.yaml` を辞書順で追加読み込みできる（`apps.yaml` と同形式。`id` 重複はエラー）。

### 読み込みと検証
- backend 起動時に pydantic モデル（`extra="forbid"`）で読み込む。**未知キー・型不一致・必須欠落はエラー**（#1 の設定ローダー方針と同じ）。
- 追加の意味検証: `id` 形式と一意性、`depends_on` の存在・循環、`kind` ごとの必須キー、ポート範囲（1–65535）と**アプリ・サービス間のポート重複**、`workdir` の存在、`healthcheck.url` のループバック限定、`start` / `stop` が空配列でないこと。エラーはファイル名・パス（例 `apps[0].services[1].port`）付きで列挙する。
- 起動時に検証失敗の場合は backend を起動しない（既存定義を壊したまま動かさない）。

### 再読み込み
- 変更検知は mtime ポーリングではなく、**明示的な再読み込み**（`POST /api/config/reload`、CLI `python -m thoth.main reload` のいずれも可）。
- 再読み込みは「全体を検証 → 成功時のみ原子的に差し替え」。失敗時は旧定義を維持し、エラー内容を返す。
- 実行中サービスの定義が変わっても自動で再起動しない（差分を「再起動で反映」として UI に表示）。削除されたアプリ/サービスの履歴は DB に残し、「未登録」として扱う。
- `config.yaml` 本体の変更（ポート・DB パス等）は従来どおり再起動が必要。

### DB との分担
| 場所 | 内容 |
|---|---|
| YAML | アプリ・サービス定義、ヘルスチェック設定、モード定義 |
| DB | ヘルスチェック結果、検知エラー、リソース推移、現在のモード選択、操作履歴 |

## セキュリティ方針
- **起動コマンドは設定ファイルでの登録のみ**。API は `app_id` / `service_id` と操作種別（start/stop/restart）しか受け取らず、コマンド文字列・環境変数・作業ディレクトリを入力として受け付けない。
- コマンドは argv 配列で `shell=False` 実行。`${VAR}` 展開は許可リスト（env / モード変数）のみで、展開結果をシェルに渡さない。
- 設定ファイル自体が実行権限を持つため、`config/` は所有者のみ書込可（`0600`/`0700` を推奨、起動時に group/other 書込可なら警告）。
- ログ・API 応答では環境変数の値を既定でマスクする（キー名のみ表示）。ヘルスチェック URL はループバックに限定し、SSRF を防ぐ。
- **認証（#25 との関係）**: 現段階の thoth は `127.0.0.1` 固定でローカル利用のみのため認証は設けない。ただし start/stop/reload など変更系 API は、認証導入時に保護対象として一括で扱えるよう、`/api/apps/{id}/services/{id}/(start|stop|restart)` と `/api/config/reload` に集約する。LAN/VPN 公開や認証方式は #25 で決定し、それまでは thoth 自身を `127.0.0.1` 以外へ公開しない。

## 将来拡張
- `kind: cloud`: スキーマ上は予約。想定は `provider` / `endpoint` / `healthcheck`（http）/ 認証情報参照（env 名のみ）で、起動/停止は対象外（監視のみ）。実装時に別 issue で設計する。
