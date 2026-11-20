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
- アプリ管理モデルは下記「アプリ管理モデル（#2）」を参照。以降の設計は GitHub issue で追加する。

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
| `depends_on` | list[str] | | 同一アプリ内の先に起動すべきサービス `id`。循環はエラー。起動は依存順、**停止は起動の逆順**（依存されている側を最後に止める）。再起動は停止→起動の順で行う |

### `kind: process`
| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `start` | list[str] | ○ | 起動コマンド（argv 配列。シェル経由にしない）。`${VAR}` は許可リスト（`LAN_IP` / `TAILSCALE_IP`）と定義済み `env` のみ展開 |
| `stop` | list[str] | | 停止コマンド。省略時は**プロセスグループ**に SIGTERM → `stop_timeout` 後 SIGKILL（`npm run start` など子プロセスを残さないため、thoth は `start_new_session` で起動し、グループ ID を保持する） |
| `stop_timeout` | int(秒) | | 既定 10 |
| `start_timeout` | int(秒) | | 既定 30。`pid_file` 指定時に起動コマンドの終了を待つ上限（`npm ci` / ビルドを行う起動スクリプトなどは長めにする） |
| `port` | int | | 待ち受けポート（死活判定・競合検知に使用） |
| `pid_file` | path | | あれば PID の正とする。無ければ thoth が起動したプロセスの PID を DB に保持 |
| `pid_match` | str | | `pid_file` 指定時のみ。PID ファイルの PID を thoth が初めて見るとき、コマンドラインにこの文字列を含まなければ別プロセスとみなす（古い PID ファイル対策） |
| `healthcheck` | Healthcheck | | 省略時は `port` があれば `tcp`、無ければ PID 生存のみ |

**PID の扱い**: thoth 再起動後に保持済み PID を使う際は、PID の再利用による誤 kill を防ぐため、プロセスの起動時刻を記録値と照合し、不一致なら「停止済み」とみなして kill しない（コマンドラインは `exec` で変わり得るため、記録・照合に使わない。他プロセスの引数に含まれる秘密を DB に残さないためでもある）。`pid_file` 指定時も同様に照合する。詳細は「プロセス制御（#5）」。

### `kind: scheduled`（launchd）
| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `launchd_label` | str | ○ | `launchctl` で参照するラベル |
| `plist` | path | | 指定時は `bootstrap` 対象のパス |
| `launchd_domain` | str | | launchd のドメイン。既定 `gui/<thoth を実行するユーザーの uid>`（`launchctl bootstrap/bootout/print` の対象） |
| `schedule` | str | | 表示用の説明（例: `毎日 03:00`）。実際のスケジュールは plist が正 |
| `expected_interval` | int(秒) | | 最終実行がこの間隔 ×1.5 を超えたら「遅延」と判定 |

起動/停止は `launchctl bootstrap/bootout`（`launchd_domain` 対象。`load/unload` は非推奨のため使わない）、状態は `launchctl print` / 終了コードと `log_paths` から判定する。

### Healthcheck
| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `type` | enum | | `tcp`（サービスの `port` に接続。`port` 必須）/ `http` / `pid`（thoth が把握する PID の生存）/ `command` |
| `url` | str | | `http` 用。ホストはループバック（`127.0.0.1` / `localhost`）、または `${LAN_IP}` / `${TAILSCALE_IP}`（選択中モードで解決されたもの）に限定。LAN/VPN モードでアプリが当該 IP にのみ bind する場合に対応する |
| `expect_status` | list[int] | `[200]` | `http` の期待ステータス |
| `command` | list[str] | | `command` 用。終了コード 0 を正常とする。argv 配列・`shell=False`。作業ディレクトリと環境変数は Service と同じ（`workdir` / マージ済み `env`、選択中モードの変数を含む） |
| `interval` | int(秒) | 30 | 実行間隔（1 以上） |
| `timeout` | int(秒) | 5 | 1 回のタイムアウト（`interval` 以下） |
| `start_grace` | int(秒) | 30 | 起動直後の猶予（この間の失敗は「起動中」扱い） |
| `failure_threshold` | int | 3 | 連続失敗でサービスを「異常」とする回数（1 以上） |

