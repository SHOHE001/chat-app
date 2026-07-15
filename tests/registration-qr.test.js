import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import QRCode from 'qrcode';
import { createChatServer } from '../src/server.js';

let counter = 0;

function tmpDbPath() {
  return path.join(process.env.TMPDIR || '/tmp', `chat-app-registration-qr-${process.pid}-${counter++}.db`);
}

function fakePushTransport() {
  return {
    generateVAPIDKeys: () => ({ publicKey: 'test-public', privateKey: 'test-private' }),
    setVapidDetails() {},
    sendNotification: async () => {},
  };
}

async function startServer() {
  const dbPath = tmpDbPath();
  const encodedValues = [];
  const qrEncoder = {
    async toDataURL(value, options) {
      encodedValues.push(value);
      return QRCode.toDataURL(value, options);
    },
  };
  const app = createChatServer({
    dbPath,
    staticDir: 'public',
    pushTransport: fakePushTransport(),
    qrEncoder,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return {
    app,
    dbPath,
    encodedValues,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/`,
  };
}

async function stopServer(ctx) {
  await new Promise((resolve) => ctx.app.close(resolve));
  if (existsSync(ctx.dbPath)) await rm(ctx.dbPath, { force: true });
}

function createClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else queue.push(message);
  });
  return {
    ws,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    next(type) {
      const index = queue.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    send(type, payload = {}) {
      ws.send(JSON.stringify({ type, ...payload }));
    },
    close() {
      ws.close();
    },
  };
}

async function register(client, username) {
  const response = client.next('auth_ok');
  client.send('register', { username, password: 'password-123' });
  return response;
}

function registrationQr(ctx, token, origin = ctx.httpUrl, options = {}) {
  return fetch(`${ctx.httpUrl}/api/registration-qr?origin=${encodeURIComponent(origin)}`, {
    ...options,
    headers: {
      ...(token ? { 'X-Session-Token': token } : {}),
      ...options.headers,
    },
  });
}

test('QR01 registration QR: owner/adminだけが同一originの登録URL入りPNGを生成できる', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.wsUrl);
    const member = createClient(ctx.wsUrl);
    await Promise.all([owner.open(), member.open()]);
    const ownerAuth = await register(owner, 'qr-owner');
    const memberAuth = await register(member, 'qr-member');

    const unauthorized = await registrationQr(ctx);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'not_authenticated' });

    const forbidden = await registrationQr(ctx, memberAuth.sessionToken);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: 'forbidden' });

    const response = await registrationQr(ctx, ownerAuth.sessionToken);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.registrationUrl, `${ctx.httpUrl}/?register=1`);
    assert.equal(ctx.encodedValues.at(-1), result.registrationUrl);
    assert.match(result.image, /^data:image\/png;base64,/);
    const png = Buffer.from(result.image.split(',')[1], 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);

    const roleUpdate = member.next('users');
    owner.send('set_role', { userId: memberAuth.user.id, role: 'admin' });
    await roleUpdate;
    assert.equal((await registrationQr(ctx, memberAuth.sessionToken)).status, 200);

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});

test('QR02 registration QR boundaries: 別origin・不正origin・GET以外を拒否する', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.wsUrl);
    await owner.open();
    const auth = await register(owner, 'qr-boundary-owner');

    for (const origin of ['https://example.com', `${ctx.httpUrl}/path`, 'javascript:alert(1)']) {
      const response = await registrationQr(ctx, auth.sessionToken, origin);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'bad_origin' });
    }
    const method = await registrationQr(ctx, auth.sessionToken, ctx.httpUrl, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.deepEqual(await method.json(), { error: 'method_not_allowed' });

    owner.close();
  } finally {
    await stopServer(ctx);
  }
});
