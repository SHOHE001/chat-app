// Acceptance tests for #3 スレッド: ルーム内スレッド（誰でも作成可）
//
// 実行: node --test
// plan: features/3-task/plan.md のテスト計画 T31〜T37。
// rooms.test.js の inbox（キュー方式受信）ヘルパーパターンを踏襲する。
//
// fixture 契約（plan.md より）: スレッド返信の作成は原則 WS 経由
// （{type:'message', body, threadRootId}）。insertMessage を直接呼ぶ場合は
// 同 room に存在する root（thread_root_id IS NULL）の id だけを渡すこと。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { createChatServer } from '../src/server.js';
import {
  openDb,
  insertMessage,
  getRecentMessages,
  getThreadMessages,
  getDefaultRoomId,
} from '../src/db.js';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let counter = 0;

function tmpDbPath() {
  return path.join(tmpdir(), `chat-app-threads-test-${process.pid}-${counter++}.db`);
}

async function startServer({ dbPath = tmpDbPath(), adminPassword } = {}) {
  const app = createChatServer({
    dbPath,
    staticDir: 'public',
    adminPassword,
    allowLegacyJoin: true,
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  return { app, port, dbPath, url: `ws://127.0.0.1:${port}/` };
}

async function stopServer(ctx) {
  await new Promise((resolve) => ctx.app.close(resolve));
  if (existsSync(ctx.dbPath)) {
    await rm(ctx.dbPath, { force: true });
  }
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

/**
 * ws の 'message' イベントを常時バッファリングする inbox を作る（rooms.test.js と同じ方式）。
 */
function createInbox(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(parsed);
    } else {
      queue.push(parsed);
    }
  });
  return function next() {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function connectClient(ctx) {
  const ws = new WebSocket(ctx.url);
  await waitForOpen(ws);
  const next = createInbox(ws);
  return { ws, next };
}

async function joinClient(ctx, nickname) {
  const client = await connectClient(ctx);
  client.ws.send(JSON.stringify({ type: 'join', nickname }));
  const history = await client.next();
  const rooms = await client.next();
  return { ...client, history, rooms };
}

async function authAdmin(client) {
  client.ws.send(
    JSON.stringify({ type: 'register', username: `owner-${counter++}`, password: 'password-123' }),
  );
  return client.next();
}

function timeout(ms, tag = 'timeout') {
  return new Promise((resolve) => setTimeout(() => resolve(tag), ms));
}

function countMessages(db) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c);
}

