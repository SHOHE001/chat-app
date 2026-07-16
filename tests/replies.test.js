import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';
import {
  deleteMessage,
  getDefaultRoomId,
  getRecentMessages,
  insertMessage,
} from '../src/db.js';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let counter = 0;
const tmpDbPath = () => path.join(tmpdir(), `chat-app-replies-${process.pid}-${counter++}.db`);

async function startServer() {
  const dbPath = tmpDbPath();
  const app = createChatServer({ dbPath, staticDir: 'public', allowLegacyJoin: true });
  await new Promise((resolve) => app.server.listen(0, resolve));
  return { app, dbPath, url: `ws://127.0.0.1:${app.server.address().port}/` };
}

async function stopServer(ctx) {
  await new Promise((resolve) => ctx.app.close(resolve));
  if (existsSync(ctx.dbPath)) await rm(ctx.dbPath, { force: true });
}

async function client(ctx, nickname) {
  const ws = new WebSocket(ctx.url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(value);
    else queue.push(value);
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve));
  ws.send(JSON.stringify({ type: 'join', nickname }));
  await next();
  await next();
  return { ws, next };
}

test('R01 replyは同じチャンネルへリアルタイム配信され、履歴にも参照本文が残る', async () => {
  const ctx = await startServer();
  try {
    const alice = await client(ctx, 'alice');
    const bob = await client(ctx, 'bob');
    alice.ws.send(JSON.stringify({ type: 'message', body: '元のメッセージ' }));
    const rootA = await alice.next();
    await bob.next();

    bob.ws.send(JSON.stringify({
      type: 'message',
      body: 'これが返信',
      replyToId: rootA.message.id,
    }));
    const replyB = await bob.next();
    const replyA = await alice.next();
    for (const delivered of [replyA, replyB]) {
      assert.equal(delivered.type, 'message');
      assert.equal(delivered.message.reply_to_id, rootA.message.id);
      assert.deepEqual(delivered.message.reply, {
        id: rootA.message.id,
        author: 'alice',
        author_user_id: null,
        body: '元のメッセージ',
      });
    }

    const reader = await client(ctx, 'reader');
    const roomId = getDefaultRoomId(ctx.app.db);
    const history = getRecentMessages(ctx.app.db, roomId);
    assert.equal(history.at(-1).body, 'これが返信');
    assert.equal(history.at(-1).reply.body, '元のメッセージ');
    alice.ws.close();
    bob.ws.close();
    reader.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('R02 reply先は正の整数・同一チャンネル・タイムライン表示中の投稿だけを許可する', async () => {
  const ctx = await startServer();
  try {
    const sender = await client(ctx, 'sender');
    const roomId = getDefaultRoomId(ctx.app.db);
    const otherRoom = ctx.app.db
      .prepare('INSERT INTO rooms (name, created_at) VALUES (?, ?) RETURNING id')
      .get('別室', Date.now());
    const other = insertMessage(ctx.app.db, Number(otherRoom.id), 'other', '別室の投稿');
    const hidden = insertMessage(ctx.app.db, roomId, 'hidden', '秘密の投稿');
    ctx.app.db.prepare('UPDATE messages SET hidden_at = ? WHERE id = ?').run(Date.now(), hidden.id);

    for (const value of ['1', 0, 1.5, 999999, other.id, hidden.id]) {
      sender.ws.send(JSON.stringify({ type: 'message', body: '不正返信', replyToId: value }));
      const error = await sender.next();
      assert.equal(error.type, 'error');
      assert.equal(error.reason, 'reply_not_found');
    }
    assert.equal(
      ctx.app.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE body = '不正返信'").get().count,
      0,
    );
    sender.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('R03 非表示になった返信先の本文は履歴へ漏らさず、削除後も返信自体は残す', async () => {
  const ctx = await startServer();
  try {
    const roomId = getDefaultRoomId(ctx.app.db);
    const target = insertMessage(ctx.app.db, roomId, 'target', '外へ出してはいけない本文');
    const reply = insertMessage(ctx.app.db, roomId, 'reply', '返信本文', null, null, null, target.id);
    ctx.app.db.prepare('UPDATE messages SET hidden_at = ? WHERE id = ?').run(Date.now(), target.id);

    const hiddenHistory = getRecentMessages(ctx.app.db, roomId);
    const hiddenReply = hiddenHistory.find((message) => message.id === reply.id);
    assert.equal(hiddenReply.reply_to_id, target.id);
    assert.equal(hiddenReply.reply, null);
    assert.doesNotMatch(JSON.stringify(hiddenHistory), /外へ出してはいけない本文/);

    assert.equal(deleteMessage(ctx.app.db, target.id, roomId), true);
    const afterDelete = getRecentMessages(ctx.app.db, roomId);
    const survivingReply = afterDelete.find((message) => message.id === reply.id);
    assert.equal(survivingReply.body, '返信本文');
    assert.equal(survivingReply.reply_to_id, null);
  } finally {
    await stopServer(ctx);
  }
});
