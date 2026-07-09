// DB モジュール（node:sqlite の DatabaseSync を使用）
//
// 副作用のない関数として export し、テストから DB パスを差し替え可能にする。

import { DatabaseSync } from 'node:sqlite';

const DEFAULT_ROOM_NAME = '全体';

const SCHEMA_SQL = `
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
  created_at INTEGER NOT NULL,
  thread_root_id INTEGER REFERENCES messages(id)
);
`;

/**
 * DB を開き、スキーマ・デフォルトルームを初期化して DatabaseSync を返す。
 * @param {string} path
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(path) {
  const db = new DatabaseSync(path);

  // スキーマは IF NOT EXISTS で常に無害に作成する（Phase 1 は新規 DB 前提）。
  db.exec(SCHEMA_SQL);

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

  // デフォルトルーム "全体" を投入（既存なら無視）。
  db.prepare('INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)').run(
    DEFAULT_ROOM_NAME,
    Date.now(),
  );

  return db;
}

/**
 * メッセージを挿入し、挿入した行を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} roomId
 * @param {string} author
 * @param {string} body
 */
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

/**
 * 直近 limit 件を id 昇順（履歴順の契約）で返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} roomId
 * @param {number} [limit]
 */
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

/**
 * スレッド root（rootId）への返信を id 昇順（履歴順の契約）で最大 limit 件返す。
 * room_id 条件は getRecentMessages の JOIN 防御と対になる破損データ防御。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} rootId
 * @param {number} roomId
 * @param {number} [limit]
 */
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

/**
 * id でメッセージ 1 件を返す（存在しなければ undefined）。root 検証（存在・room_id・
 * thread_root_id が NULL か）に使う。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} messageId
 */
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

/**
 * users に nickname を記録する（既存なら無視）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} nickname
 */
export function upsertUser(db, nickname) {
  db.prepare('INSERT OR IGNORE INTO users (nickname, created_at) VALUES (?, ?)').run(
    nickname,
    Date.now(),
  );
}

/**
 * デフォルトルーム "全体" の id を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function getDefaultRoomId(db) {
  const row = db.prepare('SELECT id FROM rooms WHERE name = ?').get(DEFAULT_ROOM_NAME);
  return row ? Number(row.id) : undefined;
}

/**
 * ルーム一覧を id 昇順で返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{id: number, name: string, created_at: number}[]}
 */
export function listRooms(db) {
  const rows = db.prepare('SELECT id, name, created_at FROM rooms ORDER BY id ASC').all();
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    created_at: Number(row.created_at),
  }));
}

/**
 * ルームを作成し、挿入行を返す。name の UNIQUE 制約違反はそのまま throw する
 * （呼び出し側で捕捉して room_exists に変換する）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 */
export function createRoom(db, name) {
  const createdAt = Date.now();
  const stmt = db.prepare('INSERT INTO rooms (name, created_at) VALUES (?, ?)');
  const info = stmt.run(name, createdAt);
  return {
    id: Number(info.lastInsertRowid),
    name,
    created_at: createdAt,
  };
}

/**
 * roomId で指定したルームの行を返す（存在しなければ undefined）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} roomId
 */
export function getRoomById(db, roomId) {
  const row = db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?').get(roomId);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    name: row.name,
    created_at: Number(row.created_at),
  };
}

/**
 * ルームをトランザクションで削除する（messages → rooms の順で DELETE）。
 * 失敗時は ROLLBACK する。rooms の削除行数を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} roomId
 */
export function deleteRoom(db, roomId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
    const info = db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    db.exec('COMMIT');
    return Number(info.changes);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