登録時（YAML 読み込み・再読み込み）に検証し、不正なものは拒否する（type に応じた必須/禁止キー、`expect_status` は 100〜599、`timeout <= interval`、`tcp` は `port` 必須、未知キーはエラー）。1 回分の実行は `thoth/health/probe.py`（http はリダイレクト非追従、command は `shell=False`。結果に応答本文・コマンド出力は含めない）。

### 定期実行と履歴（#12）
- backend の `lifespan` で常駐ループ（`thoth/health/monitor.py`）を動かし、process サービスごとに `healthcheck.interval` で `probe` を実行する。想定外の例外はログに残してループを継続する。thoth が稼働中と把握していないサービス（停止中）はチェックしない。
- 結果は `health_result`（`ok` / 定型 `message` / `checked_at`）に保存する。応答本文・コマンド出力は保存しない。保持期間は `config.yaml` の `health.retention_days`（既定 7 日）。起動時と 1 時間ごとに期限切れを削除する。
- 状態は保存済みの結果から求める: `healthy`（最新が成功）/ `starting`（失敗だが thoth の起動記録から `start_grace` 内）/ `unhealthy`（`failure_threshold` 回連続で失敗）/ `unknown`（結果が無い・最新が `interval` の 3 倍（下限 60 秒）より古い・停止中）。失敗が閾値未満の間は直前の成功を引き継ぎ `healthy`。
- `GET /api/service-health`（全 process サービスの状態）、`GET /api/service-health/{app_id}/{service_id}/history?limit=`（新しい順、既定 100・最大 500）。
- UI: アプリ一覧のサービス行に状態バッジ・最新メッセージ・最終チェック・「履歴」ボタン、アプリカードに集計バッジと異常アラート、履歴は右側 Sheet（推移ストリップ＋明細）。状態の取得は一覧の定期更新（5 秒）と同じ周期で、取得に失敗してもサービス操作は継続でき、ヘルス表示のみ「取得できません」にする。デザインは `docs/design-prompt-ui-health.md` の指示で更新したもの。

## 起動モード（local / LAN / VPN）
アプリ単位で選択する。`modes.<name>` は、そのモード選択時に Service の `start` / `env` へ渡す変数・環境変数を定義する。

```yaml
modes:
  local: {}                                  # 127.0.0.1 のみ
  lan:  { env: { LAN_IP: "${LAN_IP}" } }     # LAN 内に公開
  vpn:  { env: { TAILSCALE_IP: "${TAILSCALE_IP}" } }
```
- 排他ルール（既存アプリを踏襲）: **`LAN_IP` と `TAILSCALE_IP` は同時に設定しない**。判定は**選択中のモードが参照する変数**に対して行う。モード選択後に Service へ渡す環境変数（App/Service の `env` とモードの `env` をマージした結果）に `LAN_IP` と `TAILSCALE_IP` の両方が含まれる場合は、起動を拒否しエラーとする。`local` 選択時は両変数を Service に渡さない（thoth の環境に両方設定されていても拒否しない）。
- `${VAR}` の展開元は、thoth プロセスの環境変数のうち**許可リスト `LAN_IP` / `TAILSCALE_IP` のみ**と、当該 App/Service の `env` で定義したキーとする（それ以外の thoth の環境変数は参照不可、未定義はエラー）。`LAN_IP` / `TAILSCALE_IP` の値は thoth 起動時の環境変数から取得し、YAML に IP を直書きしない。未解決のモードは選択不可（UI で無効表示）。
- thoth 自身の backend は常に `127.0.0.1` 固定（#1）。モードは監視対象アプリにのみ作用する。
- 現在のモードは状態として DB に保存する（登録定義ではない）。

