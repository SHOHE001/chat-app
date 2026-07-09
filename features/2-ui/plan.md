# plan: #2 ルーム: 管理者によるルーム作成・削除とルーム切替UI

slug: ui
milestone: Phase 1
labels: type:feature, batch:feature

## In-Scope / Out-of-Scope

| 項目 | In/Out | 備考 |
|---|---|---|
| `ADMIN_PASSWORD` による管理者判定（WS メッセージ `admin_auth`） | In | 未設定時は管理機能を全拒否（安全側） |
| ルーム作成・削除（管理者のみ、WS メッセージ経由） | In | デフォルトルーム「全体」は削除不可 |
| ルーム一覧の配信と作成/削除時の全員へのブロードキャスト | In | `{type: 'rooms', rooms}` |
| ルーム切替（`switch_room`）とルーム別履歴取得 | In | 切替時に該当ルームの直近 50 件を返す |
| ルーム単位の配信分離（在室ルームのメッセージのみ受信） | In | `broadcastMessage` をルームでフィルタ |
| ルーム削除時の在室者のデフォルトルームへの強制移動 | In | デフォルトルームの履歴も再送する |
| ルーム削除時のメッセージ削除 | In | トランザクションで messages → rooms の順に DELETE |
| サイドバー UI（PC 常時表示 / スマホ開閉式） | In | 素の HTML/CSS/JS |
| 管理者 UI（合言葉入力・ルーム作成フォーム・削除ボタン） | In | 認証成功時のみ表示 |
| ルーム名の変更（rename） | Out | 需要が出たら別 Issue |
| ルームごとの参加権限・非公開ルーム | Out | Phase 1 は全ルーム公開 |
| アカウント制・セッション管理 | Out | intake 決定事項（合言葉方式のみ） |
| HTTP REST API としてのルーム CRUD | Out | 既存構成に合わせ WS メッセージで実装 |
| スレッド機能 | Out | Phase 1 の後続 Issue |

## Non-Goals

- 管理者の操作ログ・監査ログは実装しない
- 合言葉のレート制限・ブルートフォース対策は実装しない（家庭内利用の MVP。将来必要なら別 Issue）
- ルームのアーカイブ（論理削除）は実装しない（物理削除のみ）
- DB スキーマ変更・migration 機構の導入はしない（既存の rooms/messages テーブルをそのまま使う）

## 設計方針

### 管理者判定

- `createChatServer({ dbPath, staticDir, adminPassword })` に option を追加。CLI 起動時は `process.env.ADMIN_PASSWORD` を渡す。テストからは直接注入する。
- `adminPassword` が undefined または空文字のときは `admin_auth` を常に `admin_disabled` で拒否する（安全側デフォルト）。
- クライアントは `{type: 'admin_auth', password}` を送る。一致すれば `ws.isAdmin = true` にして `{type: 'admin_auth_ok'}` を返す。不一致は `{type: 'error', reason: 'bad_admin_password'}`。
- 比較は `node:crypto` の `timingSafeEqual` を SHA-256 ダイジェスト同士で行う（長さ差による throw を回避しつつ定数時間比較。実装コストほぼゼロなので入れておく）。
- `admin_auth` は join 前でも受け付ける（発言に join が必要という既存制約は変えない）。

### ルーム CRUD（WS メッセージ）

- `{type: 'create_room', name}`（要 isAdmin）
  - `ws.isAdmin` でなければ `{type: 'error', reason: 'forbidden'}`
  - name はニックネームと同じ規則で検証（trim → 空拒否 → 32 文字以内 → 制御文字拒否）。不正は `bad_room_name`
  - 重複（rooms.name の UNIQUE 制約違反）は `room_exists`
  - 成功時: 全クライアントへ `{type: 'rooms', rooms}` をブロードキャスト
- `{type: 'delete_room', roomId}`（要 isAdmin）
  - `roomId` は共通の `parseRoomId` で正規化してから判定する（下記「roomId 入力の正規化」）
  - デフォルトルーム「全体」の id なら `cannot_delete_default`
  - 存在しない id なら `room_not_found`
  - 成功時: トランザクションで該当ルームの messages を DELETE → rooms を DELETE
  - 削除ルーム在室中のクライアントは `ws.roomId` をデフォルトルーム id に書き換え、`{type: 'room_switched', roomId, messages}`（デフォルトルームの履歴付き）を送って強制移動
  - 全クライアントへ `{type: 'rooms', rooms}` をブロードキャスト

