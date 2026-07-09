# plan: #3 スレッド: ルーム内スレッド（誰でも作成可）

slug: task
milestone: Phase 1
labels: type:feature, batch:feature

## In-Scope / Out-of-Scope

| 項目 | In/Out | 備考 |
|---|---|---|
| messages テーブルへの `thread_root_id` 列追加＋既存 DB マイグレーション | In | `PRAGMA user_version` 1 → 2 |
| WS `message` の拡張（`threadRootId` 指定でスレッド返信） | In | join 済みなら誰でも可 |
| WS `open_thread` / `thread_history`（スレッド履歴取得） | In | |
| スレッド返信のリアルタイム配信（同ルーム内） | In | 既存の room 単位 broadcast を流用 |
| タイムラインへの返信件数・最新返信時刻の付与 | In | history / room_switched の各行にメタを付与 |
| スレッド UI（開閉パネル・返信フォーム・返信バッジ） | In | 素の HTML/CSS/JS |
| ネスト返信（返信への返信で階層を掘る） | Out | 返信は常にスレッド root にぶら下がる（Discord 簡易版） |
| スレッドのタイトル・名前付け | Out | root メッセージ本文がそのまま見出し |
| スレッド単位の既読管理・通知・アーカイブ | Out | Phase 1 スコープ外 |
| ルーム横断のスレッド一覧ビュー | Out | |
| スレッド返信の編集・削除 | Out | メッセージ編集・削除自体が未実装 |
| messages(room_id) へのインデックス追加 | Out | 既存クエリの性能改善は別 Issue |

## Non-Goals

- 返信のネスト階層（root 直下の 1 階層のみ。root がスレッド返信のメッセージへの返信は拒否する）
- スレッド履歴のページング（`thread_history` は最新 50 件固定。より古い返信の遡りは対象外）
- ルーム削除時のスレッド特別処理（スレッド返信にも `room_id` を持たせるため、既存 `deleteRoom` の `DELETE FROM messages WHERE room_id = ?` がそのまま返信も消す。追加実装なし）
- `getRecentMessages` の後方互換 API 維持（呼び出し元は本リポジトリ内のみ。契約変更はテストごと更新する）

## 設計方針

### DB スキーマ（migration: user_version 1 → 2）

`messages` に nullable な自己参照列を 1 本足すだけの最小拡張とする。

- `thread_root_id INTEGER REFERENCES messages(id)` — NULL: ルームタイムラインの通常メッセージ（スレッド root になり得る）。非 NULL: スレッド返信で、値は root メッセージ（`thread_root_id IS NULL` の行）の id。
- `idx_messages_thread_root` index（返信件数集計・スレッド履歴取得用）。**index の CREATE は SCHEMA_SQL に入れない**。SCHEMA_SQL は openDb 冒頭で常に exec されるため、v1 既存 DB では `thread_root_id` 列が無い時点で index 作成が `no such column` で失敗し、migration 分岐に到達できなくなる（Codex round 1 指摘）。index は user_version 分岐の**後**に全パス共通で `CREATE INDEX IF NOT EXISTS` する。
- スレッド返信にも root と同じ `room_id` を保存する。これにより room 単位 broadcast・`deleteRoom` の一括削除・ルーム分離がすべて既存機構のまま機能する。

`openDb` の処理順（重要: SCHEMA_SQL exec → version 分岐 → index 作成）:

1. `SCHEMA_SQL` を exec（新規 DB は `thread_root_id` 込みの messages が作られる。既存 DB は `IF NOT EXISTS` で旧定義のまま）
2. `user_version` 分岐:
   - `== 0`（新規 DB）: フルスキーマ作成済みなので `user_version = 2` を設定するだけ
   - `== 1`（既存 DB）: **transaction で括って** `ALTER TABLE messages ADD COLUMN thread_root_id INTEGER REFERENCES messages(id)` → `PRAGMA user_version = 2` → COMMIT。失敗時は ROLLBACK（SQLite は DDL も `PRAGMA user_version` もトランザクショナルなので、ALTER だけ成功して version が 1 のまま残る中間状態にならず、再実行可能性が保たれる）。防御として ALTER 前に `PRAGMA table_info(messages)` で `thread_root_id` の有無を確認し、既に在れば ALTER を skip して version 更新のみ行う（冪等化）
   - `== 2`: 何もしない
3. `CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id)` を exec（この時点で全パスとも列が存在する）

既存行は `thread_root_id` NULL のまま（= 全部通常メッセージ）でデータ変換不要。

### DB 関数（src/db.js）