### モードの選択と IP の渡し方（#6）
- **IP の渡し方**: thoth を起動するシェルで `LAN_IP` / `TAILSCALE_IP` を環境変数として渡す。取得方法は例えば `LAN_IP=$(ipconfig getifaddr en0)` / `TAILSCALE_IP=$(tailscale ip -4)`。thoth 自身は IP を探索しない（外部コマンドを実行しない）。値は IP アドレス形式でなければ起動を拒否する（`0.0.0.0` / `::` / ループバック / マルチキャストも拒否）。
- **モードの切替**: `GET /api/apps/{id}/mode`（現在のモードと、各モードの `available` / `reason`）、`PUT /api/apps/{id}/mode`（ボディ `{"mode": "local|lan|vpn"}`、CSRF 対策必須）。未定義のモード・IP 未設定／不正・`LAN_IP` と `TAILSCALE_IP` の同時指定は 422。起動中のサービスがあれば 409（停止してから切り替える）。変更は次回起動から反映され、DB の `app_state` に保存する。既定は `local`。
- 待ち受けアドレスは、モードが `${LAN_IP}` 等として渡す env・argv をアプリ側が使って決める（thoth は値を渡すのみ）。

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
- アプリ数が増えた場合は `config/apps.d/*.yaml` を辞書順で追加読み込みできる（`apps.yaml` と同形式。`id` 重複はエラー。`apps.d/` も git 管理しない）。

### 読み込みと検証
- backend 起動時に pydantic モデル（`extra="forbid"`）で読み込む。**未知キー・型不一致・必須欠落はエラー**（#1 の設定ローダー方針と同じ）。
- 追加の意味検証: `id` 形式と一意性、`depends_on` の存在・循環、`kind` ごとの必須キー、ポート範囲（1–65535）と**アプリ・サービス間のポート重複**、`workdir` の存在、`healthcheck.url` のホスト限定（ループバック／`${LAN_IP}`・`${TAILSCALE_IP}`）、`start` / `stop` が空配列でないこと。エラーはファイル名・パス（例 `apps[0].services[1].port`）付きで列挙する。
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
- コマンドは argv 配列で `shell=False` 実行。`${VAR}` 展開は許可リスト（`LAN_IP` / `TAILSCALE_IP` と、定義済み `env` のキー）のみで、展開結果をシェルに渡さない。
- **CSRF 対策**: 変更系 API（POST/PUT/PATCH/DELETE）は、`Origin`（無ければ `Referer`）が thoth の frontend オリジン（`127.0.0.1:<frontend.port>` / `localhost:<frontend.port>`、および thoth の環境変数 `LAN_IP` / `TAILSCALE_IP` が有効な IP のとき `<その IP>:<frontend.port>`）と一致しない場合は 403 とし、あわせてカスタムヘッダ `X-Thoth-Request: 1` を必須とする。悪意ある Web ページからのクロスサイト POST で start/stop/reload を実行させないため。frontend の Route Handler がヘッダを付与して中継する。認証（#25）導入前の最低限の防御であり、認証導入後も維持する。
- 設定ファイル自体が実行権限を持つため、`config/` は所有者のみ書込可（`0600`/`0700` を推奨、起動時に group/other 書込可なら警告）。
- ログ・API 応答では環境変数の値を既定でマスクする（キー名のみ表示）。ヘルスチェック URL のホストはループバックと thoth 自身の許可リスト変数に限定し、SSRF を防ぐ。
- **認証（#25 との関係）**: 現段階の thoth は `127.0.0.1` 固定でローカル利用のみのため認証は設けない。ただし start/stop/reload など変更系 API は、認証導入時に保護対象として一括で扱えるよう、`/api/apps/{id}/services/{id}/(start|stop|restart)`、`/api/apps/{id}/(start|stop|restart)` と `/api/config/reload` に集約する。認証方式は #25 で決定する。LAN/VPN からの操作は、frontend を `LAN_IP` / `TAILSCALE_IP` で公開した場合にその Origin を CSRF で許可することで可能にしている（認証は無いため、信頼できるネットワークでのみ公開すること。backend は常に `127.0.0.1`）。

## 将来拡張
- `kind: cloud`: スキーマ上は予約。想定は `provider` / `endpoint` / `healthcheck`（http）/ 認証情報参照（env 名のみ）で、起動/停止は対象外（監視のみ）。実装時に別 issue で設計する。

# プロセス制御（#5）