### roomId 入力の正規化（Codex design round 1 反映）

WS payload の `roomId` は外部入力なので、`delete_room` / `switch_room` の両方で共通のバリデータを最初に通す:

```js
// number 型かつ正の安全な整数のみ受理。それ以外（文字列 "1"・小数・null・配列など）は null を返す。
function parseRoomId(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}
```

- `parseRoomId` が null を返したら即 `room_not_found`（型の違いによる default 判定すり抜けを構造的に防ぐ。文字列 `"1"` を数値に暗黙変換して SQLite に渡すことはしない）
- default 判定・存在確認・DELETE はすべて正規化済みの同じ値で行う

### ルーム切替と配信分離

- 接続ごとに `ws.roomId` を保持。`join` 成功時にデフォルトルーム id をセットする。
- join 応答は「`history`（`roomId` 付き）→ `rooms`」の順で 2 通送る（既存テストは 1 通目の history だけ読むので互換）。
- `{type: 'switch_room', roomId}`
  - join 前は `not_joined`
  - 存在しない/数値でない roomId は `room_not_found`
  - 成功時: `ws.roomId` を更新し `{type: 'room_switched', roomId, messages}` を返す（そのルームの直近 50 件、id 昇順）
- `broadcastMessage(row)` は `client.roomId === row.room_id` のクライアントにのみ送る（配信分離の本体）。
- `message` ハンドラの保存先は固定 `roomId` から `ws.roomId` に変更する。

### DB 関数の追加（src/db.js）

- `listRooms(db)` → `[{id, name, created_at}]` を id 昇順で返す。WS へ送るときは server.js 側の `roomsPayload()` で `{id, name}` に整形する（`created_at` はクライアントに露出させない。DB 関数とプロトコルの形の差はこの整形関数が吸収する）
- `createRoom(db, name)` → 挿入行を返す。UNIQUE 違反は throw のまま（呼び出し側で捕捉して `room_exists` に変換）
- `deleteRoom(db, roomId)` → トランザクション（`BEGIN`〜`COMMIT`、失敗時 `ROLLBACK`）で messages → rooms を DELETE。rooms の削除行数を返す
- `getRoomById(db, roomId)` → 行 or undefined（switch_room / delete_room の存在検証用）
- スキーマ変更なし。

### フロント（public/）

- `index.html`: `chat-screen` を「サイドバー + メイン」の 2 カラム構成に変更。サイドバーにルーム一覧 `<ul>`・管理者ログインボタン・（認証後）ルーム作成フォームと各ルームの削除ボタン。ヘッダーにスマホ用サイドバー開閉ボタンを置く。
- `style.css`: PC（`min-width: 768px`）はサイドバー常時表示、スマホはオーバーレイ開閉式。低スペック PC 配慮でアニメーションは最小限にする。
- `app.js`:
  - `rooms` 受信でサイドバー再描画（現在ルームをハイライト。DOM は `textContent` で組み立て XSS を避ける既存方針を踏襲）
  - ルームクリックで `switch_room` 送信。`room_switched` / `history` 受信でメッセージリスト再描画とヘッダーのルーム名更新
  - 管理者: 合言葉入力 → `admin_auth` 送信。`admin_auth_ok` で管理 UI 表示。合言葉は `sessionStorage` に保存し再接続時に自動再認証（タブを閉じれば消える。localStorage より露出が小さい）
  - 削除ボタンは `confirm()` で確認してから `delete_room` 送信

### プロトコル一覧（新規・変更）