- `insertMessage(db, roomId, author, body, threadRootId = null)` — 既存シグネチャ末尾に省略可能引数を追加。返す row に `thread_root_id` を含める。**責務注記**: `insertMessage` 自体は threadRootId の妥当性（同 room・root 性）を検証しない。検証は WS 層の `validateThreadRoot` が唯一の入口で、DB 関数を直接呼ぶテストコードは自分で整合を保つ契約とする。
- `getRecentMessages(db, roomId, limit)` — **契約変更**: `WHERE room_id = ? AND thread_root_id IS NULL` でタイムライン専用にし、各行に `thread_reply_count`（返信数）と `thread_last_reply_at`（最新返信の created_at、返信 0 件なら null）を LEFT JOIN + GROUP BY 集計で付与する。スレッド返信はタイムラインに出さない。集計 JOIN は `ON r.thread_root_id = m.id AND r.room_id = m.room_id` とし、万一 room をまたぐ破損データが混入しても表示集計へ波及しない防御を入れる。行形状の統一のため `thread_root_id: null` も返す（ライブ broadcast row とキー集合を一致させる）。
- `getThreadMessages(db, rootId, roomId, limit = 50)` — 新規。`WHERE thread_root_id = ? AND room_id = ?` を「内側 id DESC LIMIT → 外側 id ASC」の既存パターンで最新 limit 件返す。行形状は `{id, room_id, author, body, created_at, thread_root_id}`。`room_id` 条件は getRecentMessages の JOIN 防御と対になる破損データ防御（万一 room をまたぐ返信行が入っても thread_history に混入させない）。
- `getMessageById(db, messageId)` — 新規。`{id, room_id, author, body, created_at, thread_root_id}` を返す（存在しなければ undefined）。root 検証（存在・room_id・thread_root_id が NULL か）に使う。

### WS プロトコル（src/server.js）

**スレッド返信の投稿** — 既存 `message` type を拡張（新 type を増やさない）:

```json
{ "type": "message", "body": "...", "threadRootId": 123 }
```

- `threadRootId` が undefined / null → 従来通りタイムライン投稿（完全後方互換）。
- **入力型契約**: `threadRootId` / `rootId` は **JSON number の正の安全な整数のみ許可**。数値文字列 `"1"`・小数・0 以下・配列などはすべて拒否する。チェックには既存 `parseRoomId`（`typeof value === 'number' && Number.isSafeInteger(value) && value > 0` のみ受理。文字列数値は現行実装で拒否される）をそのまま流用する。T34 の文字列 `"1"` 拒否期待はこの契約に基づく。
- 指定時の検証: `parseRoomId` による型チェック → `getMessageById` → 不存在 / `room_id` がクライアントの現在ルームと不一致 / root 自体がスレッド返信（ネスト禁止）→ いずれも `sendError(ws, 'thread_not_found')` に統一。理由を出し分けないことで実装とテストを単純化し、他ルームのメッセージ id の存在探りも防ぐ。
- 検証は新設ヘルパー `resolveThreadRoot(db, roomId, value)`（通れば **root 行オブジェクト**、不正なら null）に集約し、`open_thread` ハンドラと共有する。row を返すことで `open_thread` の root 二重取得を避ける。
- 検証通過後: `insertMessage(db, ws.roomId, ws.nickname, body, root.id)` → `broadcastMessage(row)`。

**配信** — `broadcastMessage` の**本体ロジックは変更しない**が、送信 payload の message row には `thread_root_id` キーが追加される（プロトコル出力形状の変更。既存テストで payload キーに触れる箇所は追従する）。スレッド返信も同ルーム全員に届き、受信側クライアントが `thread_root_id` の有無で「スレッドパネルに追記」か「タイムラインのバッジ更新」かを振り分ける。スレッド購読者管理をサーバーに持たない（Phase 1 の規模では room 単位配信で十分）。

**broadcast 受信時のメタ更新契約（明文化）**: スレッド返信の broadcast row は `thread_root_id`（root の id）と `created_at` を必ず含む。受信クライアントは該当 root について `thread_reply_count += 1`、`thread_last_reply_at = row.created_at` としてローカル状態を更新する。history / room_switched で再取得した場合はサーバー集計値で上書きされるため、ライブ更新の誤差は再取得で自然回復する。

**スレッド履歴の取得** — 新 type:

```json
{ "type": "open_thread", "rootId": 123 }
```