`kind: process` のサービスを API から起動・停止・再起動する（実装: `backend/thoth/process/`、`backend/thoth/api/process.py`）。`kind: scheduled`（launchd）は対象外で、操作すると 400（アプリ単位の操作では `skipped`）。

## API
| メソッド・パス | 内容 |
|---|---|
| `GET /api/apps/{id}/status` / `GET /api/apps/{id}/services/{id}/status` | `state`（`running` / `stopped` / `unsupported`）、`pid`、PID の出所（`pid_file` / `thoth`）、実行中の操作（`busy`） |
| `POST /api/apps/{id}/services/{id}/(start\|stop\|restart)` | サービス単体。依存サービスは自動で操作しない |
| `POST /api/apps/{id}/(start\|stop\|restart)` | アプリ単位。起動は依存順、停止は逆順。既に起動中（停止中）のサービスは `skipped`。起動失敗で以降の起動を中断する。結果はサービスごとに `results` で返す |

- ステータス: 起動中に start / 停止中に stop / 全サービスが対象外の操作は **409**、別操作の実行中も 409。未登録の app・service は 404、設定不備（未定義の `${VAR}`、未定義モード、作業ディレクトリ無し）は 422、実行失敗（終了コード異常・タイムアウトなど）は 500。
- アプリ単位の応答は `{"results": [{service_id, action, result, message}]}`（成功は 200、1 つでも `error` なら 500 の `detail.results`、何も操作できなければ 409 の `detail.results`）。`result` は `ok` / `skipped` / `error`。結果はサービスごとに 1 件（`restart` も同様）。起動・再起動で失敗したサービスより後（依存される側が起動できない）は `skipped`、再起動で停止に失敗した場合は全サービスの起動を行わず `skipped`。
- エラーメッセージ・履歴には絶対パス・環境変数の値・例外の詳細を含めない（想定外の例外は定型文を返し、詳細はサーバーログのみ）。
- 変更系は CSRF 対策（Origin/Referer と `X-Thoth-Request: 1`）が必須。ボディは受け取らない。
- 操作は同期（完了までレスポンスを返さない）。`pid_file` 型の起動は `start_timeout` まで待つ。

## 起動の方式
- **常駐型**（`pid_file` 無し）: `start` のプロセス自体が対象。thoth は `start_new_session` で別セッション・別プロセスグループとして起動し、PID を DB（`service_process`）に記録する。起動直後に終了した場合は失敗。
- **起動スクリプト型**（`pid_file` あり。producer-desk の `bin/start.sh` など）: `start` が対象をバックグラウンド起動して終了する。thoth は終了コード 0 と PID ファイルが指す生存プロセスを確認して成功とする。`start_timeout` 内に終了しなければグループごと終了して失敗。
- 出力はパイプではなくログファイル `<log.dir>/apps/<app_id>.<service_id>.log`（ディレクトリ `0700`、ファイル `0600`。既存ファイルも矯正）へ直接書く。thoth が止まっても対象は詰まらない。5 MiB を超えていれば起動・停止のたびに `.log.1` へ 1 世代だけ退避する。
- 子プロセスの環境変数は thoth の環境を**そのまま引き継ぐ**（意図的。`PATH` 等が必要なため）が、`LAN_IP` / `TAILSCALE_IP` は選択中モードが参照した場合のみ渡す。`${VAR}` は環境変数の値（env）では「許可リスト変数 + `${` を含まない定義済み env」、`start` / `stop` の argv では定義済み env のみで展開する。

## 二重起動の防止・状態判定
1. `pid_file` があれば PID ファイルの PID、無ければ DB の記録を見て、生存（ゾンビ除く）かつ起動時刻が一致すれば「起動中」。
2. PID ファイルの PID を thoth が初めて見る場合は、次のいずれかに当てはまれば別物として扱う（以後、確認できたものは記録して起動時刻で照合）: PID ファイルの更新時刻（+2 秒の猶予。ps の起動時刻は秒精度）より後に始まったプロセス / thoth と別ユーザーのプロセス / `pid_match` が指定されていてコマンドラインに含まれない。**残存リスク**: PID ファイルより前から動いている同一ユーザーの無関係プロセスを指す古い PID ファイルは、`pid_match` を指定しない限り区別できない。`pid_file` を使うサービスには `pid_match` の指定を推奨する。
3. 停止中でも、`port`（`127.0.0.1` と選択中モードの IP）が待ち受け中なら起動を拒否する（thoth 管理外のプロセスを kill しない）。
4. 同一サービスの操作は排他。並行した操作は待たずに 409 とする。排他は thoth プロセス内のみ有効（backend は uvicorn 単一プロセス・単一インスタンス前提。複数 worker・複数インスタンスでの同時操作は防げない。ポート検査が補助になるが、`port` 無しのサービスは防げない）。