| 方向 | type | payload | 備考 |
|---|---|---|---|
| C→S | `admin_auth` | `password` | 新規 |
| S→C | `admin_auth_ok` | — | 新規 |
| C→S | `create_room` | `name` | 新規・要 isAdmin |
| C→S | `delete_room` | `roomId` | 新規・要 isAdmin |
| C→S | `switch_room` | `roomId` | 新規・要 join |
| S→C | `rooms` | `rooms: [{id,name}]` | 新規・join 時 + CRUD 成功時に全員へ |
| S→C | `room_switched` | `roomId, messages` | 新規・切替成功/強制移動時 |
| S→C | `history` | `roomId, messages` | 変更: `roomId` を追加（join 時） |
| S→C | `error` | `reason` | 追加 reason: `forbidden` / `bad_admin_password` / `admin_disabled` / `bad_room_name` / `room_exists` / `room_not_found` / `cannot_delete_default`。既存 reason `not_joined` は `switch_room`（join 前）にも利用範囲を広げる |

既存クライアント互換の注記: 現行 `public/app.js` の message dispatcher は `history` / `message` / `error` 以外の type を無視する（if/else if 構成で該当なしは何もしない）ため、`rooms` / `room_switched` の追加送信は旧クライアントを壊さない。本 Issue では app.js 自体も同時に更新するため実運用での新旧混在は起きないが、サーバー側テスト T14 で「join 直後のクライアントが history の後に rooms を受信しても正常動作する」ことを兼ねて検証する。

## 実装対象

### `createChatServer` の option と接続状態（src/server.js）

before:

```js
export function createChatServer({ dbPath, staticDir }) {
  // ...
  const db = openDb(dbPath);
  const roomId = getDefaultRoomId(db);
  // ...
  wss.on('connection', (ws) => {
    ws.nickname = null;
    // ...
  });
}
```

after（骨子）:

```js
export function createChatServer({ dbPath, staticDir, adminPassword }) {
  // ...
  const db = openDb(dbPath);
  const defaultRoomId = getDefaultRoomId(db);
  // ...
  wss.on('connection', (ws) => {
    ws.nickname = null;
    ws.isAdmin = false;
    ws.roomId = null; // join 成功時に defaultRoomId をセット
    // ...
  });
}
```

CLI 起動部（isMainModule ブロック）は `adminPassword: process.env.ADMIN_PASSWORD` を渡すよう変更。

### `broadcastMessage`（src/server.js）— 配信分離

before:

```js
function broadcastMessage(row) {
  const payload = JSON.stringify({ type: 'message', message: row });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
```

after:

```js
function broadcastMessage(row) {
  const payload = JSON.stringify({ type: 'message', message: row });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.roomId === row.room_id) {
      client.send(payload);
    }
  }
}
```

### `join` ハンドラ（src/server.js）

before:

```js
if (parsed.type === 'join') {
  const nickname = validateNickname(parsed.nickname);
  if (nickname === null) {
    sendError(ws, 'bad_nickname');
    return;
  }
  ws.nickname = nickname;
  upsertUser(db, nickname);
  const messages = getRecentMessages(db, roomId, HISTORY_LIMIT);
  sendJson(ws, { type: 'history', messages });
  return;
}
```

after（骨子）:

```js
if (parsed.type === 'join') {
  const nickname = validateNickname(parsed.nickname);
  if (nickname === null) {
    sendError(ws, 'bad_nickname');
    return;
  }
  ws.nickname = nickname;
  ws.roomId = defaultRoomId;
  upsertUser(db, nickname);
  const messages = getRecentMessages(db, ws.roomId, HISTORY_LIMIT);
  sendJson(ws, { type: 'history', roomId: ws.roomId, messages });
  sendJson(ws, { type: 'rooms', rooms: roomsPayload(db) }); // roomsPayload = listRooms を {id,name} に整形
  return;
}
```

`rooms` の送信は join 時・CRUD 成功時のブロードキャストとも必ず同じ `roomsPayload(db)` を使う（`created_at` を露出させない）。

### `message` ハンドラ（src/server.js）

`insertMessage(db, roomId, ws.nickname, body)` → `insertMessage(db, ws.roomId, ws.nickname, body)` に変更（他は不変）。

### その他

- `src/server.js`: `admin_auth` / `create_room` / `delete_room` / `switch_room` の各ハンドラを message ディスパッチに追加
- `src/db.js`: `listRooms` / `createRoom` / `deleteRoom` / `getRoomById` を追加
- `public/index.html` / `public/style.css` / `public/app.js`: サイドバー・管理 UI・ルーム切替

## テスト計画

