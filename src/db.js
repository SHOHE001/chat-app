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
  posting_blocked_at INTEGER,
  posting_blocked_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  allowed_roles TEXT,
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
  attachment_id TEXT REFERENCES attachments(id),
  hidden_at INTEGER,
  hidden_reason TEXT
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
  edited_at INTEGER,
  hidden_at INTEGER,
  hidden_reason TEXT
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
CREATE TABLE IF NOT EXISTS muted_rooms (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
CREATE TABLE IF NOT EXISTS message_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message', 'thread')),
  target_message_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  thread_id INTEGER,
  reason_category TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  message_author_user_id INTEGER,
  message_author TEXT NOT NULL,
  message_body TEXT NOT NULL,
  message_created_at INTEGER NOT NULL,
  attachment_json TEXT,
  context_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ai_status TEXT NOT NULL DEFAULT 'pending',
  ai_result TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_user_id, target_kind, target_message_id)
);
CREATE TABLE IF NOT EXISTS moderation_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_key TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('patrol', 'report')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message', 'thread')),
  target_message_id INTEGER NOT NULL,
  content_version INTEGER NOT NULL,
  report_id INTEGER,
  author_user_id INTEGER,
  room_id INTEGER NOT NULL,
  thread_id INTEGER,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('keep', 'hide')),
  rationale TEXT NOT NULL,
  haiku_result TEXT,
  opus_result TEXT,
  completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moderation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_message_id INTEGER,
  room_id INTEGER,
  thread_id INTEGER,
  user_id INTEGER,
  reason TEXT NOT NULL,
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

  // user_version: 0=新規、1=旧メッセージ、2=メッセージスレッド、
  // 3=アカウント/リアクション/独立スレッド、4=添付ファイル、5=プロフィール、
  // 6=メッセージ編集日時、7=Web Push購読とアプリ設定、8=アカウントBAN、
  // 9=通報スナップショットとAI審査状態、10=AI巡回・非表示・投稿停止、
  // 11=ロール限定チャンネル、12=ユーザー別チャンネル通知設定。
  let { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
  if (userVersion === 0) {
    db.exec('PRAGMA user_version = 12');
    userVersion = 12;
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

  if (userVersion === 8) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reporter_user_id INTEGER NOT NULL REFERENCES users(id),
          target_kind TEXT NOT NULL CHECK (target_kind IN ('message', 'thread')),
          target_message_id INTEGER NOT NULL,
          room_id INTEGER NOT NULL,
          thread_id INTEGER,
          reason_category TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          message_author_user_id INTEGER,
          message_author TEXT NOT NULL,
          message_body TEXT NOT NULL,
          message_created_at INTEGER NOT NULL,
          attachment_json TEXT,
          context_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          ai_status TEXT NOT NULL DEFAULT 'pending',
          ai_result TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (reporter_user_id, target_kind, target_message_id)
        );
      `);
      db.exec('PRAGMA user_version = 9');
      db.exec('COMMIT');
      userVersion = 9;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 9) {
    const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
    const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
    const threadMessageColumns = new Set(
      db.prepare('PRAGMA table_info(standalone_thread_messages)').all().map((column) => column.name),
    );
    db.exec('BEGIN');
    try {
      if (!userColumns.has('posting_blocked_at')) {
        db.exec('ALTER TABLE users ADD COLUMN posting_blocked_at INTEGER');
      }
      if (!userColumns.has('posting_blocked_reason')) {
        db.exec('ALTER TABLE users ADD COLUMN posting_blocked_reason TEXT');
      }
      if (!messageColumns.has('hidden_at')) db.exec('ALTER TABLE messages ADD COLUMN hidden_at INTEGER');
      if (!messageColumns.has('hidden_reason')) db.exec('ALTER TABLE messages ADD COLUMN hidden_reason TEXT');
      if (!threadMessageColumns.has('hidden_at')) {
        db.exec('ALTER TABLE standalone_thread_messages ADD COLUMN hidden_at INTEGER');
      }
      if (!threadMessageColumns.has('hidden_reason')) {
        db.exec('ALTER TABLE standalone_thread_messages ADD COLUMN hidden_reason TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS moderation_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_key TEXT UNIQUE NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('patrol', 'report')),
          target_kind TEXT NOT NULL CHECK (target_kind IN ('message', 'thread')),
          target_message_id INTEGER NOT NULL,
          content_version INTEGER NOT NULL,
          report_id INTEGER,
          author_user_id INTEGER,
          room_id INTEGER NOT NULL,
          thread_id INTEGER,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('keep', 'hide')),
          rationale TEXT NOT NULL,
          haiku_result TEXT,
          opus_result TEXT,
          completed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS moderation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          target_kind TEXT,
          target_message_id INTEGER,
          room_id INTEGER,
          thread_id INTEGER,
          user_id INTEGER,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 10');
      db.exec('COMMIT');
      userVersion = 10;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 10) {
    const roomColumns = new Set(
      db.prepare('PRAGMA table_info(rooms)').all().map((column) => column.name),
    );
    db.exec('BEGIN');
    try {
      if (!roomColumns.has('allowed_roles')) {
        db.exec('ALTER TABLE rooms ADD COLUMN allowed_roles TEXT');
      }
      db.exec('PRAGMA user_version = 11');
      db.exec('COMMIT');
      userVersion = 11;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  if (userVersion === 11) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS muted_rooms (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, room_id)
        );
      `);
      db.exec('PRAGMA user_version = 12');
      db.exec('COMMIT');
      userVersion = 12;
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_muted_rooms_room ON muted_rooms(room_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_banned_until ON users(banned_until)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_reports_created ON message_reports(created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_reports_status ON message_reports(status, ai_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_moderation_reviews_target ON moderation_reviews(target_kind, target_message_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_moderation_reviews_author ON moderation_reviews(author_user_id, completed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_moderation_events_id ON moderation_events(id)');
  db.exec('PRAGMA busy_timeout = 5000');
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
         WHERE m.room_id = ? AND m.thread_root_id IS NULL AND m.hidden_at IS NULL
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
         WHERE thread_root_id = ? AND room_id = ? AND hidden_at IS NULL
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
              thread_root_id, attachment_id, hidden_at, hidden_reason
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
    hidden_at: row.hidden_at === null ? null : Number(row.hidden_at),
    hidden_reason: row.hidden_reason || null,
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

function reportContextRows(db, targetKind, message, roomId, threadId) {
  const columns = 'id, author_user_id, author, body, created_at';
  let before;
  let after;
  if (targetKind === 'thread') {
    before = db
      .prepare(
        `SELECT ${columns} FROM standalone_thread_messages
         WHERE thread_id = ? AND id <= ? ORDER BY id DESC LIMIT 3`,
      )
      .all(threadId, message.id)
      .reverse();
    after = db
      .prepare(
        `SELECT ${columns} FROM standalone_thread_messages
         WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT 2`,
      )
      .all(threadId, message.id);
  } else {
    before = db
      .prepare(
        `SELECT ${columns} FROM messages
         WHERE room_id = ? AND thread_root_id IS NULL AND id <= ? ORDER BY id DESC LIMIT 3`,
      )
      .all(roomId, message.id)
      .reverse();
    after = db
      .prepare(
        `SELECT ${columns} FROM messages
         WHERE room_id = ? AND thread_root_id IS NULL AND id > ? ORDER BY id ASC LIMIT 2`,
      )
      .all(roomId, message.id);
  }
  return [...before, ...after].map((row) => ({
    id: Number(row.id),
    author_user_id: row.author_user_id === null ? null : Number(row.author_user_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
  }));
}

export function createMessageReport(
  db,
  { reporterUserId, targetKind, message, roomId, threadId = null, category, details = '', attachment = null },
) {
  const context = reportContextRows(db, targetKind, message, roomId, threadId);
  const createdAt = Date.now();
  try {
    const info = db
      .prepare(
        `INSERT INTO message_reports (
           reporter_user_id, target_kind, target_message_id, room_id, thread_id,
           reason_category, details, message_author_user_id, message_author,
           message_body, message_created_at, attachment_json, context_json,
           status, ai_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'pending', ?)`,
      )
      .run(
        reporterUserId,
        targetKind,
        message.id,
        roomId,
        threadId,
        category,
        details,
        message.author_user_id,
        message.author,
        message.body,
        message.created_at,
        attachment ? JSON.stringify(attachment) : null,
        JSON.stringify(context),
        createdAt,
      );
    return { id: Number(info.lastInsertRowid), created_at: createdAt };
  } catch (err) {
    const duplicate =
      err.errcode === 2067 ||
      (typeof err.message === 'string' && err.message.includes('message_reports.reporter_user_id'));
    if (duplicate) err.code = 'REPORT_EXISTS';
    throw err;
  }
}

export function listMessageReports(db, limit = 100) {
  return db
    .prepare(
      `SELECT r.*, u.nickname AS reporter_username
       FROM message_reports r
       JOIN users u ON u.id = r.reporter_user_id
       ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      id: Number(row.id),
      reporter_user_id: Number(row.reporter_user_id),
      reporter_username: row.reporter_username,
      target_kind: row.target_kind,
      target_message_id: Number(row.target_message_id),
      room_id: Number(row.room_id),
      thread_id: row.thread_id === null ? null : Number(row.thread_id),
      category: row.reason_category,
      details: row.details,
      message: {
        author_user_id: row.message_author_user_id === null ? null : Number(row.message_author_user_id),
        author: row.message_author,
        body: row.message_body,
        created_at: Number(row.message_created_at),
        attachment: row.attachment_json ? JSON.parse(row.attachment_json) : null,
      },
      context: JSON.parse(row.context_json),
      status: row.status,
      ai_status: row.ai_status,
      ai_result: row.ai_result || null,
      created_at: Number(row.created_at),
    }));
}

export function listPendingReportsForAi(db, limit = 50) {
  return listMessageReports(db, Math.max(limit, 100))
    .filter((report) => report.ai_status === 'pending')
    .slice(0, limit);
}

export function listPendingPatrolMessages(db, limit = 50) {
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT 'message' AS target_kind, m.id AS target_message_id, m.room_id,
             NULL AS thread_id, m.author_user_id, m.author, m.body, m.created_at,
             COALESCE(m.edited_at, m.created_at) AS content_version
      FROM messages m
      WHERE m.hidden_at IS NULL
      UNION ALL
      SELECT 'thread', m.id, t.room_id, m.thread_id, m.author_user_id, m.author,
             m.body, m.created_at, COALESCE(m.edited_at, m.created_at)
      FROM standalone_thread_messages m
      JOIN standalone_threads t ON t.id = m.thread_id
      WHERE m.hidden_at IS NULL
    ) candidates
    WHERE NOT EXISTS (
      SELECT 1 FROM moderation_reviews r
      WHERE r.review_key = 'patrol:' || candidates.target_kind || ':' ||
        candidates.target_message_id || ':' || candidates.content_version
    )
    ORDER BY created_at ASC, target_kind ASC, target_message_id ASC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    target_kind: row.target_kind,
    target_message_id: Number(row.target_message_id),
    room_id: Number(row.room_id),
    thread_id: row.thread_id === null ? null : Number(row.thread_id),
    author_user_id: row.author_user_id === null ? null : Number(row.author_user_id),
    author: row.author,
    body: row.body,
    created_at: Number(row.created_at),
    content_version: Number(row.content_version),
    review_key: `patrol:${row.target_kind}:${row.target_message_id}:${row.content_version}`,
  }));
}

export function applyModerationDecision(
  db,
  review,
  { now = Date.now(), strikeThreshold = 3, strikeWindowMs = 30 * 24 * 60 * 60 * 1000 } = {},
) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO moderation_reviews (
        review_key, source, target_kind, target_message_id, content_version,
        report_id, author_user_id, room_id, thread_id, category, severity,
        decision, rationale, haiku_result, opus_result, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      review.review_key, review.source, review.target_kind, review.target_message_id,
      review.content_version, review.report_id ?? null, review.author_user_id ?? null,
      review.room_id, review.thread_id ?? null, review.category, review.severity,
      review.decision, review.rationale, review.haiku_result ?? null,
      review.opus_result ?? null, now,
    );
    if (!inserted.changes) {
      db.exec('COMMIT');
      return { applied: false, hidden: false, postingBlocked: false, strikes: 0 };
    }

    let hidden = false;
    if (review.decision === 'hide') {
      const table = review.target_kind === 'thread' ? 'standalone_thread_messages' : 'messages';
      const versionCheck = review.source === 'patrol'
        ? ' AND COALESCE(edited_at, created_at) = ?'
        : '';
      const params = [now, review.rationale, review.target_message_id];
      if (review.source === 'patrol') params.push(review.content_version);
      const info = db.prepare(
        `UPDATE ${table} SET hidden_at = ?, hidden_reason = ? WHERE id = ? AND hidden_at IS NULL${versionCheck}`,
      ).run(...params);
      hidden = info.changes > 0;
      if (hidden) {
        db.prepare(`
          INSERT INTO moderation_events (
            action, target_kind, target_message_id, room_id, thread_id, user_id, reason, created_at
          ) VALUES ('message_hidden', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          review.target_kind, review.target_message_id, review.room_id,
          review.thread_id ?? null, review.author_user_id ?? null, review.rationale, now,
        );
      }
    }

    if (review.report_id != null) {
      db.prepare(`
        UPDATE message_reports
        SET status = 'resolved', ai_status = 'complete', ai_result = ?
        WHERE id = ?
      `).run(review.opus_result ?? JSON.stringify({ decision: review.decision }), review.report_id);
    }

    let strikes = 0;
    let postingBlocked = false;
    if (
      review.decision === 'hide' && review.author_user_id != null &&
      (hidden || review.source === 'report')
    ) {
      strikes = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT DISTINCT target_kind, target_message_id
          FROM moderation_reviews
          WHERE author_user_id = ? AND decision = 'hide' AND completed_at >= ?
        )
      `).get(review.author_user_id, now - strikeWindowMs).count);
      if (strikes >= strikeThreshold) {
        const reason = `AI審査で30日以内に${strikes}件の違反が確認されました`;
        const info = db.prepare(`
          UPDATE users SET posting_blocked_at = ?, posting_blocked_reason = ?
          WHERE id = ? AND posting_blocked_at IS NULL AND password_hash IS NOT NULL
        `).run(now, reason, review.author_user_id);
        postingBlocked = info.changes > 0;
        if (postingBlocked) {
          db.prepare(`
            INSERT INTO moderation_events (action, user_id, reason, created_at)
            VALUES ('posting_blocked', ?, ?, ?)
          `).run(review.author_user_id, reason, now);
        }
      }
    }
    db.exec('COMMIT');
    return { applied: true, hidden, postingBlocked, strikes };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function latestModerationEventId(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM moderation_events').get().id);
}

export function listModerationEventsAfter(db, afterId, limit = 100) {
  return db.prepare(`
    SELECT id, action, target_kind, target_message_id, room_id, thread_id,
           user_id, reason, created_at
    FROM moderation_events WHERE id > ? ORDER BY id ASC LIMIT ?
  `).all(afterId, limit).map((row) => ({
    id: Number(row.id),
    action: row.action,
    target_kind: row.target_kind || null,
    target_message_id: row.target_message_id === null ? null : Number(row.target_message_id),
    room_id: row.room_id === null ? null : Number(row.room_id),
    thread_id: row.thread_id === null ? null : Number(row.thread_id),
    user_id: row.user_id === null ? null : Number(row.user_id),
    reason: row.reason,
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
    posting_blocked_at: row.posting_blocked_at === null || row.posting_blocked_at === undefined
      ? null
      : Number(row.posting_blocked_at),
    posting_blocked_reason: row.posting_blocked_reason || null,
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
      posting_blocked_at: null,
      posting_blocked_reason: null,
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
                u.banned_until, u.banned_at, u.banned_by_user_id,
                u.posting_blocked_at, u.posting_blocked_reason, u.created_at,
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
              u.banned_until, u.banned_at, u.banned_by_user_id,
              u.posting_blocked_at, u.posting_blocked_reason, u.created_at,
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
                u.banned_until, u.banned_at, u.banned_by_user_id,
                u.posting_blocked_at, u.posting_blocked_reason, u.created_at,
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

export function clearPostingBlock(db, userId, reason = '管理者が解除', now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db
      .prepare(
        `UPDATE users SET posting_blocked_at = NULL, posting_blocked_reason = NULL
         WHERE id = ? AND posting_blocked_at IS NOT NULL AND password_hash IS NOT NULL`,
      )
      .run(userId);
    if (info.changes) {
      db.prepare(
        `INSERT INTO moderation_events (action, user_id, reason, created_at)
         VALUES ('posting_unblocked', ?, ?, ?)`,
      ).run(userId, reason, now);
    }
    db.exec('COMMIT');
    return Number(info.changes);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function hideMessageAsModerator(
  db,
  { targetKind, messageId, roomId, threadId = null, moderatorUserId, reason = '管理者が非表示' },
  now = Date.now(),
) {
  const table = targetKind === 'thread' ? 'standalone_thread_messages' : 'messages';
  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db.prepare(
      `UPDATE ${table} SET hidden_at = ?, hidden_reason = ? WHERE id = ? AND hidden_at IS NULL`,
    ).run(now, reason, messageId);
    if (info.changes) {
      db.prepare(`
        INSERT INTO moderation_events (
          action, target_kind, target_message_id, room_id, thread_id, user_id, reason, created_at
        ) VALUES ('message_hidden_manual', ?, ?, ?, ?, ?, ?, ?)
      `).run(targetKind, messageId, roomId, threadId, moderatorUserId, reason, now);
    }
    db.exec('COMMIT');
    return info.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
                u.banned_until, u.banned_at, u.banned_by_user_id,
                u.posting_blocked_at, u.posting_blocked_reason, u.created_at,
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
       LEFT JOIN standalone_thread_messages m ON m.thread_id = t.id AND m.hidden_at IS NULL
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
         FROM standalone_thread_messages WHERE thread_id = ? AND hidden_at IS NULL
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

export function listPushSubscriptions(db, excludeUserId = null, roomId = null) {
  const rows = excludeUserId === null
    ? db.prepare(`
        SELECT p.endpoint, p.user_id, p.p256dh, p.auth, u.role, mr.room_id AS muted_room_id
        FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        LEFT JOIN muted_rooms mr ON mr.user_id = p.user_id AND mr.room_id = ?
      `).all(roomId)
    : db
      .prepare(
        `SELECT p.endpoint, p.user_id, p.p256dh, p.auth, u.role, mr.room_id AS muted_room_id
         FROM push_subscriptions p JOIN users u ON u.id = p.user_id
         LEFT JOIN muted_rooms mr ON mr.user_id = p.user_id AND mr.room_id = ?
         WHERE p.user_id != ?`,
      )
      .all(roomId, excludeUserId);
  return rows.map((row) => ({
    user_id: Number(row.user_id),
    role: row.role,
    notifications_enabled: row.muted_room_id === null,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }));
}

export function listMutedRoomIds(db, userId) {
  return db
    .prepare('SELECT room_id FROM muted_rooms WHERE user_id = ? ORDER BY room_id')
    .all(userId)
    .map((row) => Number(row.room_id));
}

export function setRoomNotificationEnabled(db, userId, roomId, enabled) {
  if (enabled) {
    db.prepare('DELETE FROM muted_rooms WHERE user_id = ? AND room_id = ?').run(userId, roomId);
    return;
  }
  db.prepare(
    `INSERT INTO muted_rooms (user_id, room_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, room_id) DO NOTHING`,
  ).run(userId, roomId, Date.now());
}

export function getStandaloneThreadMessage(db, messageId, threadId) {
  const row = db
    .prepare(
      `SELECT id, thread_id, author_user_id, author, body, created_at, edited_at,
              hidden_at, hidden_reason
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
    hidden_at: row.hidden_at === null ? null : Number(row.hidden_at),
    hidden_reason: row.hidden_reason || null,
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
 * @returns {{id: number, name: string, allowed_roles: string[], created_at: number}[]}
 */
export function listRooms(db) {
  const rows = db.prepare('SELECT id, name, allowed_roles, created_at FROM rooms ORDER BY id ASC').all();
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    allowed_roles: row.allowed_roles ? JSON.parse(row.allowed_roles) : [],
    created_at: Number(row.created_at),
  }));
}

/**
 * ルームを作成し、挿入行を返す。name の UNIQUE 制約違反はそのまま throw する
 * （呼び出し側で捕捉して room_exists に変換する）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @param {string[]} allowedRoles
 */
export function createRoom(db, name, allowedRoles = []) {
  const createdAt = Date.now();
  const stmt = db.prepare('INSERT INTO rooms (name, allowed_roles, created_at) VALUES (?, ?, ?)');
  const info = stmt.run(name, allowedRoles.length ? JSON.stringify(allowedRoles) : null, createdAt);
  return {
    id: Number(info.lastInsertRowid),
    name,
    allowed_roles: allowedRoles,
    created_at: createdAt,
  };
}

/**
 * roomId で指定したルームの行を返す（存在しなければ undefined）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} roomId
 */
export function getRoomById(db, roomId) {
  const row = db.prepare('SELECT id, name, allowed_roles, created_at FROM rooms WHERE id = ?').get(roomId);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    name: row.name,
    allowed_roles: row.allowed_roles ? JSON.parse(row.allowed_roles) : [],
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
