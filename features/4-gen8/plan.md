# plan: #4 デプロイ: gen8常駐起動＋モバイル/低スペック対応の仕上げ

slug: gen8
milestone: Phase 1
labels: type:feature, batch:feature

## In-Scope / Out-of-Scope

| In-Scope | Out-of-Scope |
|---|---|
| `PORT`（1-65535 検証付き）/ `HOST` / `DB_PATH` / `ADMIN_PASSWORD` の env 化と `.env.example` | 認証・認可の新規追加（管理者合言葉は既存踏襲） |
| `.env` ロードは起動コマンド側（`node --env-file-if-exists`）に寄せる | Docker / コンテナ化（systemd を採用） |
| `staticDir` を CWD 非依存（モジュール相対）に解決 | HTTPS / リバースプロキシ設定（本体スコープ外） |
| systemd unit テンプレート（常駐・自動再起動・boot 復帰） | 親の監視機能・モデレーション（Phase 2 以降） |
| スマホ幅（〜400px）の実測レスポンシブ調整（横スクロール検査） | 実機（スマホ・シンクライアント）での動作確認 |
| README（セットアップ・env・systemd・綾瀬移行手順） | ビルドツール導入によるアセット圧縮（依存ゼロ構成を維持） |
| `resolveConfig` 単体テスト＋admin 有効/無効の回帰テスト | Playwright テストの suite 常設（依存ゼロ維持のため verify 一度きり） |
| — | Unix domain socket 文字列 PORT の後方互換（TCP ポートのみ対応） |

## Non-Goals

- 認証・ネットワークハードニング（bind 先の制限、fail2ban 等）は本 Issue では扱わない。既存の「合言葉で管理者昇格」以上のアクセス制御は追加しない。
- CSS フレームワーク・バンドラ・minifier の導入はしない。アセット最小化は「依存ゼロ・ビルドレスを維持する」ことで達成し、README に明記するに留める。
- 綾瀬サーバーへの実際の移行作業は行わない（手順の文書化のみ）。

## 設計方針

### 1. Config の env 化（`src/server.js`）

現状 main-module ブロック（`isMainModule` 内）に散在する設定解決を、純粋関数 `resolveConfig(env = process.env)` に抽出して **export** する。これにより env → 設定値のマッピングが単体テスト可能になる。**PORT は 1-65535 の整数を検証し、不正値は明示エラーで throw して fail-fast する**（設計レビュー採用: `Number('abc')=NaN` を `listen` に渡すと `Restart=always` でクラッシュループになる実バグを防ぐ）。

```js
export function resolveConfig(env = process.env) {
  const port = parsePort(env.PORT);
  const host = env.HOST && env.HOST !== '' ? env.HOST : '0.0.0.0';
  const dbPath = env.DB_PATH && env.DB_PATH !== '' ? env.DB_PATH : 'data/chat.db';
  const adminPassword =
    env.ADMIN_PASSWORD === undefined || env.ADMIN_PASSWORD === '' ? undefined : env.ADMIN_PASSWORD;
  return { port, host, dbPath, adminPassword };
}

// 未設定/空/空白のみ → 3000。設定ありは 1-65535 の整数のみ受理。それ以外は throw（fail-fast）。
// env ファイル由来の前後空白は許容（trim）。小数・符号・非数字は拒否。
function parsePort(raw) {
  if (raw === undefined) return 3000;
  const trimmed = String(raw).trim();
  if (trimmed === '') return 3000;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`PORT が不正です（1-65535 の整数を指定してください）: ${raw}`);
  }
  const n = Number(trimmed);
  if (n < 1 || n > 65535) {
    throw new Error(`PORT が範囲外です（1-65535）: ${raw}`);
  }
  return n;
}
```

- `DB_PATH`: 現状 `dbPath = 'data/chat.db'`（ハードコード）を env 化。これが本 Issue の「コード中の環境依存排除」の核。相対パスは **CWD 基準**（後述の非対称性を README/テスト名で明示）。
- `HOST`: 現状 `listen(PORT)` は全 interface bind。挙動を保ちつつ既定 `'0.0.0.0'` を明示。綾瀬移行時に bind 先を絞る余地を残す。
- `ADMIN_PASSWORD`: 空文字は「未設定（admin 無効）」に正規化。既存 server.js の `if (!adminPassword)` 判定（L324）と挙動一致。
- `PORT`: 未設定/空 → 3000。設定ありは 1-65535 の整数のみ受理し、不正・範囲外は throw。Unix socket 文字列は非対応（TCP ポートのみ）。

### 2. `.env` ロード方針と staticDir

設計レビューを受け、**アプリコードから `.env` 探索・ロードを排除**し、起動コマンド側に一本化する（二重ロード・優先順位の曖昧さを解消）。