## 停止
- `stop` 指定あり: そのコマンドを `stop_timeout` 内に実行し、終了後もプロセスが残れば失敗（SIGKILL へはエスカレーションしない）。終了コード非 0 でもプロセスが止まっていれば成功（メッセージを履歴に残す）。
- `stop` 省略: 常駐型はプロセスグループ、`pid_file` 型は PID のみに SIGTERM → `stop_timeout` 後 SIGKILL（`pid_file` 型はグループを共有する別プロセスを巻き込まないため）。
- シグナル送信の直前に、起動時刻が状態判定時と同じか再確認する（入れ替わっていれば送らない）。
- `pkill` / `killall` / ポート検索での kill はしない。

## thoth 再起動
対象は thoth と別セッションで動くため、thoth が停止・再起動しても落ちない。再起動後は DB の記録と PID ファイルから状態を引き継ぐ。

## 記録
- `service_process`: PID と起動時刻（PID 再利用の照合用。コマンドラインは保存しない）。
- `service_operation`: 操作履歴（`action`、`status` = `succeeded` / `failed` / `rejected`、メッセージ、開始・終了時刻（UTC））。メッセージにコマンド引数・環境変数の値は含めない。

# 一括操作（#7）

全登録アプリを一括で起動・停止・再起動する（実装: `backend/thoth/api/bulk.py`）。アプリ単位の操作（#5）をアプリごとに順に呼び、結果を集約する。

- `POST /api/bulk/(start|stop|restart)?on_failure=continue|abort`（Origin/Referer と `X-Thoth-Request: 1` 必須、ボディなし）。
- **順序**: 起動・再起動はアプリ定義の登録順、停止は逆順。各アプリ内のサービスはアプリ単位操作どおり依存順（停止は逆順）。アプリ間の依存は持たない。
- **失敗時の挙動**: `on_failure` で選ぶ。既定 `continue`（アプリは互いに独立なので、失敗しても残りのアプリを処理する）。`abort` は最初に失敗したアプリ以降を実行せず `skipped`（`results` は空）とする。アプリ内で起動に失敗した場合に以降のサービスを起動しない挙動は #5 のまま。
- **応答**: 実行できた場合は常に 200。`status`（`ok` / `partial` / `failed`）で全体、`apps[].status`（`ok` / `error` / `skipped`）と `apps[].results`（サービスごとの `ok` / `skipped` / `error`、#5 と同じ）で個別の成否を返す。アプリ単位 API と違い、失敗しても 500 にしない（部分成功を情報として返すため）。全て起動中・停止中でも 409 にせず `skipped` とする。
- 1 アプリの想定外の例外は、そのアプリを `error`（定型メッセージ）とし、詳細はサーバーログのみ。他のアプリの処理は `on_failure` に従う。
- 操作は同期で、アプリごとの `start_timeout` / `stop_timeout` の合計だけ時間がかかり得る。

# フロントエンドのテーマとレイアウト（#3）