- join 前は `not_joined`。`rootId` の検証は `resolveThreadRoot` で同じ 4 条件 → `thread_not_found`。
- 成功時: `{ "type": "thread_history", "rootId": 123, "root": {root行}, "messages": [返信行... 最新50件 id昇順] }`
- **root 行の形状契約**: `thread_history.root` は `getMessageById` の生形状（`thread_reply_count` / `thread_last_reply_at` のメタ**無し**）。スレッドパネルの root 表示はメタを使わない（返信数はパネル内の返信リスト自体が見えているため不要）という UI 契約とし、タイムライン行とあえて形状を揃えない。

**history / room_switched** — ペイロード形は変えず、`messages` の各行が `getRecentMessages` の新契約（タイムラインのみ + `thread_reply_count` / `thread_last_reply_at` 付き）になる。

### UI（public/）

- タイムライン各メッセージに「スレッド」ボタンを常設し、返信があるメッセージには「💬 N件」の返信バッジを表示。クリックで `open_thread` を送りスレッドパネルを開く。
- タイムラインの li に `data-message-id` 属性を持たせ、`message` 受信時（`thread_root_id` あり）に該当 root のバッジ件数を更新できるようにする。
- スレッドパネルは既存サイドバーと同じ「オーバーレイ + パネル」方式（`.thread-panel` / `.thread-overlay`）を右側から出す。低スペック PC・スマホ前提のため CSS transition は最小限、DOM 生成は既存 `appendMessage` と同じ createElement + textContent 方式（XSS 対策の現行方針を維持）。
- パネル内容: root メッセージ表示 + 返信リスト + 返信入力フォーム（送信は `{type:'message', body, threadRootId}`）。
- `message` 受信時の振り分け: `thread_root_id` 無し → 従来通りタイムラインへ追記。有り → (a) 開いているスレッドの root と一致すればパネルに追記、(b) タイムラインの該当 root のバッジを +1。
- `history` / `room_switched` 受信時はスレッドパネルを閉じる（別ルームのスレッドが開きっぱなしになるのを防ぐ）。エラー `thread_not_found` 受信時もパネルを閉じて status 表示。

### 既存テストへの影響

- `getRecentMessages` の返す行に `thread_reply_count` / `thread_last_reply_at` が増える。chat.test.js / rooms.test.js に messages 行のキー集合や行全体を厳密比較する assert があれば追従修正する（implementer は既存テスト全 assert を確認すること）。
- タイムラインからスレッド返信を除外する変更は、既存テストがスレッド返信を投稿しないため影響なし。

## 実装対象

### src/db.js — SCHEMA_SQL の messages 定義（before/after）

before:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

