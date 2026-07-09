# plan: #1 コア: ニックネーム参加＋単一ルームのリアルタイムチャット

slug: core-realtime-chat
milestone: Phase 1
labels: type:feature, batch:feature

## In-Scope / Out-of-Scope

| In-Scope | Out-of-Scope |
|---|---|
| Node.js + `ws` + SQLite サーバー骨格（HTTP 静的配信 + WebSocket 同一ポート） | Express などの重量フレームワーク導入 |
| DB スキーマ users / rooms / messages と起動時のデフォルトルーム "全体" 投入 | 複数ルーム作成・削除・切替（Issue #2） |
| ニックネーム入力 → 入室（認証なし、localStorage 保持） | スレッド機能（Issue #3） |
| 単一ルームでの WebSocket リアルタイム送受信 | gen8 常駐起動・デプロイ仕上げ（Issue #4） |
| 入室時の直近メッセージ履歴表示 | 親の監視 / モデレーション / プッシュ通知 / ファイル添付 |
| acceptance test（WS 送受信・履歴・永続化・境界） | ニックネームのサーバー側一意性強制・本人性検証 |

## Non-Goals

- 認証・ログイン（ニックネームのみ、メールアドレス前提にしない）
- 複数ルーム / スレッド / 管理者機能（後続 Issue #2〜#4）
- XSS 以外の高度なモデレーション、レート制限の厳密なチューニング（最低限の防御のみ実装）

## 設計方針

- **依存を最小化する**。DB は native module（ビルドが必要な `better-sqlite3` 等）を避け、Node v22.5+ 標準の `node:sqlite`（同期 API、追加ビルド不要）を使う。ランタイム依存は `ws` のみ。gen8/綾瀬への移行で「環境依存を減らす」方針に合致。
- **Node バージョン固定（migration/architect 高指摘反映、round 3 で全箇所統一）**: `node:sqlite` は v22.5 で追加されたが、**22.5〜一部の 22.x では `--experimental-sqlite` フラグが必要**だった（フラグが外れた正確なカットオフ版は推測しない）。フラグ運用を避けるため、`package.json` の `"engines": { "node": ">=22.22.3" }` とし、**下限を「フラグなしで動作を実測した版」（v22.22.3、gen8 の現行 Node）ちょうどに合わせる**（22.22.0〜.2 は未検証のため下限に含めない）。これで許容範囲すべてでフラグ不要になり `start` / `test` が素の `node` で成立する（`>=22.5.0` だとフラグ必須版を含み `npm start` が壊れ得る、という round 2/3 指摘への恒久対処）。**この下限値は 設計方針・実装対象・完了条件すべてで `>=22.22.3` に統一する**。`start` は `node src/server.js`、`test` は `node --test`。`node:sqlite` は ExperimentalWarning を stderr に出すのみで exit code 0、テスト green 判定に影響しない。
  - **これは gen8 常駐を主対象とするアプリの現行環境に engines を寄せる判断**（architect 指摘: 環境固有値を public contract にする根拠の明示）。同値を `.nvmrc`（`22.22.3`）にも置き、開発/CI/デプロイの Node を一本化する。
  - **engines は npm では警告止まりで実行前ガードにならない**（contrarian 指摘）。よって `src/server.js` の起動パス冒頭で `process.versions.node` を検査し、`22.22.3` 未満なら分かりやすいメッセージで `process.exit(1)` する実行時ガードを入れる（`.npmrc engine-strict` には依存しない）。
- **モジュール形式は ESM に確定（architect/contrarian/migration 指摘反映）**: `package.json` に `"type": "module"` を置き、`src/db.js` / `src/server.js` は ESM（`import` / `export`）で書く。**CLI 直接実行の判定は `import { fileURLToPath } from 'node:url'` を使い `if (fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) { ... listen ... }`** とする（テストから `import` した際は listen しない。symlink 経由起動でも実体パスで一致判定する。round 4 architect 指摘）。CJS/ESM 混在や `process.argv[1]` 生比較の曖昧さを排除する。
- **HTTP と WebSocket を同一ポートで動かす**。`http.createServer` で `public/` を静的配信し、その server を `new WebSocketServer({ server })` に渡して WS を upgrade で相乗りさせる。
- **server.js は factory を export（contrarian 高指摘反映）**。トップレベルで listen しない。
  - `createChatServer({ dbPath, staticDir })` → `{ server, wss, db, close() }` を返す（listen はまだしない）。**factory 入口で `const root = path.resolve(staticDir)` に正規化**し、以降 `serveStatic` へは正規化済み絶対パスのみ渡す（相対パス混入による境界判定崩れを防ぐ）。テストは `server.listen(0)` でランダムポート・一時 DB を注入できる。
  - `src/server.js` を CLI 直接実行したとき（`process.argv[1] === fileURLToPath(import.meta.url)`）のみ `PORT = process.env.PORT ?? 3000` と既定 DB パス `data/chat.db` で `listen` する。
