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
  created_at INTEGER NOT NULL
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

  // user_version は将来 migration のフック。0 なら初期化して 1 に設定する。
  const { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
  if (userVersion === 0) {
    db.exec('PRAGMA user_version = 1');
  }

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