- **ローカル/手動起動**: `npm start` = `node --env-file-if-exists=.env src/server.js`（Node 22.9+ 標準フラグ。`.env` 未存在でもエラーにならない）。
- **本番 systemd**: unit の `EnvironmentFile=-__INSTALL_DIR__/.env`（先頭 `-` で `.env` 欠損時も起動失敗しない）で env を注入。ExecStart は素の `node src/server.js`。
- **優先順位**: 既に環境に設定済みの変数（OS/systemd env）が最優先。`.env` は未設定値のみ補完する（`--env-file` / systemd `EnvironmentFile` 双方の挙動。実装時に `node --env-file` の上書き挙動を実測して README に明記する）。

main-module ブロックを以下に置換（`.env` ロードは持たない）：

```js
if (isMainModule) {
  checkNodeVersion();
  const { port, host, dbPath, adminPassword } = resolveConfig();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const app = createChatServer({ dbPath, staticDir, adminPassword });
  app.server.listen(port, host, () => {
    console.log(`chat-app: listening on http://${host}:${port}`);
  });
}
```

- `staticDir` をモジュール（`src/`）相対に解決 → systemd の `WorkingDirectory` に依存せず `public/`（= 同梱アセット・読み取り専用）を確実に見つける（現状 `'public'` は CWD 相対で脆い）。
- **DB_PATH（可変データ）は CWD 相対のまま**にする。同梱アセットの staticDir をモジュール相対にする一方 DB を CWD 相対に残す非対称は意図的（読み取り専用アセット vs 書き込みデータで基準が異なる）。systemd では `WorkingDirectory=__INSTALL_DIR__` が DB 保存先を決めることを README とテスト名（`DB_PATH は CWD 基準` 等）で明示する。本番は絶対パス指定を推奨。

### 3. `.env.example`（plain KEY=value）

systemd `EnvironmentFile` と `process.loadEnvFile` の両方で読める最小構文（`export` なし・クオートなし・コメントは `#`）。

```
# chat-app 設定サンプル。cp .env.example .env して値を編集する。
# HTTP/WebSocket ポート
PORT=3000
# bind アドレス（0.0.0.0=全 interface / 127.0.0.1=ローカルのみ）
HOST=0.0.0.0
# SQLite DB ファイルのパス（相対は起動時 CWD 基準）
DB_PATH=data/chat.db
# 管理者昇格の合言葉。空なら管理者機能は無効
ADMIN_PASSWORD=
```

`.gitignore` に `.env` を追加（現状 `*.db` / `data/` はあるが `.env` がない）。

### 4. systemd unit テンプレート（`deploy/chat-app.service`）