既存 T01〜T10 は退行なしで green を維持する（join 応答が history → rooms の 2 通になるが、既存テストは 1 通目のみ読むので互換）。

| ID | 内容 | 期待値 |
|---|---|---|
| T11_admin_auth | 正しい合言葉で `admin_auth`、誤った合言葉で `admin_auth` | 前者は `admin_auth_ok`、後者は `error: bad_admin_password` |
| T12_boundary_admin_disabled | `adminPassword` 未設定サーバーへ正しい値を送る | `error: admin_disabled` |
| T13_boundary_forbidden | 未認証クライアントが `create_room` / `delete_room` | 両方 `error: forbidden`、DB のルーム一覧に変化なし |
| T14_create_room | 管理者が `create_room`（join 直後の受信順序も兼ねて検証） | 管理者・非管理者の全クライアントに `rooms` がブロードキャストされ新ルームを含む。join 直後の応答が `history` → `rooms` の順で届き、`rooms` の要素は `{id, name}` のみ（`created_at` 非露出） |
| T15_boundary_room_name | 空名・33 文字・制御文字入り・重複名で `create_room` | 前三者は `error: bad_room_name`、重複は `error: room_exists` |
| T16_boundary_delete_default | デフォルトルーム「全体」を `delete_room`（number の id、文字列 `"<defaultId>"`、小数、null、配列の各形で） | number は `error: cannot_delete_default`、それ以外の型は `error: room_not_found`。いずれもルームは残る |
| T17_delete_room | 管理者が空きルームを `delete_room` / 存在しない id を指定 | 成功時 `rooms` から消え DB の該当 messages も 0 件。存在しない id は `error: room_not_found` |
| T18_delete_room_eviction | 在室者のいるルームを削除 | 在室クライアントが `room_switched`（デフォルトルーム履歴付き）を受信し、以後デフォルトルームの新着を受信する |
| T19_switch_room | `switch_room` 正常系 + join 前 + 存在しない roomId + 型不正（文字列 id・小数・null） | 正常系は `room_switched` とそのルームの履歴（id 昇順・最大 50 件）。join 前は `not_joined`、不明 id と型不正は `room_not_found` |
| T20_isolation | ルーム A 在室者の発言 | ルーム A 在室者にだけ届き、ルーム B 在室者には届かない |
| T21_room_persistence | ルーム作成・投稿後に DB を閉じて再オープン | ルームとメッセージが残っている |

## 完了条件との対応

- `ADMIN_PASSWORD` を入力した利用者だけがルーム作成・削除 UI を使える → T11 / T12 / T13
- 一般利用者はルーム一覧から参加・発言のみ → T13 / T20
- ルーム切替でそのルームの履歴と新着だけが表示される → T19 / T20
- acceptance test（管理者判定・ルーム CRUD・配信分離）green → T11〜T21 + 既存 T01〜T10 の退行なし

## Issue body 抜粋

## 背景

質問チャット MVP の第 2 弾。Discord のチャンネルにあたるトークルームを複数持てるようにする。ルームの作成・削除は管理者のみ（子どもは参加・発言のみ）。

依存: コア Issue（ニックネーム参加＋単一ルームチャット）の完了後に着手。

## やること

- 環境変数 `ADMIN_PASSWORD` による管理者判定（合言葉を入力した接続だけ管理操作を許可）
- ルームの作成・削除 API / UI（管理者のみ表示・実行可）
- ルーム一覧サイドバーとルーム切替 UI（PC は常時表示、スマホは開閉式）
- ルームごとにメッセージ履歴・リアルタイム配信を分離

## 決定事項（intake 時点で確定）

- ルーム（チャンネル相当）の作成・削除は管理者のみ
- 管理者判定は環境変数 `ADMIN_PASSWORD` の合言葉方式（アカウント制は導入しない）
- フロントは素の HTML/CSS/JS を維持、低スペック PC・スマホ対応

## 完了条件

- [ ] `ADMIN_PASSWORD` を入力した利用者だけがルーム作成・削除 UI を使える
- [ ] 一般利用者はルーム一覧から参加・発言のみできる
- [ ] ルームを切り替えるとそのルームの履歴と新着だけが表示される
- [ ] acceptance test（管理者判定・ルーム CRUD・配信分離）が green
