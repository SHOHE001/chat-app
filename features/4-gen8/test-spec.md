# test-spec: #4 デプロイ: gen8常駐起動＋モバイル/低スペック対応の仕上げ

対象実装: `src/server.js`（`resolveConfig` / `parsePort`）、`.env.example`、`public/style.css`、`package.json`、`deploy/chat-app.service`、`README.md`
テストファイル: `tests/deploy.test.js`（`node --test`）

## 自動テスト（実装済み・全 pass）

| ID | テスト関数名（tests/deploy.test.js） | 検証内容 | 結果 |
|---|---|---|---|
| T01 | `T01 resolveConfig: 全 env を渡すと各値が反映される` | 全 env → `{port:8080, host:'127.0.0.1', dbPath:'/tmp/x.db', adminPassword:'secret'}` | pass |
| T02_boundary | `T02_boundary resolveConfig: env 未設定なら既定値` | `resolveConfig({})` → `{port:3000, host:'0.0.0.0', dbPath:'data/chat.db', adminPassword:undefined}` | pass |
| T03_boundary | `T03_boundary resolveConfig: ADMIN_PASSWORD 空文字は undefined 正規化` | `ADMIN_PASSWORD:''` → `adminPassword === undefined` | pass |
| T04 | `T04 .env.example が resolveConfig 参照キーを網羅` | `.env.example` に PORT/HOST/DB_PATH/ADMIN_PASSWORD が存在 | pass |
| T05_boundary | `T05_boundary resolveConfig: 不正 PORT は throw（fail-fast）` | `'abc'/'0'/'65536'/'-1'/'12.5'` は throw | pass |
| T05b_boundary | `T05b_boundary resolveConfig: 前後空白付き/空白のみ PORT` | `' 8080 '`→8080、`'   '`→3000 | pass |
| T06 | `T06 admin 有効/無効の回帰（createChatServer 経由）` | (a) 未設定→`admin_disabled` (b) 正合言葉→`admin_auth_ok` (c) 誤り→`bad_admin_password` | pass |

`node --test` 全体: **36 pass / 0 fail / 0 skip**（既存 chat/rooms/threads 含む）。

## 期待値乖離チェック

`check-spec-divergence.mjs --plan-file features/4-gen8/plan.md` → `divergences: 0`（exit 0）。
※同ツールの "missing impls" は false positive（`git diff main...HEAD` 前提で未コミットの `tests/deploy.test.js` を走査できず、かつ検出正規表現が `node:test` の `test('...')` 形式に非対応）。実テストは上表のとおり全 pass で存在する。

## 手動/実地検証（orchestrator が本セッションで実施）

- **fail-fast**: `PORT=0 node src/server.js` → `Error: PORT が範囲外です（1-65535）: 0` を出し exit 1。✓
- **CWD 非依存の静的配信**: `/tmp` から `node <repo>/src/server.js`（module 相対 staticDir）で起動 → `GET /`・`/style.css`・`/app.js` すべて HTTP 200、DB は絶対 `DB_PATH` に生成。✓
- **`--env-file-if-exists`**: Node 22.22.3 に存在することを `node --help` で確認。✓
- **env 優先順位**: `FOO=a node --env-file=.env -e 'console.log(process.env.FOO)'`（`.env` に FOO=b）→ `a`。OS env が `.env` を上書きしないことを実測（README に記載）。✓

## 未実施（環境制約・要人間確認）

- **ブラウザ実測レスポンシブ**: gen8 に playwright/chromium ドライバが無く、360px での `scrollWidth<=innerWidth` 自動判定は本セッションで実行不可。静的 CSS 解析＋`html,body{overflow-x:hidden}` の防御ガードで対応。responsive モードでの目視確認は人間側の任意チェックとして残る。
- **systemd 実インストール**: `sudo systemctl` はシステム変更のため無人セッションでは実行せず。unit テンプレートは設計・静的検証済み（`WorkingDirectory` 経由の CWD 制御は上記の別 CWD 起動で実証）。