- **静的配信のパストラバーサル防御（architect/contrarian 高指摘反映）**。`serveStatic(req, res, root)`（`root` は正規化済み絶対パス）を明示設計:
  - `GET` / `HEAD` のみ許可（他は 405）
  - **pathname 取得は `new URL()` を使わない**（実装時に判明した矛盾: `new URL(req.url, ...).pathname` は WHATWG URL 仕様で `..` を parse 時に正規化してしまい、`/../src/server.js` が `/src/server.js` になって後段の 403 境界チェックが一度も発火しない）。`req.url.split('?')[0]` でクエリのみ切り離し、`decodeURIComponent` を適用（失敗時は 400、`/%` 等の不正 percent-encoding もここで 400）。生の `..` を残すことで後段の実体境界チェックが本来の意図通り 403 を返す。
  - `let resolved = path.resolve(root, '.' + pathname)`。**文字列上の許可条件は `resolved === root || resolved.startsWith(root + path.sep)`**（`/` が `resolved === root` で 403 にならないようにする。round 2 の `/` 403 バグ対処）。外れれば 403（`/../src/server.js` 等を拒否）
  - 検証通過後、`resolved` がディレクトリ（または `pathname === '/'`）なら `resolved = path.join(resolved, 'index.html')`。存在しなければ 404
  - **symlink 逃げの恒久対策（round 4 architect/contrarian 高指摘反映）**: 最終要素の `lstat` だけでは `public/link -> /outside` のような **symlink ディレクトリ経由の逃げ**（`/link/secret`）を検出できない。よって **配信直前に実体パスで境界を再検証する**: `const rootReal = fs.realpathSync(root)` / `const targetReal = fs.realpathSync(resolved)`（`resolved` が存在しなければ先に 404）→ `targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)` を満たすときのみ配信、外れれば 403。これで途中の symlink ディレクトリ含め root 外の実体配信を全面的に閉じる。`rootReal` は factory 起動時に 1 度計算してキャッシュする。
  - 拡張子から最小の MIME マップ（html/css/js/ico）を返す
- **DB モジュール `src/db.js`** を分離し、副作用のない関数として export する（テストから DB パスを差し替え可能にする）:
  - `openDb(path)` → DatabaseSync インスタンスを返し、`PRAGMA user_version` を確認（0 なら初期化して 1 に設定＝将来 migration のフック）、スキーマを `CREATE TABLE IF NOT EXISTS` で作成、デフォルトルーム "全体" を `INSERT OR IGNORE`。**Phase 1 は新規 DB 前提**（既存 DB があっても `IF NOT EXISTS` で無害、`user_version` で将来対応）
  - `insertMessage(db, roomId, author, body)` → 挿入した行（id, room_id, author, body, created_at）を返す
  - `getRecentMessages(db, roomId, limit=50)` → **`ORDER BY id ASC` を履歴順の契約とする**（contrarian 指摘: 同一ミリ秒 timestamp でも id 単調増加で順序が決定的）。直近 limit 件は `id DESC LIMIT ?` のサブクエリを `id ASC` に並べ直して返す
  - `upsertUser(db, nickname)` → `INSERT OR IGNORE` で users に記録
  - `getDefaultRoomId(db)` → "全体" ルームの id
- **WS プロトコル（JSON テキストフレーム）**:
  - client → server: `{ "type": "join", "nickname": "..." }` / `{ "type": "message", "body": "..." }`
  - server → client: `{ "type": "history", "messages": [...] }`（join 直後に送信）/ `{ "type": "message", "message": {...} }`（**送信者を含む全接続へブロードキャスト**。フロントは楽観描画せずサーバー echo を唯一の確定表示とする＝重複表示を防ぐ）/ `{ "type": "error", "reason": "..." }`
  - join 前の message は無視し `{type:"error", reason:"not_joined"}` を返す。nickname 未設定の接続は message を送れない。
  - **最小防御（architect/migration/contrarian 反映）**: `JSON.parse` 失敗（malformed）は `{type:"error", reason:"bad_json"}`。未知 `type` は `{type:"error", reason:"unknown_type"}`。**payload 上限は役割を分離する**: アプリ層で **`Buffer.byteLength(rawText, 'utf8') > 8192`（UTF-8 バイト長で判定、文字数ではない。contrarian 指摘）** のフレームを `{type:"error", reason:"too_large"}` で返す（接続は維持）。`ws` の `maxPayload` は 64KB に設定し「アプリ層判定より大きな異常フレームだけを ws 層で close（code 1009）」に留める（round 2 指摘: maxPayload に引っかかると error フレームを返す前に close へ流れるため、通常の大きめ入力はアプリ層で拾えるよう ws 上限を上げる）。