```ini
[Unit]
Description=chat-app (question chat MVP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# __INSTALL_DIR__ / __NODE_BIN__ は README の手順で実値に置換する
WorkingDirectory=__INSTALL_DIR__
# 先頭 '-' で .env 欠損時も起動失敗しない（存在すれば env を注入）
EnvironmentFile=-__INSTALL_DIR__/.env
ExecStart=__NODE_BIN__ src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

- `Restart=always` + `WantedBy=multi-user.target` で「クラッシュ復帰」と「マシン再起動後の自動起動」の両方を満たす。
- `EnvironmentFile=-`（先頭 `-`）で `.env` 未作成でも service 起動が失敗しない（設計レビュー採用）。既定値で立ち上がる。
- パス（`__INSTALL_DIR__` / `__NODE_BIN__`）は環境依存なのでプレースホルダにし、README に `sed` 置換の一行を書く。綾瀬移行時もここだけ変えれば済む。
- `npm start` は `node --env-file-if-exists=.env src/server.js` に更新する（`package.json` の scripts）。

### 5. レスポンシブ（〜400px）

**環境制約**: 本 gen8（ヘッドレス）には playwright / chromium ドライバがインストールされておらず、ブラウザ実測（scrollWidth 自動判定）は本セッションでは実行不可。代わりに静的 CSS 解析＋定石の防御ガードで対応し、report に「ブラウザ実測は未実施（環境にドライバなし）」と明記する。

静的解析の結果、既存 CSS はモバイル前提で概ね健全（サイドバー/スレッドはオーバーレイ開閉式・`max-width: 80%/90%` で開いても viewport 幅を超えない、input は 16px で iOS ズーム回避済み）。ただしオフキャンバス drawer（`position: fixed` + `translateX` で画面外退避）は狭幅で**水平スクロールを誘発しうる既知パターン**なので、防御として `html, body { overflow-x: hidden; }` を追加する（デスクトップ ≥768px では panel が static になり無害。機能的副作用なし）。**推測で追加の見た目調整（padding 圧縮等）はしない**。この一点のみに絞る。

### 6. README

現行 README は 2 行（内容説明のみ）で失う情報がないため実質新規に近いが、**破壊的置換ではなく必要章の追加**として扱う。記載章：概要 / 必要要件（Node >=22.22.3 とその理由）/ セットアップ / 環境変数一覧（PORT/HOST/DB_PATH/ADMIN_PASSWORD）/ 起動（`npm start`）/ テスト（`npm test`）/ systemd 常駐（`sed` 置換・enable・start・journalctl）/ 綾瀬サーバー移行手順 / アセット方針（依存ゼロ・ビルドレス）。DB_PATH の CWD 相対と絶対パス推奨も明記。

## 実装対象

- `src/server.js`
  - **追加**: `export function resolveConfig(env)`
  - **before**（L463-473）:
    ```js
    if (isMainModule) {
      checkNodeVersion();
      const PORT = process.env.PORT ?? 3000;
      const dbPath = 'data/chat.db';
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const app = createChatServer({ dbPath, staticDir: 'public', adminPassword: process.env.ADMIN_PASSWORD });
      app.server.listen(PORT, () => {
        console.log(`chat-app: listening on http://localhost:${PORT}`);
      });
    }
    ```
  - **after**: 上記「2.」のブロック（resolveConfig 利用・`.env` ロードなし・module 相対 staticDir・`listen(port, host)`）
- `package.json`（`start` を `node --env-file-if-exists=.env src/server.js` に更新）
- `.env.example`（新規）
- `.gitignore`（`.env` 追記）
- `deploy/chat-app.service`（新規）
- `public/style.css`（`@media (max-width: 400px)` 追記、実測後）
- `README.md`（章追加。既存 2 行は破壊しない）
- `tests/deploy.test.js`（新規、`resolveConfig` / `.env.example` 整合 / admin 挙動回帰）

## テスト計画

| ID | 内容 | 期待値 |
|---|---|---|
| T01 | `resolveConfig` に全 env（PORT=8080, HOST=127.0.0.1, DB_PATH=/tmp/x.db, ADMIN_PASSWORD=secret）を渡す | `{ port: 8080, host: '127.0.0.1', dbPath: '/tmp/x.db', adminPassword: 'secret' }` |
| T02_boundary | `resolveConfig({})`（全 env 未設定） | `{ port: 3000, host: '0.0.0.0', dbPath: 'data/chat.db', adminPassword: undefined }` |
| T03_boundary | `ADMIN_PASSWORD=''`（空文字）を渡す | `adminPassword === undefined`（既存の admin 無効挙動と一致） |
| T04 | `.env.example` を読み、`resolveConfig` が参照する全キー（PORT/HOST/DB_PATH/ADMIN_PASSWORD）が記載されているか | 4 キーすべてが `.env.example` に存在 |
| T05_boundary | 不正 PORT（`'abc'` / `'0'` / `'65536'` / `'-1'` / `'12.5'`）を渡す | いずれも `resolveConfig` が throw する |
| T05b_boundary | 前後空白付き PORT（`' 8080 '`）と空白のみ（`'   '`） | `' 8080 '`→port 8080（trim 許容）、`'   '`→port 3000（既定） |
| T06 | admin 挙動回帰（既存 harness で `createChatServer` 起動）: (a) adminPassword 未設定で `admin_auth` → `error/admin_disabled`、(b) 設定あり＋正しい合言葉で `admin_auth_ok`、(c) 設定あり＋誤り→ `error/bad_admin_password` | (a)(b)(c) 各期待どおり |

## Issue body 抜粋

## 背景

質問チャット MVP の仕上げ。gen8（Ubuntu Server 24.04）で常駐運用できるようにし、将来の綾瀬サーバー移行に備えて環境依存を減らす。

依存: コア・ルーム・スレッドの 3 Issue 完了後に着手。

## やること

- 設定の env 化（ポート、DB パス、`ADMIN_PASSWORD` など。`.env.example` を用意）
- systemd unit（または Docker）での常駐起動と自動再起動
- スマホ幅（〜400px）でのレスポンシブ最終調整、低スペック PC 向けにアセット最小化
- セットアップ・起動・移行手順の README 化（綾瀬サーバーへの移行手順を含む）

## 決定事項（intake 時点で確定）

- デプロイ先はまず gen8。将来は綾瀬にあるサーバーへ移行するため、パス・ポート等はすべて env で注入できるようにする
- 実機（スマホ・シンクライアント）での動作確認は不要（ユーザー判断）。ブラウザの responsive モード確認まででよい
- 親の監視機能・モデレーションは本 Issue のスコープ外（Phase 2 以降で別途検討）

## 完了条件

- [ ] gen8 上で常駐起動し、再起動後も自動で復帰する
- [ ] 設定がすべて環境変数で注入でき、コード中にハードコードされた環境依存がない
- [ ] スマホ幅の表示崩れがない（responsive モードで確認）
- [ ] README にセットアップ・起動・綾瀬サーバー移行の手順が書かれている
