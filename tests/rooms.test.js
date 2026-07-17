// Acceptance tests for #2 ルーム: 管理者によるルーム作成・削除とルーム切替UI
//
// 実行: node --test
// plan: features/2-ui/plan.md のテスト計画 T11〜T21。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';
import {
  openDb,
  insertMessage,
  getRecentMessages,
  getDefaultRoomId,
  listRooms,
  getRoomById,
} from '../src/db.js';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let counter = 0;

function tmpDbPath() {
  return path.join(tmpdir(), `chat-app-rooms-test-${process.pid}-${counter++}.db`);
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
 * ws の 'message' イベントを常時バッファリングする inbox を作る。
 * chat.test.js の nextMessage（once ベース）は「連続で届く複数メッセージ」を
 * 取りこぼすレースがあるため、rooms.test.js では受信順を保証するキュー方式にする。
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

test('T11_account_owner 最初の登録者がownerになり、旧admin_authは無効', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const client = await connectClient(ctx);
    const oldAuthPromise = client.next();
    client.ws.send(JSON.stringify({ type: 'admin_auth', password: 'himitsu' }));
    const oldAuth = await oldAuthPromise;
    assert.equal(oldAuth.type, 'error');
    assert.equal(oldAuth.reason, 'admin_disabled');

    const auth = await authAdmin(client);
    assert.equal(auth.type, 'auth_ok');
    assert.equal(auth.user.role, 'owner');

    client.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T12_boundary_admin_disabled adminPasswordの有無にかかわらずadmin_authは無効', async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx);
    client.ws.send(JSON.stringify({ type: 'admin_auth', password: 'anything' }));
    const res = await client.next();
    assert.equal(res.type, 'error');
    assert.equal(res.reason, 'admin_disabled');
    client.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T13_boundary_forbidden 未認証クライアントのcreate_room/delete_roomはforbiddenでDB変化なし', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const db = openDb(ctx.dbPath);
    const before = listRooms(db);
    const defaultId = getDefaultRoomId(db);

    const client = await connectClient(ctx);

    client.ws.send(JSON.stringify({ type: 'create_room', name: 'テスト' }));
    const createRes = await client.next();
    assert.equal(createRes.type, 'error');
    assert.equal(createRes.reason, 'forbidden');

    client.ws.send(JSON.stringify({ type: 'delete_room', roomId: defaultId }));
    const deleteRes = await client.next();
    assert.equal(deleteRes.type, 'error');
    assert.equal(deleteRes.reason, 'forbidden');

    const after = listRooms(db);
    assert.deepEqual(after, before);

    client.ws.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T14_create_room 管理者のcreate_roomで全クライアントにroomsがブロードキャストされる（join直後はhistory→rooms順）', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const adminClient = await joinClient(ctx, 'かんり');
    // join 直後は history → rooms の順で届く
    assert.equal(adminClient.history.type, 'history');
    assert.equal(adminClient.rooms.type, 'rooms');
    for (const room of adminClient.rooms.rooms) {
      assert.deepEqual(
        Object.keys(room).sort(),
        ['allowedRoles', 'id', 'kind', 'name', 'notificationsEnabled'],
      );
      assert.deepEqual(room.allowedRoles, []);
      assert.equal(room.notificationsEnabled, false);
      assert.ok(['chat', 'announcement'].includes(room.kind));
    }

    const authRes = await authAdmin(adminClient);
    assert.equal(authRes.type, 'auth_ok');
    assert.equal(authRes.user.role, 'owner');

    const otherClient = await joinClient(ctx, 'いっぱん');

    const adminRoomsPromise = adminClient.next();
    const otherRoomsPromise = otherClient.next();
    adminClient.ws.send(JSON.stringify({ type: 'create_room', name: 'あたらしいへや' }));

    const adminRooms = await adminRoomsPromise;
    const otherRooms = await otherRoomsPromise;

    assert.equal(adminRooms.type, 'rooms');
    assert.equal(otherRooms.type, 'rooms');
    assert.ok(adminRooms.rooms.some((r) => r.name === 'あたらしいへや'));
    assert.ok(otherRooms.rooms.some((r) => r.name === 'あたらしいへや'));
    for (const room of adminRooms.rooms) {
      assert.deepEqual(
        Object.keys(room).sort(),
        ['allowedRoles', 'id', 'kind', 'name', 'notificationsEnabled'],
      );
      assert.deepEqual(room.allowedRoles, []);
      assert.equal(room.notificationsEnabled, false);
      assert.ok(['chat', 'announcement'].includes(room.kind));
    }

    adminClient.ws.close();
    otherClient.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T15_boundary_room_name 空名・33文字・制御文字入りはbad_room_name、重複名はroom_exists', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    const invalidNames = ['', 'a'.repeat(33), 'bad\x01name'];
    for (const name of invalidNames) {
      admin.ws.send(JSON.stringify({ type: 'create_room', name }));
      const res = await admin.next();
      assert.equal(res.type, 'error');
      assert.equal(res.reason, 'bad_room_name');
    }

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'じゅうふく' }));
    const okRes = await admin.next();
    assert.equal(okRes.type, 'rooms');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'じゅうふく' }));
    const dupRes = await admin.next();
    assert.equal(dupRes.type, 'error');
    assert.equal(dupRes.reason, 'room_exists');

    admin.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T16_boundary_delete_default デフォルトルーム削除はcannot_delete_default、型不正idはroom_not_found、いずれもルームは残る', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const db = openDb(ctx.dbPath);
    const defaultId = getDefaultRoomId(db);

    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    admin.ws.send(JSON.stringify({ type: 'delete_room', roomId: defaultId }));
    const numRes = await admin.next();
    assert.equal(numRes.type, 'error');
    assert.equal(numRes.reason, 'cannot_delete_default');

    const invalidInputs = [String(defaultId), defaultId + 0.5, null, [defaultId]];
    for (const roomId of invalidInputs) {
      admin.ws.send(JSON.stringify({ type: 'delete_room', roomId }));
      const res = await admin.next();
      assert.equal(res.type, 'error');
      assert.equal(res.reason, 'room_not_found');
    }

    assert.ok(getRoomById(db, defaultId));

    admin.ws.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T17_delete_room 管理者の削除でroomsから消えmessagesも消える、存在しないidはroom_not_found', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const db = openDb(ctx.dbPath);
    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'きえるへや' }));
    const createdRoomsMsg = await admin.next();
    const created = createdRoomsMsg.rooms.find((r) => r.name === 'きえるへや');
    assert.ok(created);

    insertMessage(db, created.id, 'だれか', 'hello');
    assert.equal(getRecentMessages(db, created.id).length, 1);

    admin.ws.send(JSON.stringify({ type: 'delete_room', roomId: created.id }));
    const afterDelete = await admin.next();
    assert.equal(afterDelete.type, 'rooms');
    assert.ok(!afterDelete.rooms.some((r) => r.id === created.id));
    assert.equal(getRecentMessages(db, created.id).length, 0);

    admin.ws.send(JSON.stringify({ type: 'delete_room', roomId: 999999 }));
    const notFoundRes = await admin.next();
    assert.equal(notFoundRes.type, 'error');
    assert.equal(notFoundRes.reason, 'room_not_found');

    admin.ws.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T18_delete_room_eviction 在室者は削除時にroom_switched（デフォルトルーム履歴付き）を受信し以後デフォルトルームの新着を受ける', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const db = openDb(ctx.dbPath);
    const defaultId = getDefaultRoomId(db);

    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'たちのくへや' }));
    const createdRoomsMsg = await admin.next();
    const targetRoom = createdRoomsMsg.rooms.find((r) => r.name === 'たちのくへや');

    const evictee = await joinClient(ctx, 'ひなんしゃ');
    evictee.ws.send(JSON.stringify({ type: 'switch_room', roomId: targetRoom.id }));
    const switched = await evictee.next();
    assert.equal(switched.type, 'room_switched');
    assert.equal(switched.roomId, targetRoom.id);

    const evicteeSwitchedPromise = evictee.next();
    const adminRoomsPromise = admin.next();
    admin.ws.send(JSON.stringify({ type: 'delete_room', roomId: targetRoom.id }));

    const evicteeSwitched = await evicteeSwitchedPromise;
    assert.equal(evicteeSwitched.type, 'room_switched');
    assert.equal(evicteeSwitched.roomId, defaultId);
    assert.ok(Array.isArray(evicteeSwitched.messages));

    // ルーム削除は room_switched の後に rooms のブロードキャストも届く（消費しておく）
    const evicteeRoomsBroadcast = await evictee.next();
    assert.equal(evicteeRoomsBroadcast.type, 'rooms');

    const adminRoomsBroadcast = await adminRoomsPromise;
    assert.equal(adminRoomsBroadcast.type, 'rooms');

    const anotherClient = await joinClient(ctx, 'べつのひと');
    const evicteeMessagePromise = evictee.next();
    anotherClient.ws.send(JSON.stringify({ type: 'message', body: 'yaa' }));
    const received = await evicteeMessagePromise;
    assert.equal(received.type, 'message');
    assert.equal(received.message.body, 'yaa');
    assert.equal(received.message.room_id, defaultId);

    admin.ws.close();
    evictee.ws.close();
    anotherClient.ws.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T19_switch_room 正常系はroom_switched+履歴（id昇順・最大50件）、join前はnot_joined、不明id/型不正はroom_not_found', async () => {
  const ctx = await startServer({ adminPassword: 'himitsu' });
  try {
    const db = openDb(ctx.dbPath);
    const defaultId = getDefaultRoomId(db);

    // join 前の switch_room は not_joined
    const preJoinClient = await connectClient(ctx);
    preJoinClient.ws.send(JSON.stringify({ type: 'switch_room', roomId: defaultId }));
    const notJoinedRes = await preJoinClient.next();
    assert.equal(notJoinedRes.type, 'error');
    assert.equal(notJoinedRes.reason, 'not_joined');
    preJoinClient.ws.close();

    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');
    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'きりかえさき' }));
    const createdRoomsMsg = await admin.next();
    const target = createdRoomsMsg.rooms.find((r) => r.name === 'きりかえさき');

    insertMessage(db, target.id, 'だれか', 'one');
    insertMessage(db, target.id, 'だれか', 'two');

    admin.ws.send(JSON.stringify({ type: 'switch_room', roomId: target.id }));
    const switchedRes = await admin.next();
    assert.equal(switchedRes.type, 'room_switched');
    assert.equal(switchedRes.roomId, target.id);
    assert.deepEqual(
      switchedRes.messages.map((m) => m.body),
      ['one', 'two'],
    );
    const ids = switchedRes.messages.map((m) => m.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );

    admin.ws.send(JSON.stringify({ type: 'switch_room', roomId: 999999 }));
    const notFoundRes = await admin.next();
    assert.equal(notFoundRes.type, 'error');
    assert.equal(notFoundRes.reason, 'room_not_found');

    const invalidInputs = [String(target.id), target.id + 0.5, null];
    for (const roomId of invalidInputs) {
      admin.ws.send(JSON.stringify({ type: 'switch_room', roomId }));
      const res = await admin.next();
      assert.equal(res.type, 'error');
      assert.equal(res.reason, 'room_not_found');
    }

    admin.ws.close();
    db.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T20_isolation ルームA在室者の発言はA在室者だけに届きB在室者には届かない', async () => {
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

    const clientA1 = await joinClient(ctx, 'えー1');
    clientA1.ws.send(JSON.stringify({ type: 'switch_room', roomId: roomA.id }));
    await clientA1.next();

    const clientA2 = await joinClient(ctx, 'えー2');
    clientA2.ws.send(JSON.stringify({ type: 'switch_room', roomId: roomA.id }));
    await clientA2.next();

    const clientB = await joinClient(ctx, 'びー');
    clientB.ws.send(JSON.stringify({ type: 'switch_room', roomId: roomB.id }));
    await clientB.next();

    const receivedByA2 = clientA2.next();
    clientA1.ws.send(JSON.stringify({ type: 'message', body: 'ないしょ' }));
    const gotA2 = await receivedByA2;
    assert.equal(gotA2.type, 'message');
    assert.equal(gotA2.message.body, 'ないしょ');

    const raceResult = await Promise.race([clientB.next(), timeout(200)]);
    assert.equal(raceResult, 'timeout');

    admin.ws.close();
    clientA1.ws.close();
    clientA2.ws.close();
    clientB.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('T21_room_persistence 作成したルームと投稿がDB再オープン後も残る', async () => {
  const dbPath = tmpDbPath();
  try {
    const ctx = await startServer({ dbPath, adminPassword: 'himitsu' });

    const admin = await joinClient(ctx, 'かんり');
    await authAdmin(admin, 'himitsu');

    admin.ws.send(JSON.stringify({ type: 'create_room', name: 'えいぞくへや' }));
    const roomsMsg = await admin.next();
    const room = roomsMsg.rooms.find((r) => r.name === 'えいぞくへや');
    assert.ok(room);

    admin.ws.send(JSON.stringify({ type: 'switch_room', roomId: room.id }));
    await admin.next();

    admin.ws.send(JSON.stringify({ type: 'message', body: 'ずっとのこる' }));
    await admin.next();

    admin.ws.close();
    await new Promise((resolve) => ctx.app.close(resolve));

    const db = openDb(dbPath);
    const rooms = listRooms(db);
    const persistedRoom = rooms.find((r) => r.name === 'えいぞくへや');
    assert.ok(persistedRoom);
    const messages = getRecentMessages(db, persistedRoom.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'ずっとのこる');
    db.close();
  } finally {
    if (existsSync(dbPath)) {
      await rm(dbPath, { force: true });
    }
  }
});