after（index は SCHEMA_SQL に**入れない**。v1 既存 DB で列追加前に index 作成が走ると `no such column` で起動不能になるため）:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  thread_root_id INTEGER REFERENCES messages(id)
);
```

### src/db.js — openDb の user_version 分岐（before/after）

before:

```js
  // user_version は将来 migration のフック。0 なら初期化して 1 に設定する。
  const { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
  if (userVersion === 0) {
    db.exec('PRAGMA user_version = 1');
  }
```

after（イメージ）:

```js
  // user_version: 0=新規（SCHEMA_SQL がフルスキーマを作成済み）、1=スレッド列なしの旧DB、2=現行。
  const { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
  if (userVersion === 0) {
    db.exec('PRAGMA user_version = 2');
  } else if (userVersion === 1) {
    // v1→v2: transaction で括り、途中失敗時に「列だけ増えて version=1」の
    // 再実行不能な中間状態（ALTER 再実行が duplicate column で毎回失敗）を防ぐ。
    // 防御として列の有無も確認し冪等にする。
    const hasColumn = db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .some((column) => column.name === 'thread_root_id');
    db.exec('BEGIN');
    try {
      if (!hasColumn) {
        db.exec('ALTER TABLE messages ADD COLUMN thread_root_id INTEGER REFERENCES messages(id)');
      }
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // index は列の存在が確定した後（全 version パス共通）に作成する。
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id)');
```

（implementer への注記: 列有無チェックは上記 `PRAGMA table_info(messages)` の all() 方式で**確定**（node:sqlite で確実に動く形。table-valued 関数 `pragma_table_info(?)` へのパラメータ bind は使わない）。また SQLite では DDL・`PRAGMA user_version` ともトランザクション内で ROLLBACK 可能であることを T35 相当のテストで担保する。）

### src/db.js — insertMessage（before/after）

before:

```js
export function insertMessage(db, roomId, author, body) {
  const createdAt = Date.now();
  const stmt = db.prepare(
    'INSERT INTO messages (room_id, author, body, created_at) VALUES (?, ?, ?, ?)',
  );
  const info = stmt.run(roomId, author, body, createdAt);
  return {
    id: Number(info.lastInsertRowid),
    room_id: roomId,
    author,
    body,
    created_at: createdAt,
  };
}
```

after:

```js
export function insertMessage(db, roomId, author, body, threadRootId = null) {
  const createdAt = Date.now();
  const stmt = db.prepare(
    'INSERT INTO messages (room_id, author, body, created_at, thread_root_id) VALUES (?, ?, ?, ?, ?)',
  );
  const info = stmt.run(roomId, author, body, createdAt, threadRootId);
  return {
    id: Number(info.lastInsertRowid),
    room_id: roomId,
    author,
    body,
    created_at: createdAt,
    thread_root_id: threadRootId,
  };
}
```

### src/db.js — getRecentMessages（before/after）

before（現行の SQL 全体）:

```js
export function getRecentMessages(db, roomId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT id, room_id, author, body, created_at
         FROM messages
         WHERE room_id = ?
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`,
    )
    .all(roomId, limit);
  return rows.map((row) => ({
    id: Number(row.id),
    room_id: Number(row.room_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
  }));
}
```

after（イメージ）:

```js
export function getRecentMessages(db, roomId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT m.id, m.room_id, m.author, m.body, m.created_at,
                COUNT(r.id) AS thread_reply_count,
                MAX(r.created_at) AS thread_last_reply_at
         FROM messages m
         LEFT JOIN messages r ON r.thread_root_id = m.id AND r.room_id = m.room_id
         WHERE m.room_id = ? AND m.thread_root_id IS NULL
         GROUP BY m.id
         ORDER BY m.id DESC
         LIMIT ?
       )
       ORDER BY id ASC`,
    )
    .all(roomId, limit);
  return rows.map((row) => ({
    id: Number(row.id),
    room_id: Number(row.room_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
    thread_root_id: null, // タイムライン行は定義上 root のみ。broadcast row と形状を揃える
    thread_reply_count: Number(row.thread_reply_count),
    thread_last_reply_at: row.thread_last_reply_at === null ? null : Number(row.thread_last_reply_at),
  }));
}
```

### src/db.js — getThreadMessages / getMessageById（新設スニペット）

```js
export function getThreadMessages(db, rootId, roomId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT id, room_id, author, body, created_at, thread_root_id
         FROM messages
         WHERE thread_root_id = ? AND room_id = ?
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`,
    )
    .all(rootId, roomId, limit);
  return rows.map((row) => ({
    id: Number(row.id),
    room_id: Number(row.room_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
    thread_root_id: Number(row.thread_root_id),
  }));
}

export function getMessageById(db, messageId) {
  const row = db
    .prepare('SELECT id, room_id, author, body, created_at, thread_root_id FROM messages WHERE id = ?')
    .get(messageId);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    room_id: Number(row.room_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
    thread_root_id: row.thread_root_id === null ? null : Number(row.thread_root_id),
  };
}
```

### src/server.js — resolveThreadRoot（新設スニペット）

```js
/**
 * threadRootId / rootId 入力を検証して root 行を解決する。
 * JSON number の正の安全な整数（parseRoomId を流用。文字列数値は拒否）→ メッセージ存在
 * → クライアントの現在ルームに属する → root 自体がスレッド返信でない、をすべて満たせば
 * root 行オブジェクトを返す。どれか欠ければ null（呼び出し側で thread_not_found に変換）。
 */
function resolveThreadRoot(db, roomId, value) {
  const rootId = parseRoomId(value);
  if (rootId === null) return null;
  const root = getMessageById(db, rootId);
  if (!root) return null;
  if (root.room_id !== roomId) return null;
  if (root.thread_root_id !== null) return null;
  return root;
}
```

### src/server.js — message ハンドラ（before/after）

before:

```js
      if (parsed.type === 'message') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const body = sanitizeBody(parsed.body);
        if (body === null) {
          // 空白のみの body は保存もブロードキャストもしない（エラーも返さない）。
          return;
        }
        const row = insertMessage(db, ws.roomId, ws.nickname, body);
        broadcastMessage(row);
        return;
      }
```

after（イメージ）:

```js
      if (parsed.type === 'message') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const body = sanitizeBody(parsed.body);
        if (body === null) {
          // 空白のみの body は保存もブロードキャストもしない（エラーも返さない）。
          return;
        }
        let threadRootId = null;
        if (parsed.threadRootId !== undefined && parsed.threadRootId !== null) {
          const root = resolveThreadRoot(db, ws.roomId, parsed.threadRootId);
          if (root === null) {
            sendError(ws, 'thread_not_found');
            return;
          }
          threadRootId = root.id;
        }
        const row = insertMessage(db, ws.roomId, ws.nickname, body, threadRootId);
        broadcastMessage(row);
        return;
      }
```

### src/server.js — open_thread ハンドラ（新設、switch_room の直後に追加）

```js
      if (parsed.type === 'open_thread') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const root = resolveThreadRoot(db, ws.roomId, parsed.rootId);
        if (root === null) {
          sendError(ws, 'thread_not_found');
          return;
        }
        const messages = getThreadMessages(db, root.id, ws.roomId, HISTORY_LIMIT);
        sendJson(ws, { type: 'thread_history', rootId: root.id, root, messages });
        return;
      }
```

### その他の変更ファイル

- `src/server.js` — `resolveThreadRoot` ヘルパー新設、db.js からの import 追加
- `src/db.js` — `getThreadMessages` / `getMessageById` 新設
- `public/index.html` — スレッドパネル（overlay + panel + 返信フォーム）の静的マークアップ追加
- `public/app.js` — スレッドボタン/バッジ描画、`open_thread` 送信、`thread_history` / `message`（thread_root_id あり）受信処理、パネル開閉
- `public/style.css` — `.thread-panel` / `.thread-overlay` / バッジのスタイル
- `tests/threads.test.js` — 新設（下記テスト計画）

## テスト計画

acceptance test は `tests/threads.test.js` に新設。rooms.test.js の inbox（キュー方式受信）ヘルパーパターンを踏襲する。

**fixture 契約**: スレッド返信の作成は原則 WS 経由（`{type:'message', body, threadRootId}`）で行う。`insertMessage` を直接呼んでスレッド返信を作る場合は、必ず「同 room に存在する root（`thread_root_id IS NULL`）の id」だけを渡すこと（DB 層は不変条件を検証しないため、テストが自分で整合を保つ）。

| ID | 内容 | 期待値 |
|---|---|---|
| T31_thread_reply_and_history | root 投稿 → `threadRootId` 付き message で返信 → `open_thread` | broadcast row に `thread_root_id` が入る。`thread_history` に root と返信（id 昇順）が入る |
| T32_thread_realtime | 同ルームの別クライアントがスレッド返信を受信 | `type: 'message'` で届き `thread_root_id` が root の id |
| T33_timeline_thread_meta | 返信 2 件後の history / room_switched | root 行に `thread_reply_count: 2`・`thread_last_reply_at`（最後の返信の created_at）。返信 0 件の行は count 0 / null。スレッド返信自体はタイムライン messages に不在 |
| T34_boundary_thread_validation | 存在しない id / 文字列 "1" / 小数 / 0 / 他ルームの root / 返信 id へのネスト返信、join 前の open_thread | 前 6 者は `thread_not_found` で messages 行数不変。join 前は `not_joined` |
| T35_migration_v1_to_v2 | 旧スキーマ（thread_root_id なし・user_version=1）の DB を手組みし `openDb` | user_version が 2 になり、既存行が `thread_reply_count: 0` で読め、スレッド返信を挿入できる。同じ DB を再度 `openDb` しても壊れない（冪等）。さらに「列あり・user_version=1」の中間状態 DB でも openDb が成功し version 2 になる |
| T36_thread_room_isolation | ルームA の root へのスレッド返信 | ルームB 在室クライアントには届かない（timeout レース） |
| T37_thread_persistence | 返信投稿後にサーバー close → `openDb` し直す | `getThreadMessages` で返信が残っている |

正常系: T31, T32, T37。退化・境界: T33（0 件境界含む）, T34, T35, T36。

## Issue body 抜粋

## 背景

質問チャット MVP の第 3 弾。ルーム内にスレッド（質問ごとのぶら下がり会話）を作れるようにする。スレッドは子どもを含む誰でも自由に作成できる。

依存: ルーム Issue（管理者によるルーム作成・切替 UI）の完了後に着手。

## やること

- メッセージからスレッドを開始できる UI（Discord のスレッドの簡易版）
- スレッド内の返信もリアルタイム配信
- ルームのタイムラインにスレッドの存在（件数・最新返信）が分かる表示
- DB スキーマ拡張（messages に parent/thread 参照を追加、既存データはマイグレーション）

## 決定事項（intake 時点で確定）

- スレッド作成は誰でも可（ルーム作成と違い管理者限定にしない）
- フロントは素の HTML/CSS/JS を維持、低スペック PC・スマホ対応

## 完了条件

- [ ] 任意のメッセージからスレッドを作成し、返信を投稿できる
- [ ] スレッド返信が参加者にリアルタイムで届く
- [ ] ルーム画面でスレッドの存在と返信数が分かる
- [ ] acceptance test（スレッド作成・返信・配信）が green