- **入力バリデーション（contrarian/migration 反映）**:
  - `nickname`: trim → 空拒否、**最大 32 文字**、改行・制御文字（`/[\x00-\x1f\x7f]/`）を含むものは拒否（`{type:"error", reason:"bad_nickname"}`）
  - `body`: trim → 空拒否、**最大 2000 文字で切り詰め**（2001 文字以上は先頭 2000 文字を保存・配信）
  - ブロードキャストは JSON 値としてそのまま送り、**表示側（フロント）で `textContent` を使い XSS を防ぐ**（`innerHTML` を使わない）
- **フロント（`public/`, ビルドなし）**: `index.html`（ニックネーム入力オーバーレイ + チャット画面）/ `app.js`（localStorage の nickname 復元、WebSocket 接続、送受信描画）/ `style.css`（モバイル・低スペック向けに軽量、外部 CDN 依存なし）。WS URL は `location` から組み立て（`ws(s)://host/`）。

## DB スキーマ

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## 実装対象

**新規ファイル**:

- `package.json` — 依存 `ws`、`"type": "module"`、`"engines": {"node": ">=22.22.3"}`、scripts（`start`=`node src/server.js` / `test`=`node --test`）
- `src/db.js` — 上記 DB 関数群
- `src/server.js` — `createChatServer` factory（静的配信 `serveStatic` + WebSocketServer、接続管理・ブロードキャスト）。CLI 実行時のみ listen
- `public/index.html` / `public/app.js` / `public/style.css` — フロント
- `tests/chat.test.js` — acceptance test（`node:test` + `ws` クライアント）

**既存ファイル編集**（architect/contrarian/migration の指摘反映: before/after を明示）:

- `.gitignore` — 現状は gloop 用の ignore のみ。以下を追記する（重複しない形で末尾に追加）:

  ```diff
  # gloop
  features/.loop/
  features/.batch/
  features/.loop/last-cycle-marker
  features/.loop/*.pid
  features/.batch/lock
+
+ # chat-app
+ node_modules/
+ *.db
+ data/
  ```

**既存関数編集**: なし（本 Issue は全て新規追加。`.gitignore` は追記のみで既存行の変更なし）。

## テスト計画

`node --test`（Node 標準テストランナー）で実行。各テストは一時 DB パス（`tests/tmp-*.db`）とランダムポート（`listen(0)`）でサーバーを起動し、`ws` クライアントで検証、終了時に close & unlink する。

| ID | 内容 | 期待値 |
|---|---|---|
| T01 | 2 つの WS クライアント A/B が join 後、A が `{type:"message", body:"hi"}` を送る | B が `{type:"message"}` フレームを受信し `message.body === "hi"` / `message.author === Aのnickname` |
| T02 | 事前に `insertMessage` で 3 件投入 → 新規クライアントが join | join 直後に `{type:"history"}` を受信し `messages.length === 3` かつ **`id` 昇順（投入順と一致）**。`created_at` は各行に存在することのみ確認（順序契約は id に寄せる） |
| T03_boundary | join 済みクライアントが `body:"   "`（空白のみ）を送る | messages に保存されず（`getRecentMessages` の件数が増えない）、ブロードキャストも発生しない |
| T04_persistence | `openDb(path)` で 1 件挿入 → `db.close()` → 同 path で再 `openDb` | `getRecentMessages` が挿入した 1 件を返す（再起動後も履歴が残る = SQLite 永続化） |
| T05_boundary | join せずにいきなり `{type:"message"}` を送る | messages に保存されず、`{type:"error", reason:"not_joined"}` が返る |
| T06_boundary | join 済みクライアントが 2001 文字以上の body を送る | 保存・配信される `body` がちょうど 2000 文字に切り詰められている |
| T07_boundary | 制御文字/改行を含む、または 33 文字以上の nickname で join する | `{type:"error", reason:"bad_nickname"}` が返り、以降 message を送れない（users にも保存されない） |
| T08_boundary | join 済みクライアントが UTF-8 バイト長 8192 超・64KB 未満（ASCII で 'a'.repeat(9000) など）のフレームを送る | `{type:"error", reason:"too_large"}` が返り、**同じ接続で後続の正常メッセージが送れる**（接続は維持される） |
| T09_boundary | HTTP で `GET /`、`GET /../src/server.js`、不正 percent encoding の URL を `fetch` する | `/` は 200 で index.html を返す / traversal は 403 / 不正エンコードは 400 |
| T10_boundary | `public/` 配下に root 外ディレクトリを指す symlink（`tests` 内で一時作成）を置き、その配下ファイルを HTTP 要求する | 403 が返り root 外の実体が配信されない（`fs.realpathSync` 境界検証。symlink 作成不可の環境では `t.skip`） |

## 完了条件（Issue body より）

- [ ] `npm start` でサーバーが起動し、ブラウザからニックネーム入力で入室できる
- [ ] 2 つのブラウザ間でメッセージがリアルタイムに届く
- [ ] サーバー再起動後もメッセージ履歴が SQLite に残っている
- [ ] acceptance test（WebSocket 経由の送受信・履歴取得）が green
