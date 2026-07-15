// DB モジュール（node:sqlite の DatabaseSync を使用）
//
// 副作用のない関数として export し、テストから DB パスを差し替え可能にする。

import { DatabaseSync } from 'node:sqlite';

const DEFAULT_ROOM_NAME = '全体';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  display_name TEXT,
  bio TEXT,
  avatar_attachment_id TEXT REFERENCES attachments(id),
  banned_until INTEGER,
  banned_at INTEGER,
  banned_by_user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  uploader_user_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  author TEXT NOT NULL,
  author_user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  thread_root_id INTEGER REFERENCES messages(id),
  attachment_id TEXT REFERENCES attachments(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji, user_id)
);
CREATE TABLE IF NOT EXISTS standalone_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS standalone_thread_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES standalone_threads(id) ON DELETE CASCADE,
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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

  // user_version: 0=新規、1=旧メッセージ、2=メッセージスレッド、
  // 3=アカウント/リアクション/独立スレッド、4=添付ファイル、5=プロフィール、
  // 6=メッセージ編集日時、7=Web Push購読とアプリ設定、8=アカウントBAN。
  let { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
  if (userVersion === 0) {
    db.exec('PRAGMA user_version = 8');
    userVersion = 8;
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
      userVersion = 2;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 2) {
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    const messageColumns = new Set(
      db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name),
    );
    db.exec('BEGIN');
    try {
      if (!userColumns.has('password_hash')) {
        db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
      }
      if (!userColumns.has('role')) {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
      }
      if (!messageColumns.has('author_user_id')) {
        db.exec('ALTER TABLE messages ADD COLUMN author_user_id INTEGER REFERENCES users(id)');
      }
      db.exec('PRAGMA user_version = 3');
      db.exec('COMMIT');
      userVersion = 3;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 3) {
    const messageColumns = new Set(
      db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name),
    );
    db.exec('BEGIN');
    try {
      if (!messageColumns.has('attachment_id')) {
        db.exec('ALTER TABLE messages ADD COLUMN attachment_id TEXT REFERENCES attachments(id)');
      }
      db.exec('PRAGMA user_version = 4');
      db.exec('COMMIT');
      userVersion = 4;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 4) {
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    db.exec('BEGIN');
    try {
      if (!userColumns.has('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
      if (!userColumns.has('bio')) db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
      if (!userColumns.has('avatar_attachment_id')) {
        db.exec('ALTER TABLE users ADD COLUMN avatar_attachment_id TEXT REFERENCES attachments(id)');
      }
      db.exec('PRAGMA user_version = 5');
      db.exec('COMMIT');
      userVersion = 5;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 5) {
    const messageColumns = new Set(
      db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name),
    );
    const threadMessageColumns = new Set(
      db.prepare('PRAGMA table_info(standalone_thread_messages)').all().map((column) => column.name),
    );
    db.exec('BEGIN');
    try {
      if (!messageColumns.has('edited_at')) {
        db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
      }
      if (!threadMessageColumns.has('edited_at')) {
        db.exec('ALTER TABLE standalone_thread_messages ADD COLUMN edited_at INTEGER');
      }
      db.exec('PRAGMA user_version = 6');
      db.exec('COMMIT');
      userVersion = 6;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 6) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 7');
      db.exec('COMMIT');
      userVersion = 7;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 7) {
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    db.exec('BEGIN');
    try {
      if (!userColumns.has('banned_until')) db.exec('ALTER TABLE users ADD COLUMN banned_until INTEGER');
      if (!userColumns.has('banned_at')) db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER');
      if (!userColumns.has('banned_by_user_id')) {
        db.exec('ALTER TABLE users ADD COLUMN banned_by_user_id INTEGER REFERENCES users(id)');
      }
      db.exec('PRAGMA user_version = 8');
      db.exec('COMMIT');
      userVersion = 8;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // index は列の存在が確定した後（全 version パス共通）に作成する。
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_author_user ON messages(author_user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_attachment ON messages(attachment_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_standalone_threads_room ON standalone_threads(room_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_standalone_thread_messages_thread ON standalone_thread_messages(thread_id)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_banned_until ON users(banned_until)');
  db.exec('PRAGMA foreign_keys = ON');

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
export function insertMessage(
  db,
  roomId,
  author,
  body,
  threadRootId = null,
  authorUserId = null,
  attachmentId = null,
) {
  const createdAt = Date.now();
  const stmt = db.prepare(
    `INSERT INTO messages
       (room_id, author, author_user_id, body, created_at, thread_root_id, attachment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(roomId, author, authorUserId, body, createdAt, threadRootId, attachmentId);
  return {
    id: Number(info.lastInsertRowid),
    room_id: roomId,
    author,
    author_user_id: authorUserId,
    body,
    created_at: createdAt,
    edited_at: null,
    thread_root_id: threadRootId,
    attachment: attachmentId ? getAttachmentById(db, attachmentId) : null,
    reactions: [],
  };
}

function mapAttachment(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.original_name,
    mime_type: row.mime_type,
    size: Number(row.size),
    url: `/uploads/${row.id}`,
    created_at: Number(row.created_at),
  };
}

export function createAttachment(db, { id, uploaderUserId, originalName, storedName, mimeType, size }) {
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO attachments
       (id, uploader_user_id, original_name, stored_name, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, uploaderUserId, originalName, storedName, mimeType, size, createdAt);
  return { id, name: originalName, mime_type: mimeType, size, url: `/uploads/${id}`, created_at: createdAt };
}

export function getAttachmentById(db, id, includeStoredName = false) {
  const row = db
    .prepare(
      `SELECT id, uploader_user_id, original_name, stored_name, mime_type, size, created_at
       FROM attachments WHERE id = ?`,
    )
    .get(id);
  const attachment = mapAttachment(row);
  if (attachment && includeStoredName) attachment.stored_name = row.stored_name;
  if (attachment) attachment.uploader_user_id = Number(row.uploader_user_id);
  return attachment;
}

function attachmentsById(db, rows) {
  const ids = [...new Set(rows.map((row) => row.attachment_id).filter(Boolean))];
  const result = new Map();
  if (!ids.length) return result;
  const placeholders = ids.map(() => '?').join(', ');
  for (const row of db.prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`).all(...ids)) {
    result.set(row.id, mapAttachment(row));
  }
  return result;
}

function reactionsByMessage(db, messageIds) {
  const result = new Map();
  if (messageIds.length === 0) return result;
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT message_id, emoji, user_id
       FROM reactions
       WHERE message_id IN (${placeholders})
       ORDER BY message_id ASC, emoji ASC, user_id ASC`,
    )
    .all(...messageIds);
  for (const row of rows) {
    const messageId = Number(row.message_id);
    if (!result.has(messageId)) result.set(messageId, []);
    const groups = result.get(messageId);
    let group = groups.find((item) => item.emoji === row.emoji);
    if (!group) {
      group = { emoji: row.emoji, count: 0, userIds: [] };
      groups.push(group);
    }
    group.count += 1;
    group.userIds.push(Number(row.user_id));
  }
  return result;
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
         SELECT m.id, m.room_id, m.author, m.author_user_id, m.body, m.created_at, m.edited_at,
                m.attachment_id,
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
  const reactionMap = reactionsByMessage(db, rows.map((row) => Number(row.id)));
  const attachmentMap = attachmentsById(db, rows);
  return rows.map((row) => ({
    id: Number(row.id),
    room_id: Number(row.room_id),
    author: row.author,
    author_user_id: row.author_user_id === null ? null : Number(row.author_user_id),
    body: row.body,
    created_at: Number(row.created_at),
    edited_at: row.edited_at === null ? null : Number(row.edited_at),
    thread_root_id: null, // タイムライン行は定義上 root のみ。broadcast row と形状を揃える
    thread_reply_count: Number(row.thread_reply_count),
    thread_last_reply_at: row.thread_last_reply_at === null ? null : Number(row.thread_last_reply_at),
    attachment: row.attachment_id ? attachmentMap.get(row.attachment_id) || null : null,
    reactions: reactionMap.get(Number(row.id)) || [],
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
         SELECT id, room_id, author, author_user_id, body, created_at, edited_at, thread_root_id
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
    author_user_id: row.author_user_id === null ? null : Number(row.author_user_id),
    body: row.body,
    created_at: Number(row.created_at),
    edited_at: row.edited_at === null ? null : Number(row.edited_at),
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
    .prepare(
      `SELECT id, room_id, author, author_user_id, body, created_at, edited_at,
              thread_root_id, attachment_id
       FROM messages WHERE id = ?`,
    )
    .get(messageId);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    room_id: Number(row.room_id),
    author: row.author,
    author_user_id: row.author_user_id === null ? null : Number(row.author_user_id),
    body: row.body,
    created_at: Number(row.created_at),
    edited_at: row.edited_at === null ? null : Number(row.edited_at),
    thread_root_id: row.thread_root_id === null ? null : Number(row.thread_root_id),
    attachment_id: row.attachment_id || null,
  };
}

export function updateMessage(db, messageId, roomId, body) {
  const editedAt = Date.now();
  const info = db
    .prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND room_id = ?')
    .run(body, editedAt, messageId, roomId);
  return info.changes ? editedAt : undefined;
}

export function deleteMessage(db, messageId, roomId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE thread_root_id = ? AND room_id = ?').run(messageId, roomId);
    const info = db.prepare('DELETE FROM messages WHERE id = ? AND room_id = ?').run(messageId, roomId);
    db.exec('COMMIT');
    return info.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

function mapAccount(row, includePasswordHash = false) {
  if (!row) return undefined;
  const account = {
    id: Number(row.id),
    username: row.nickname,
    display_name: row.display_name || null,
    bio: row.bio || '',
    avatar: row.avatar_id
      ? {
          id: row.avatar_id,
          name: row.avatar_name,
          mime_type: row.avatar_mime_type,
          size: Number(row.avatar_size),
          url: `/uploads/${row.avatar_id}`,
        }
      : null,
    role: row.role,
    banned_until: row.banned_until === null || row.banned_until === undefined
      ? null
      : Number(row.banned_until),
    banned_at: row.banned_at === null || row.banned_at === undefined ? null : Number(row.banned_at),
    banned_by_user_id: row.banned_by_user_id === null || row.banned_by_user_id === undefined
      ? null
      : Number(row.banned_by_user_id),
    created_at: Number(row.created_at),
  };
  if (includePasswordHash) account.password_hash = row.password_hash;
  return account;
}

export function createAccount(db, username, passwordHash) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db
      .prepare('SELECT id, nickname, password_hash, role, created_at FROM users WHERE nickname = ?')
      .get(username);
    if (existing?.password_hash) {
      const error = new Error('account exists');
      error.code = 'ACCOUNT_EXISTS';
      throw error;
    }
    const { count } = db
      .prepare('SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL')
      .get();
    const role = Number(count) === 0 ? 'owner' : 'member';
    let userId;
    let createdAt;
    if (existing) {
      userId = Number(existing.id);
      createdAt = Number(existing.created_at);
      db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?').run(
        passwordHash,
        role,
        userId,
      );
    } else {
      createdAt = Date.now();
      const info = db
        .prepare(
          'INSERT INTO users (nickname, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(username, passwordHash, role, createdAt);
      userId = Number(info.lastInsertRowid);
    }
    db.exec('COMMIT');
    return {
      id: userId,
      username,
      display_name: null,
      bio: '',
      avatar: null,
      role,
      banned_until: null,
      banned_at: null,
      banned_by_user_id: null,
      created_at: createdAt,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getAccountByUsername(db, username) {
  clearExpiredAccountBans(db);
  return mapAccount(
    db
      .prepare(
        `SELECT u.id, u.nickname, u.password_hash, u.role, u.display_name, u.bio,
                u.banned_until, u.banned_at, u.banned_by_user_id, u.created_at,
                a.id AS avatar_id, a.original_name AS avatar_name,
                a.mime_type AS avatar_mime_type, a.size AS avatar_size
         FROM users u LEFT JOIN attachments a ON a.id = u.avatar_attachment_id
         WHERE u.nickname = ? AND u.password_hash IS NOT NULL`,
      )
      .get(username),
    true,
  );
}

export function listAccounts(db) {
  clearExpiredAccountBans(db);
  return db
    .prepare(
      `SELECT u.id, u.nickname, u.role, u.display_name, u.bio,
              u.banned_until, u.banned_at, u.banned_by_user_id, u.created_at,
              a.id AS avatar_id, a.original_name AS avatar_name,
              a.mime_type AS avatar_mime_type, a.size AS avatar_size
       FROM users u LEFT JOIN attachments a ON a.id = u.avatar_attachment_id
       WHERE u.password_hash IS NOT NULL ORDER BY u.nickname COLLATE NOCASE ASC`,
    )
    .all()
    .map((row) => mapAccount(row));
}

export function hasRegisteredAccounts(db) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1').get());
}

export function setAccountRole(db, userId, role) {
  const info = db
    .prepare("UPDATE users SET role = ? WHERE id = ? AND role != 'owner' AND password_hash IS NOT NULL")
    .run(role, userId);
  return Number(info.changes);
}

export function getAccountById(db, userId) {
  clearExpiredAccountBans(db);
  return mapAccount(
    db
      .prepare(
        `SELECT u.id, u.nickname, u.password_hash, u.role, u.display_name, u.bio,
                u.banned_until, u.banned_at, u.banned_by_user_id, u.created_at,
                a.id AS avatar_id, a.original_name AS avatar_name,
                a.mime_type AS avatar_mime_type, a.size AS avatar_size
         FROM users u LEFT JOIN attachments a ON a.id = u.avatar_attachment_id
         WHERE u.id = ? AND u.password_hash IS NOT NULL`,
      )
      .get(userId),
    true,
  );
}

export function clearExpiredAccountBans(db, now = Date.now()) {
  return Number(
    db
      .prepare(
        `UPDATE users
         SET banned_until = NULL, banned_at = NULL, banned_by_user_id = NULL
         WHERE banned_until >= 0 AND banned_until <= ?`,
      )
      .run(now).changes,
  );
}

export function setAccountBan(db, userId, bannedUntil, bannedByUserId, bannedAt = Date.now()) {
  const info = db
    .prepare(
      `UPDATE users SET banned_until = ?, banned_at = ?, banned_by_user_id = ?
       WHERE id = ? AND password_hash IS NOT NULL`,
    )
    .run(bannedUntil, bannedAt, bannedByUserId, userId);
  return Number(info.changes);
}

export function clearAccountBan(db, userId) {
  return Number(
    db
      .prepare(
        `UPDATE users SET banned_until = NULL, banned_at = NULL, banned_by_user_id = NULL
         WHERE id = ? AND password_hash IS NOT NULL`,
      )
      .run(userId).changes,
  );
}

export function setAccountProfile(db, userId, displayName, bio, avatarAttachmentId) {
  const info = db
    .prepare(
      `UPDATE users SET display_name = ?, bio = ?, avatar_attachment_id = ?
       WHERE id = ? AND password_hash IS NOT NULL`,
    )
    .run(displayName, bio, avatarAttachmentId, userId);
  if (!info.changes) return undefined;
  return listAccounts(db).find((user) => user.id === userId);
}

export function createSession(db, tokenHash, userId, expiresAt) {
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(tokenHash, userId, expiresAt, Date.now());
}

export function getAccountBySession(db, tokenHash, now = Date.now()) {
  clearExpiredAccountBans(db, now);
  return mapAccount(
    db
      .prepare(
        `SELECT u.id, u.nickname, u.role, u.display_name, u.bio,
                u.banned_until, u.banned_at, u.banned_by_user_id, u.created_at,
                a.id AS avatar_id, a.original_name AS avatar_name,
                a.mime_type AS avatar_mime_type, a.size AS avatar_size
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN attachments a ON a.id = u.avatar_attachment_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.password_hash IS NOT NULL
               AND u.banned_until IS NULL`,
      )
      .get(tokenHash, now),
  );
}

export function deleteSession(db, tokenHash) {
  return Number(db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes);
}

export function deleteSessionsForUser(db, userId) {
  return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
}

export function deleteExpiredSessions(db, now = Date.now()) {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
}

export function getMessageReactions(db, messageId) {
  return reactionsByMessage(db, [messageId]).get(messageId) || [];
}

export function toggleReaction(db, messageId, roomId, userId, emoji) {
  const message = db.prepare('SELECT id FROM messages WHERE id = ? AND room_id = ?').get(messageId, roomId);
  if (!message) return undefined;
  const existing = db
    .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?')
    .get(messageId, emoji, userId);
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?').run(
      messageId,
      emoji,
      userId,
    );
  } else {
    db.prepare(
      'INSERT INTO reactions (message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(messageId, emoji, userId, Date.now());
  }
  return getMessageReactions(db, messageId);
}

export function createStandaloneThread(db, roomId, user, title, body) {
  const createdAt = Date.now();
  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO standalone_threads (room_id, title, author_user_id, author, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(roomId, title, user.id, user.username, createdAt);
    const threadId = Number(info.lastInsertRowid);
    if (body) {
      db.prepare(
        `INSERT INTO standalone_thread_messages
           (thread_id, author_user_id, author, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(threadId, user.id, user.username, body, createdAt);
    }
    db.exec('COMMIT');
    return {
      id: threadId,
      room_id: roomId,
      title,
      author_user_id: user.id,
      author: user.username,
      created_at: createdAt,
      reply_count: body ? 1 : 0,
      last_activity_at: createdAt,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listStandaloneThreads(db, roomId) {
  return db
    .prepare(
      `SELECT t.id, t.room_id, t.title, t.author_user_id, t.author, t.created_at,
              COUNT(m.id) AS reply_count, COALESCE(MAX(m.created_at), t.created_at) AS last_activity_at
       FROM standalone_threads t
       LEFT JOIN standalone_thread_messages m ON m.thread_id = t.id
       WHERE t.room_id = ?
       GROUP BY t.id
       ORDER BY last_activity_at DESC, t.id DESC`,
    )
    .all(roomId)
    .map((row) => ({
      id: Number(row.id),
      room_id: Number(row.room_id),
      title: row.title,
      author_user_id: Number(row.author_user_id),
      author: row.author,
      created_at: Number(row.created_at),
      reply_count: Number(row.reply_count),
      last_activity_at: Number(row.last_activity_at),
    }));
}

export function getStandaloneThread(db, threadId, roomId) {
  const row = db
    .prepare(
      `SELECT id, room_id, title, author_user_id, author, created_at
       FROM standalone_threads WHERE id = ? AND room_id = ?`,
    )
    .get(threadId, roomId);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    room_id: Number(row.room_id),
    title: row.title,
    author_user_id: Number(row.author_user_id),
    author: row.author,
    created_at: Number(row.created_at),
  };
}

export function getStandaloneThreadMessages(db, threadId, limit = 100) {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT id, thread_id, author_user_id, author, body, created_at, edited_at
         FROM standalone_thread_messages WHERE thread_id = ?
         ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(threadId, limit)
    .map((row) => ({
      id: Number(row.id),
      thread_id: Number(row.thread_id),
      author_user_id: Number(row.author_user_id),
      author: row.author,
      body: row.body,
      created_at: Number(row.created_at),
      edited_at: row.edited_at === null ? null : Number(row.edited_at),
    }));
}

export function insertStandaloneThreadMessage(db, threadId, user, body) {
  const createdAt = Date.now();
  const info = db
    .prepare(
      `INSERT INTO standalone_thread_messages
         (thread_id, author_user_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(threadId, user.id, user.username, body, createdAt);
  return {
    id: Number(info.lastInsertRowid),
    thread_id: threadId,
    author_user_id: user.id,
    author: user.username,
    body,
    created_at: createdAt,
    edited_at: null,
  };
}

export function getAppConfig(db, key) {
  return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
}

export function setAppConfig(db, key, value) {
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function upsertPushSubscription(db, userId, subscription) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO push_subscriptions
       (endpoint, user_id, p256dh, auth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       updated_at = excluded.updated_at`,
  ).run(
    subscription.endpoint,
    userId,
    subscription.keys.p256dh,
    subscription.keys.auth,
    now,
    now,
  );
}

export function removePushSubscription(db, userId, endpoint) {
  return db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(endpoint, userId).changes > 0;
}

export function deletePushSubscriptionByEndpoint(db, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function deletePushSubscriptionsForUser(db, userId) {
  return Number(db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId).changes);
}

export function listPushSubscriptions(db, excludeUserId = null) {
  const rows = excludeUserId === null
    ? db.prepare('SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions').all()
    : db
      .prepare(
        'SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions WHERE user_id != ?',
      )
      .all(excludeUserId);
  return rows.map((row) => ({
    user_id: Number(row.user_id),
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }));
}

export function getStandaloneThreadMessage(db, messageId, threadId) {
  const row = db
    .prepare(
      `SELECT id, thread_id, author_user_id, author, body, created_at, edited_at
       FROM standalone_thread_messages WHERE id = ? AND thread_id = ?`,
    )
    .get(messageId, threadId);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    thread_id: Number(row.thread_id),
    author_user_id: Number(row.author_user_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
    edited_at: row.edited_at === null ? null : Number(row.edited_at),
  };
}

export function updateStandaloneThreadMessage(db, messageId, threadId, body) {
  const editedAt = Date.now();
  const info = db
    .prepare(
      'UPDATE standalone_thread_messages SET body = ?, edited_at = ? WHERE id = ? AND thread_id = ?',
    )
    .run(body, editedAt, messageId, threadId);
  return info.changes ? editedAt : undefined;
}

export function deleteStandaloneThreadMessage(db, messageId, threadId) {
  const info = db
    .prepare('DELETE FROM standalone_thread_messages WHERE id = ? AND thread_id = ?')
    .run(messageId, threadId);
  return info.changes > 0;
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