- UI は [cosmic-ui](https://github.com/rizznme/cosmic-ui)（サイバーパンク調）。npm パッケージではなく shadcn 方式で、コンポーネントのソースを `frontend/components/ui/` に取り込んでいる（`button` / `frame` / `sheet` / `portal` / `presence` / `alert-dialog` / `radio-group` / `toast`。Next.js 用に `"use client"` を付与）。`radio-group` は項目単位の `disabled` を通すよう最小限の変更を加えている（ファイル先頭のコメント参照）。取り込み元は `rizznme/cosmic-ui` の commit `fd06957`（2026-11-17 時点の HEAD）。追加が必要なら同リポジトリの `src/components/ui/` から同様に取り込み、ここの commit を更新する。npm の `cosmic-ui` は無関係の別パッケージなので使わない。
- **画面実装の方針**: Claude の Artifacts のデザインは UI の操作イメージ（画面構成・状態遷移・文言・操作フロー）を固めるためのもので、見た目の値は再現しない。画面は cosmic-ui のコンポーネントで実装し、独自のコンポーネント・CSS は極力作らない。cosmic-ui で実装できないものは、独自実装せず判断を仰ぐ（CLAUDE.md「画面デザインの実装ルール」）。
- スタイルは Tailwind CSS v4（`@tailwindcss/postcss`）。配色トークンは `app/globals.css` の `@theme`（`--color-primary` / `--color-accent` / `--color-background` など）。
- **ライト/ダーク切替は設けない（ダーク固定）**。サイバーパンク調はダーク前提のデザインで、1 名利用のため切替の必要性が低い。必要になれば `data-theme` + CSS 変数方式で別 issue とする。
- `AppShell`（`components/AppShell.tsx`）が全画面共通。ドロワーは制御コンポーネントで、リンク遷移時と md 以上へのリサイズ時に閉じる。キーボード操作のため `focus-visible` のフォーカス表示と「本文へスキップ」リンクを持つ。`md`（768px）以上は固定サイドバー、未満はヘッダー + ドロワー（`Sheet`）。ナビ項目は `lib/nav.ts`。
- 状態コンポーネント（`components/states.tsx`）: `LoadingState` / `EmptyState` / `ErrorState`。`app/loading.tsx` / `error.tsx` / `not-found.tsx` から使う。通常状態は各画面の本体。

# アプリ一覧・操作 UI（#8）

`/apps`（`frontend/app/apps/`、`frontend/components/AppsManager.tsx`、`frontend/components/apps/`）。デザイン Artifact の操作イメージ（画面構成・状態遷移・文言・操作フロー）をもとに、cosmic-ui のコンポーネントと Tailwind のユーティリティだけで実装している。独自の CSS ファイルは持たない。
- データは `/api/apps`・`/api/apps/{id}/status`・`/api/apps/{id}/mode` を 5 秒ごとにポーリング（タブ非表示中は停止、一時停止可）。操作はアプリ/サービス単位・一括（`on_failure` 選択）。停止・再起動・一括操作は確認ダイアログ（キャンセルが既定フォーカス）。
- 使用している cosmic-ui: `Button`（操作ボタン。操作ごとに `success` / `destructive` / `secondary`）、`RadioGroup`（起動モード・失敗時の挙動）、`AlertDialog`（確認ダイアログ。キャンセルが先頭で既定フォーカス。Esc・外側クリックでキャンセル。確認ボタンは停止・再起動が赤、起動が緑。`variant` を通すよう最小限の変更あり）、`Sheet`（一括操作の結果、モバイルのドロワー）、`Toast`（通知）。状態表示は `components/states.tsx`（`LoadingState` / `EmptyState` / `ErrorState`）。
- cosmic-ui に該当部品が無いもの（状態バッジ・スピナー、`components/apps/parts.tsx`）は、Tailwind のユーティリティによる最小限の小部品とした。
- 共通シェル（`AppShell`）: ロゴ・ナビ・エラー件数バッジ・更新コントロール（最終更新・更新・一時停止）・バックエンド接続表示・サイドバー折りたたみ（`localStorage` の `thoth.sidebar`）・モバイルヘッダー・ドロワー（`Sheet`）。ページは `ShellStatusProvider`（`components/shell/ShellStatus.tsx`）経由で更新状態と操作をシェルへ公開する。
- デザインとの差分（操作イメージ上の未実装）: 更新の進行バーは未実装（cosmic-ui に該当部品が無いため）。アプリ URL（API に無い）と一括操作のアプリごとの進捗バー（同期 API のため）は未実装。ダッシュボード/ログ/リソース画面の中身はデザイン対象外（別 issue）。
