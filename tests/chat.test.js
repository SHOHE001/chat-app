// Acceptance tests for #1 コア: ニックネーム参加＋単一ルームのリアルタイムチャット
//
// 実行: node --test
// 各テストは一時 DB パス（tests/tmp-*.db）とランダムポート（listen(0)）で
// createChatServer を起動し、ws クライアントで検証、終了時に close & unlink する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';
import { openDb, insertMessage, getRecentMessages, getDefaultRoomId } from '../src/db.js';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

let counter = 0;

function tmpDbPath() {
  return path.join(tmpdir(), `chat-app-test-${process.pid}-${counter++}.db`);
}

async function startServer(dbPath = tmpDbPath()) {
  const app = createChatServer({ dbPath, staticDir: 'public', allowLegacyJoin: true });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  return { app, port, dbPath, url: `ws://127.0.0.1:${port}/`, httpUrl: `http://127.0.0.1:${port}` };
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

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      ws.off('error', onError);
      resolve(JSON.parse(data.toString()));
    };
    const onError = (err) => {
      ws.off('message', onMessage);
      reject(err);
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
  });
}

async function joinAndAwaitHistory(ws, nickname) {
  ws.send(JSON.stringify({ type: 'join', nickname }));
  return nextMessage(ws);
}

// fetch()（WHATWG URL 経由）は ".." のようなドットセグメントをリクエスト送信前に
// 正規化してしまい traversal を再現できない。サーバー自身の防御を検証するため、
// 生のリクエストラインを送れる node:http を使う。
function rawGet(httpUrl, rawPath) {
  return new Promise((resolve, reject) => {
    const target = new URL(httpUrl);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: rawPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('T01 2つのWSクライアント間でメッセージがリアルタイム配信される', async () => {
  const ctx = await startServer();
  try {
    const clientA = new WebSocket(ctx.url);
    const clientB = new WebSocket(ctx.url);
    await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

    await joinAndAwaitHistory(clientA, 'アリス');
    await joinAndAwaitHistory(clientB, 'ボブ');

    const bMessagePromise = nextMessage(clientB);
    clientA.send(JSON.stringify({ type: 'message', body: 'hi' }));
    const received = await bMessagePromise;

    assert.equal(received.type, 'message');
    assert.equal(received.message.body, 'hi');
    assert.equal(received.message.author, 'アリス');

    clientA.close();
    clientB.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T02 入室時に直近履歴を id 昇順で受信する', async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const roomId = getDefaultRoomId(db);
  insertMessage(db, roomId, 'せっと1', 'one');
  insertMessage(db, roomId, 'せっと2', 'two');
  insertMessage(db, roomId, 'せっと3', 'three');
  db.close();

  const ctx = await startServer(dbPath);
  try {
    const client = new WebSocket(ctx.url);
    await waitForOpen(client);
    const history = await joinAndAwaitHistory(client, 'よみて');

    assert.equal(history.type, 'history');
    assert.equal(history.messages.length, 3);
    assert.deepEqual(
      history.messages.map((m) => m.body),
      ['one', 'two', 'three'],
    );
    for (const m of history.messages) {
      assert.ok('created_at' in m);
    }
    // id 昇順であること
    const ids = history.messages.map((m) => m.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

    client.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T03_boundary 空白のみ body は保存もブロードキャストもされない', async () => {
  const ctx = await startServer();
  try {
    const db = openDb(ctx.dbPath);
    const roomId = getDefaultRoomId(db);
    const before = getRecentMessages(db, roomId).length;

    const client = new WebSocket(ctx.url);
    await waitForOpen(client);
    await joinAndAwaitHistory(client, 'くうはく');

    let gotUnexpectedMessage = false;
    client.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'message') {
        gotUnexpectedMessage = true;
      }
    });

    client.send(JSON.stringify({ type: 'message', body: '   ' }));
    // ブロードキャストが発生しないことを確認するため少し待つ
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(gotUnexpectedMessage, false);
    const after = getRecentMessages(db, roomId).length;
    assert.equal(after, before);

    client.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T04_persistence DBを閉じて再オープンしても履歴が残る', async () => {
  const dbPath = tmpDbPath();
  try {
    const db1 = openDb(dbPath);
    const roomId = getDefaultRoomId(db1);
    insertMessage(db1, roomId, 'えいぞく', 'persisted');
    db1.close();

    const db2 = openDb(dbPath);
    const messages = getRecentMessages(db2, roomId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'persisted');
    db2.close();
  } finally {
    if (existsSync(dbPath)) {
      await rm(dbPath, { force: true });
    }
  }
});

test('T05_boundary join せずに message を送ると error が返り保存されない', async () => {
  const ctx = await startServer();
  try {
    const db = openDb(ctx.dbPath);
    const roomId = getDefaultRoomId(db);
    const before = getRecentMessages(db, roomId).length;

    const client = new WebSocket(ctx.url);
    await waitForOpen(client);

    const responsePromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'message', body: 'nope' }));
    const response = await responsePromise;

    assert.equal(response.type, 'error');
    assert.equal(response.reason, 'not_joined');

    const after = getRecentMessages(db, roomId).length;
    assert.equal(after, before);

    client.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T06_boundary 2001文字以上のbodyは2000文字に切り詰められる', async () => {
  const ctx = await startServer();
  try {
    const clientA = new WebSocket(ctx.url);
    const clientB = new WebSocket(ctx.url);
    await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);
    await joinAndAwaitHistory(clientA, 'ながい');
    await joinAndAwaitHistory(clientB, 'かんし');

    const longBody = 'あ'.repeat(2500);
    const bMessagePromise = nextMessage(clientB);
    clientA.send(JSON.stringify({ type: 'message', body: longBody }));
    const received = await bMessagePromise;

    assert.equal(received.message.body.length, 2000);
    assert.equal(received.message.body, 'あ'.repeat(2000));

    clientA.close();
    clientB.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T07_boundary 不正なnicknameでのjoinはbad_nicknameで拒否される', async () => {
  const ctx = await startServer();
  try {
    const client = new WebSocket(ctx.url);
    await waitForOpen(client);

    const responsePromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'join', nickname: 'a'.repeat(33) }));
    const response = await responsePromise;

    assert.equal(response.type, 'error');
    assert.equal(response.reason, 'bad_nickname');

    const followUpPromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'message', body: 'hello' }));
    const followUp = await followUpPromise;
    assert.equal(followUp.type, 'error');
    assert.equal(followUp.reason, 'not_joined');

    client.close();

    // 制御文字を含む nickname も拒否される
    const client2 = new WebSocket(ctx.url);
    await waitForOpen(client2);
    const response2Promise = nextMessage(client2);
    client2.send(JSON.stringify({ type: 'join', nickname: 'bad\nname' }));
    const response2 = await response2Promise;
    assert.equal(response2.type, 'error');
    assert.equal(response2.reason, 'bad_nickname');
    client2.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T08_boundary 8KB超のフレームはtoo_largeで拒否され接続は維持される', async () => {
  const ctx = await startServer();
  try {
    const client = new WebSocket(ctx.url);
    await waitForOpen(client);
    await joinAndAwaitHistory(client, 'おおきい');

    const bigBody = 'a'.repeat(9000);
    const errorPromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'message', body: bigBody }));
    const errorResponse = await errorPromise;
    assert.equal(errorResponse.type, 'error');
    assert.equal(errorResponse.reason, 'too_large');

    // 同じ接続で後続の正常メッセージが送れる
    const okPromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'message', body: 'still alive' }));
    const okResponse = await okPromise;
    assert.equal(okResponse.type, 'message');
    assert.equal(okResponse.message.body, 'still alive');

    client.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T09_boundary 静的配信のtraversal/不正エンコードが拒否される', async () => {
  const ctx = await startServer();
  try {
    const rootRes = await fetch(`${ctx.httpUrl}/`);
    assert.equal(rootRes.status, 200);
    const rootBody = await rootRes.text();
    assert.match(rootBody, /<!DOCTYPE html>/i);

    // fetch は URL 正規化で ".." を送信前に消してしまうため、生の request line を送れる
    // node:http（rawGet）で traversal を再現しサーバー自身の防御を検証する。
    const traversalRes = await rawGet(ctx.httpUrl, '/../src/server.js');
    assert.equal(traversalRes.status, 403);

    const badEncodingRes = await fetch(`${ctx.httpUrl}/%`);
    assert.equal(badEncodingRes.status, 400);
  } finally {
    await stopServer(ctx);
  }
});

test('T10_boundary root外を指すsymlink経由のアクセスは403で拒否される', async (t) => {
  const outsideDir = await mkdtemp(path.join(tmpdir(), 'chat-app-outside-'));
  const secretPath = path.join(outsideDir, 'secret.txt');
  await writeFile(secretPath, 'top secret');

  const linkDir = path.join('public', 'escape-link-test');
  try {
    await symlink(outsideDir, linkDir, 'dir');
  } catch (err) {
    await rm(outsideDir, { recursive: true, force: true });
    t.skip(`symlink 作成不可の環境のためスキップ: ${err.message}`);
    return;
  }

  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.httpUrl}/escape-link-test/secret.txt`);
    assert.equal(res.status, 403);
  } finally {
    await stopServer(ctx);
    await rm(linkDir, { force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
