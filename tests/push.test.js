import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';
import { getAppConfig, listPushSubscriptions } from '../src/db.js';

function createFakePushTransport() {
  const calls = [];
  const waiters = [];
  let failureStatus = null;
  return {
    calls,
    generated: 0,
    details: null,
    generateVAPIDKeys() {
      this.generated += 1;
      return { publicKey: 'test-public-key', privateKey: 'test-private-key' };
    },
    setVapidDetails(...details) {
      this.details = details;
    },
    sendNotification(subscription, payload, options) {
      const call = { subscription, payload: JSON.parse(payload), options };
      calls.push(call);
      waiters.splice(0).forEach((resolve) => resolve(call));
      if (failureStatus) return Promise.reject({ statusCode: failureStatus });
      return Promise.resolve();
    },
    failWith(status) {
      failureStatus = status;
    },
    nextCall() {
      if (calls.length) return Promise.resolve(calls.at(-1));
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function startServer(pushTransport = createFakePushTransport()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-app-push-'));
  const app = createChatServer({
    dbPath: path.join(dir, 'chat.db'),
    staticDir: 'public',
    vapidSubject: 'https://example.com/contact',
    pushTransport,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return {
    app,
    dir,
    pushTransport,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/`,
  };
}

async function stopServer(ctx) {
  await new Promise((resolve) => ctx.app.close(resolve));
  await rm(ctx.dir, { recursive: true, force: true });
}

async function createClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else queue.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    next(type) {
      const index = queue.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    send(type, payload = {}) {
      ws.send(JSON.stringify({ type, ...payload }));
    },
  };
}

async function register(client, username, invite = undefined) {
  const response = client.next('auth_ok');
  client.send('register', { username, password: 'password-123', invite });
  return response;
}

async function issueInvite(ctx, sessionToken) {
  const response = await fetch(
    `${ctx.httpUrl}/api/registration-qr?origin=${encodeURIComponent(ctx.httpUrl)}`,
    { method: 'POST', headers: { 'X-Session-Token': sessionToken } },
  );
  assert.equal(response.status, 200);
  return new URL((await response.json()).registrationUrl).searchParams.get('invite');
}

async function pushApi(ctx, pathName, token, init = {}) {
  return fetch(`${ctx.httpUrl}${pathName}`, {
    ...init,
    headers: {
      'X-Session-Token': token,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

const subscription = {
  endpoint: 'https://push.example.test/subscription-1',
  keys: {
    p256dh: 'abcdefghijklmnopqrstuvwxyzABCDE_123456789',
    auth: 'abcdefgh_1234567',
  },
};

test('PUSH01 API: 認証、購読登録・解除、VAPID鍵永続化が成立する', async () => {
  const ctx = await startServer();
  try {
    const unauthorized = await fetch(`${ctx.httpUrl}/api/push/public-key`);
    assert.equal(unauthorized.status, 401);

    const member = await createClient(ctx.wsUrl);
    const auth = await register(member, 'push-member');
    const keyResponse = await pushApi(ctx, '/api/push/public-key', auth.sessionToken);
    assert.equal(keyResponse.status, 200);
    assert.deepEqual(await keyResponse.json(), { publicKey: 'test-public-key' });
    assert.deepEqual(ctx.pushTransport.details, [
      'https://example.com/contact',
      'test-public-key',
      'test-private-key',
    ]);
    assert.equal(getAppConfig(ctx.app.db, 'vapid_public_key'), 'test-public-key');
    assert.equal(getAppConfig(ctx.app.db, 'vapid_private_key'), 'test-private-key');

    const invalid = await pushApi(ctx, '/api/push/subscription', auth.sessionToken, {
      method: 'POST',
      body: JSON.stringify({ ...subscription, endpoint: 'http://insecure.test/x' }),
    });
    assert.equal(invalid.status, 400);

    const created = await pushApi(ctx, '/api/push/subscription', auth.sessionToken, {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
    assert.equal(created.status, 201);
    assert.equal(listPushSubscriptions(ctx.app.db).length, 1);

    const removed = await pushApi(ctx, '/api/push/subscription', auth.sessionToken, {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    assert.equal(removed.status, 200);
    assert.equal(listPushSubscriptions(ctx.app.db).length, 0);
    member.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('PUSH02 delivery: 送信者を除外して配送し、期限切れ購読を自動削除する', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const member = await createClient(ctx.wsUrl);
    const ownerAuth = await register(owner, 'push-owner');
    const memberAuth = await register(
      member,
      'push-recipient',
      await issueInvite(ctx, ownerAuth.sessionToken),
    );
    await pushApi(ctx, '/api/push/subscription', memberAuth.sessionToken, {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
    const memberState = member.next('state');
    member.send('get_state');
    const defaultRoom = (await memberState).rooms[0];
    const notificationsEnabled = member.next('rooms');
    member.send('set_room_notification', { roomId: defaultRoom.id, enabled: true });
    await notificationsEnabled;

    const delivered = ctx.pushTransport.nextCall();
    const broadcast = owner.next('message');
    owner.send('message', { body: 'スマホへ通知' });
    await broadcast;
    const call = await delivered;
    assert.equal(call.subscription.endpoint, subscription.endpoint);
    assert.equal(call.payload.body, 'スマホへ通知');
    assert.match(call.payload.title, /push-owner/);
    assert.match(call.payload.url, /^\/?\?room=/);
    assert.equal(call.options.TTL, 3600);

    const count = ctx.pushTransport.calls.length;
    member.send('message', { body: '自分自身には通知しない' });
    await member.next('message');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.pushTransport.calls.length, count);

    ctx.pushTransport.failWith(410);
    owner.send('message', { body: '期限切れ購読を清掃' });
    await owner.next('message');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(listPushSubscriptions(ctx.app.db).length, 0);
    owner.ws.close();
    member.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('PUSH03 restricted rooms: 入室権限のない購読者へ本文を配送しない', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const adult = await createClient(ctx.wsUrl);
    const child = await createClient(ctx.wsUrl);
    const ownerAuth = await register(owner, 'restricted-owner');
    const invite = await issueInvite(ctx, ownerAuth.sessionToken);
    const adultAuth = await register(adult, 'restricted-adult', invite);
    const childAuth = await register(child, 'restricted-child', invite);
    const assignProfileRole = ctx.app.db.prepare(
      'INSERT INTO user_profile_roles (user_id, role, created_at) VALUES (?, ?, ?)',
    );
    assignProfileRole.run(adultAuth.user.id, 'adult', Date.now());
    assignProfileRole.run(childAuth.user.id, 'child', Date.now());
    await pushApi(ctx, '/api/push/subscription', adultAuth.sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        ...subscription,
        endpoint: 'https://push.example.test/adult',
      }),
    });
    await pushApi(ctx, '/api/push/subscription', childAuth.sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        ...subscription,
        endpoint: 'https://push.example.test/child',
      }),
    });

    const rooms = owner.next('rooms');
    owner.send('create_room', { name: '大人限定通知', allowedRoles: ['adult'] });
    const room = (await rooms).rooms.find((item) => item.name === '大人限定通知');
    ctx.app.db.prepare(
      'INSERT INTO enabled_room_notifications (user_id, room_id, created_at) VALUES (?, ?, ?)',
    ).run(adultAuth.user.id, room.id, Date.now());
    const switched = owner.next('room_switched');
    owner.send('switch_room', { roomId: room.id });
    await switched;
    const broadcast = owner.next('message');
    owner.send('message', { body: '限定チャンネルの本文' });
    await broadcast;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(ctx.pushTransport.calls.length, 1);
    assert.equal(ctx.pushTransport.calls[0].subscription.endpoint, 'https://push.example.test/adult');
    assert.equal(ctx.pushTransport.calls[0].payload.body, '限定チャンネルの本文');
    owner.ws.close();
    adult.ws.close();
    child.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('PUSH04 room mute: 通知オフのチャンネルを配送せず、オンへ戻すと再開する', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const member = await createClient(ctx.wsUrl);
    const ownerAuth = await register(owner, 'mute-owner');
    const memberAuth = await register(
      member,
      'mute-member',
      await issueInvite(ctx, ownerAuth.sessionToken),
    );
    await pushApi(ctx, '/api/push/subscription', memberAuth.sessionToken, {
      method: 'POST',
      body: JSON.stringify(subscription),
    });

    const state = member.next('state');
    member.send('get_state');
    const room = (await state).rooms[0];
    const muted = member.next('rooms');
    member.send('set_room_notification', { roomId: room.id, enabled: false });
    assert.equal((await muted).rooms[0].notificationsEnabled, false);

    const mutedBroadcast = owner.next('message');
    owner.send('message', { body: 'ミュート中' });
    await mutedBroadcast;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.pushTransport.calls.length, 0);

    const enabled = member.next('rooms');
    member.send('set_room_notification', { roomId: room.id, enabled: true });
    assert.equal((await enabled).rooms[0].notificationsEnabled, true);
    const delivered = ctx.pushTransport.nextCall();
    const enabledBroadcast = owner.next('message');
    owner.send('message', { body: '通知再開' });
    await enabledBroadcast;
    assert.equal((await delivered).payload.body, '通知再開');

    owner.ws.close();
    member.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('PUSH05 announcements: 通知は既定ONで配信し、利用者がOFFにすると停止する', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const member = await createClient(ctx.wsUrl);
    const ownerAuth = await register(owner, 'announcement-push-owner');
    const memberAuth = await register(
      member,
      'announcement-push-member',
      await issueInvite(ctx, ownerAuth.sessionToken),
    );
    await pushApi(ctx, '/api/push/subscription', memberAuth.sessionToken, {
      method: 'POST',
      body: JSON.stringify(subscription),
    });

    const statePromise = member.next('state');
    member.send('get_state');
    const announcement = (await statePromise).rooms.find((room) => room.kind === 'announcement');
    assert.equal(announcement.notificationsEnabled, true);

    const ownerSwitched = owner.next('room_switched');
    const memberSwitched = member.next('room_switched');
    owner.send('switch_room', { roomId: announcement.id });
    member.send('switch_room', { roomId: announcement.id });
    await Promise.all([ownerSwitched, memberSwitched]);

    const firstPush = ctx.pushTransport.nextCall();
    const firstBroadcast = member.next('message');
    owner.send('message', { body: '既定ONのお知らせ' });
    await firstBroadcast;
    assert.equal((await firstPush).payload.body, '既定ONのお知らせ');

    const mutedRooms = member.next('rooms');
    member.send('set_room_notification', { roomId: announcement.id, enabled: false });
    assert.equal(
      (await mutedRooms).rooms.find((room) => room.id === announcement.id).notificationsEnabled,
      false,
    );
    const secondBroadcast = member.next('message');
    owner.send('message', { body: '通知OFF後のお知らせ' });
    await secondBroadcast;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ctx.pushTransport.calls.length, 1);

    owner.ws.close();
    member.ws.close();
  } finally {
    await stopServer(ctx);
  }
});
