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

async function register(client, username) {
  const response = client.next('auth_ok');
  client.send('register', { username, password: 'password-123' });
  return response;
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
    await register(owner, 'push-owner');
    const memberAuth = await register(member, 'push-recipient');
    await pushApi(ctx, '/api/push/subscription', memberAuth.sessionToken, {
      method: 'POST',
      body: JSON.stringify(subscription),
    });

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