test('T31_thread_reply_and_history root投稿→threadRootId付きmessageで返信→open_threadでthread_history（root+返信id昇順）が取得できる', async () => {
  const ctx = await startServer();
  try {
    const client = await joinClient(ctx, 'なまえ');

    client.ws.send(JSON.stringify({ type: 'message', body: 'しつもんです' }));
    const rootBroadcast = await client.next();
    assert.equal(rootBroadcast.type, 'message');
    assert.equal(rootBroadcast.message.thread_root_id, null);
    const rootId = rootBroadcast.message.id;

    client.ws.send(JSON.stringify({ type: 'message', body: 'こたえ1', threadRootId: rootId }));
    const reply1Broadcast = await client.next();
    assert.equal(reply1Broadcast.type, 'message');
    assert.equal(reply1Broadcast.message.thread_root_id, rootId);

    client.ws.send(JSON.stringify({ type: 'message', body: 'こたえ2', threadRootId: rootId }));
    const reply2Broadcast = await client.next();
    assert.equal(reply2Broadcast.message.thread_root_id, rootId);

    client.ws.send(JSON.stringify({ type: 'open_thread', rootId }));
    const threadHistory = await client.next();
    assert.equal(threadHistory.type, 'thread_history');
    assert.equal(threadHistory.rootId, rootId);
    assert.equal(threadHistory.root.id, rootId);
    assert.equal(threadHistory.root.body, 'しつもんです');
    assert.deepEqual(
      threadHistory.messages.map((m) => m.body),
      ['こたえ1', 'こたえ2'],
    );
    const ids = threadHistory.messages.map((m) => m.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
    for (const m of threadHistory.messages) {
      assert.equal(m.thread_root_id, rootId);
    }

    client.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T32_thread_realtime 同ルームの別クライアントにスレッド返信がtype:messageで届きthread_root_idがrootのid', async () => {
  const ctx = await startServer();
  try {
    const clientA = await joinClient(ctx, 'えーさん');
    const clientB = await joinClient(ctx, 'びーさん');

    clientA.ws.send(JSON.stringify({ type: 'message', body: 'root' }));
    const rootBroadcastA = await clientA.next();
    const rootBroadcastB = await clientB.next();
    assert.equal(rootBroadcastA.message.body, 'root');
    assert.equal(rootBroadcastB.message.body, 'root');
    const rootId = rootBroadcastA.message.id;

    const bReplyPromise = clientB.next();
    clientA.ws.send(JSON.stringify({ type: 'message', body: 'reply', threadRootId: rootId }));
    const aOwnReply = await clientA.next();
    assert.equal(aOwnReply.message.thread_root_id, rootId);

    const bReply = await bReplyPromise;
    assert.equal(bReply.type, 'message');
    assert.equal(bReply.message.thread_root_id, rootId);
    assert.equal(bReply.message.body, 'reply');

    clientA.ws.close();
    clientB.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T33_timeline_thread_meta 返信2件後のhistory/room_switchedでroot行にthread_reply_count:2とthread_last_reply_at、返信0件行はcount0/null、スレッド返信はタイムライン不在', async () => {
  const ctx = await startServer();
  try {
    const client = await joinClient(ctx, 'てすと');
    const defaultRoomId = client.history.roomId;

    client.ws.send(JSON.stringify({ type: 'message', body: 'root1' }));
    const root1Broadcast = await client.next();
    const root1Id = root1Broadcast.message.id;

    client.ws.send(JSON.stringify({ type: 'message', body: 'root2' }));
    const root2Broadcast = await client.next();
    const root2Id = root2Broadcast.message.id;

    client.ws.send(JSON.stringify({ type: 'message', body: 'reply1', threadRootId: root1Id }));
    await client.next();

    client.ws.send(JSON.stringify({ type: 'message', body: 'reply2', threadRootId: root1Id }));
    const reply2Broadcast = await client.next();

    // 同じ room へ switch_room することで room_switched を再取得するトリガーにする
    // （管理者権限不要。switch_room は現在ルームと同じ id でも許可される）。
    client.ws.send(JSON.stringify({ type: 'switch_room', roomId: defaultRoomId }));
    const switched = await client.next();
    assert.equal(switched.type, 'room_switched');

    const root1Row = switched.messages.find((m) => m.id === root1Id);
    const root2Row = switched.messages.find((m) => m.id === root2Id);
    assert.ok(root1Row);
    assert.ok(root2Row);
    assert.equal(root1Row.thread_reply_count, 2);
    assert.equal(root1Row.thread_last_reply_at, reply2Broadcast.message.created_at);
    assert.equal(root2Row.thread_reply_count, 0);
    assert.equal(root2Row.thread_last_reply_at, null);

    // スレッド返信自体はタイムラインに現れない
    assert.ok(!switched.messages.some((m) => m.body === 'reply1' || m.body === 'reply2'));

    client.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T34_boundary_thread_validation 不存在id/文字列"1"/小数/0/他ルームroot/ネスト返信はthread_not_foundでmessages行数不変、join前open_threadはnot_joined', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'べつのへや' }));
    const roomsMsg = await admin.next();
    const otherRoom = roomsMsg.rooms.find((r) => r.name === 'べつのへや');
    assert.ok(otherRoom);

    admin.ws.send(JSON.stringify({ type: 'switch_room', roomId: otherRoom.id }));
    await admin.next();
    admin.ws.send(JSON.stringify({ type: 'message', body: 'otherRoomRoot' }));
    const otherRootBroadcast = await admin.next();
    const otherRoomRootId = otherRootBroadcast.message.id;

    const client = await joinClient(ctx, 'てすと');

    client.ws.send(JSON.stringify({ type: 'message', body: 'root' }));
    const rootBroadcast = await client.next();
    const rootId = rootBroadcast.message.id;

    client.ws.send(JSON.stringify({ type: 'message', body: 'reply', threadRootId: rootId }));
    const replyBroadcast = await client.next();
    const replyId = replyBroadcast.message.id;

    const db = openDb(ctx.dbPath);
    const before = countMessages(db);

    const invalidValues = [999999, '1', 1.5, 0, otherRoomRootId, replyId];

    for (const value of invalidValues) {
      client.ws.send(JSON.stringify({ type: 'message', body: 'nested', threadRootId: value }));
      const res = await client.next();
      assert.equal(res.type, 'error');
      assert.equal(res.reason, 'thread_not_found');
    }

    for (const value of invalidValues) {
      client.ws.send(JSON.stringify({ type: 'open_thread', rootId: value }));
      const res = await client.next();
      assert.equal(res.type, 'error');
      assert.equal(res.reason, 'thread_not_found');
    }

    const after = countMessages(db);
    assert.equal(after, before);

    const preJoinClient = await connectClient(ctx);
    preJoinClient.ws.send(JSON.stringify({ type: 'open_thread', rootId }));
    const notJoinedRes = await preJoinClient.next();
    assert.equal(notJoinedRes.type, 'error');
    assert.equal(notJoinedRes.reason, 'not_joined');

    admin.ws.close();
    client.ws.close();
    preJoinClient.ws.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T35_migration_v1_to_v10 旧スキーマDBがv10になり既存行が読め、再オープンも冪等に成功', async () => {
  const dbPath = tmpDbPath();
  try {
    // 旧スキーマ（thread_root_id 列なし）を手組みし user_version=1 にする。
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    raw.exec('PRAGMA user_version = 1');
    raw.prepare('INSERT INTO rooms (name, created_at) VALUES (?, ?)').run('全体', Date.now());
    const roomRow = raw.prepare('SELECT id FROM rooms WHERE name = ?').get('全体');
    raw
      .prepare('INSERT INTO messages (room_id, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(roomRow.id, 'ふるいひと', 'old message', Date.now());
    raw.close();

    const db = openDb(dbPath);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, 10);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_reports'").get());

    const roomId = getDefaultRoomId(db);
    const messages = getRecentMessages(db, roomId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'old message');
    assert.equal(messages[0].thread_reply_count, 0);
    assert.equal(messages[0].thread_last_reply_at, null);

    const rootId = messages[0].id;
    const reply = insertMessage(db, roomId, 'あたらしいひと', 'reply after migration', rootId);
    assert.equal(reply.thread_root_id, rootId);
    const threadMessages = getThreadMessages(db, rootId, roomId);
    assert.equal(threadMessages.length, 1);
    assert.equal(threadMessages[0].body, 'reply after migration');

    db.close();

    // 同じ DB を再度 openDb しても壊れない（冪等）
    const db2 = openDb(dbPath);
    const version2 = db2.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version2, 10);
    const messagesAfterReopen = getRecentMessages(db2, roomId);
    assert.equal(messagesAfterReopen.length, 1);
    db2.close();
  } finally {
    if (existsSync(dbPath)) {
      await rm(dbPath, { force: true });
    }
  }

  // 「列あり・user_version=1」の中間状態 DB でも openDb が成功し version 9 になる
  const dbPath2 = tmpDbPath();
  try {
    const raw2 = new DatabaseSync(dbPath2);
    raw2.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        thread_root_id INTEGER REFERENCES messages(id)
      );
    `);
    raw2.exec('PRAGMA user_version = 1');
    raw2.close();

    const db3 = openDb(dbPath2);
    const version3 = db3.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version3, 10);
    db3.close();
  } finally {
    if (existsSync(dbPath2)) {
      await rm(dbPath2, { force: true });
    }
  }
});

test('T36_thread_room_isolation ルームAのrootへのスレッド返信はルームB在室クライアントに届かない', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'ルームA' }));
    const roomsAfterA = await admin.next();
    const roomA = roomsAfterA.rooms.find((r) => r.name === 'ルームA');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'ルームB' }));
    const roomsAfterB = await admin.next();
    const roomB = roomsAfterB.rooms.find((r) => r.name === 'ルームB');

    const clientA = await joinClient(ctx, 'えー');
    clientA.ws.send(JSON.stringify({ type: 'switch_room', roomId: roomA.id }));
    await clientA.next();

    const clientB = await joinClient(ctx, 'びー');
    clientB.ws.send(JSON.stringify({ type: 'switch_room', roomId: roomB.id }));
    await clientB.next();

    clientA.ws.send(JSON.stringify({ type: 'message', body: 'root' }));
    const rootBroadcast = await clientA.next();
    const rootId = rootBroadcast.message.id;

    const receivedByB = clientB.next();
    clientA.ws.send(JSON.stringify({ type: 'message', body: 'reply', threadRootId: rootId }));
    await clientA.next(); // A 自身の受信を消費

    const raceResult = await Promise.race([receivedByB, timeout(200)]);
    assert.equal(raceResult, 'timeout');

    admin.ws.close();
    clientA.ws.close();
    clientB.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T37_thread_persistence スレッド返信投稿後にサーバーclose→openDbし直すとgetThreadMessagesで返信が残っている', async () => {
  const dbPath = tmpDbPath();
  try {
    const ctx = await startServer({ dbPath });

    const client = await joinClient(ctx, 'えいぞく');

    client.ws.send(JSON.stringify({ type: 'message', body: 'root' }));
    const rootBroadcast = await client.next();
    const rootId = rootBroadcast.message.id;
    const roomId = rootBroadcast.message.room_id;

    client.ws.send(JSON.stringify({ type: 'message', body: 'のこる返信', threadRootId: rootId }));
    await client.next();

    client.ws.close();
    await new Promise((resolve) => ctx.app.close(resolve));

    const db = openDb(dbPath);
    const threadMessages = getThreadMessages(db, rootId, roomId);
    assert.equal(threadMessages.length, 1);
    assert.equal(threadMessages[0].body, 'のこる返信');
    db.close();
  } finally {
    if (existsSync(dbPath)) {
      await rm(dbPath, { force: true });
    }
  }
});

test('T38_thread_root_id_null_compat threadRootId:nullを明示送信すると通常のタイムライン投稿としてbroadcastされthread_root_idがnullでエラーにならない', async () => {
  const ctx = await startServer();
  try {
    const client = await joinClient(ctx, 'ぬるくん');

    client.ws.send(JSON.stringify({ type: 'message', body: 'ふつうのとうこう', threadRootId: null }));
    const broadcast = await client.next();
    assert.equal(broadcast.type, 'message');
    assert.equal(broadcast.message.body, 'ふつうのとうこう');
    assert.equal(broadcast.message.thread_root_id, null);

    client.ws.close();
  } finally {
    await stopServer(ctx);
  }
});
