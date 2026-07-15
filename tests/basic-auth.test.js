import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createChatServer, resolveConfig } from '../src/server.js';

let counter = 0;

function tmpDbPath() {
  return path.join(process.env.TMPDIR || '/tmp', `chat-app-basic-auth-${process.pid}-${counter++}.db`);
}

function authHeader(user, password, scheme = 'Basic') {
  return `${scheme} ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

async function startServer({ basicAuth } = {}) {
  const dbPath = tmpDbPath();
  const app = createChatServer({ dbPath, staticDir: 'public', basicAuth, allowLegacyJoin: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return {
    app,
    dbPath,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/`,
  };
}

async function stopServer(ctx) {
  await new Promise((resolve) => ctx.app.close(resolve));
  if (existsSync(ctx.dbPath)) await rm(ctx.dbPath, { force: true });
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForType(ws, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== type) return;
      cleanup();
      resolve(parsed);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.once('error', onError);
  });
}

function expectWsStatus(url, headers, expectedStatus) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    let gotResponse = false;
    ws.once('unexpected-response', (_request, response) => {
      gotResponse = true;
      try {
        assert.equal(response.statusCode, expectedStatus);
      } catch (err) {
        reject(err);
        return;
      }
      response.resume();
      response.once('end', resolve);
    });
    ws.once('open', () => reject(new Error('WebSocket connection unexpectedly opened')));
    ws.once('error', (err) => {
      if (!gotResponse) reject(err);
    });
  });
}

test('B01-B06 resolveConfig: Basic認証設定の正常系とfail-fast', () => {
  assert.deepEqual(
    resolveConfig({ BASIC_AUTH_USER: ' user ', BASIC_AUTH_PASSWORD: ' p:a:ss ' }).basicAuth,
    { user: 'user', password: 'p:a:ss' },
  );
  assert.equal(resolveConfig({}).basicAuth, undefined);
  assert.equal(resolveConfig({ BASIC_AUTH_USER: '', BASIC_AUTH_PASSWORD: '   ' }).basicAuth, undefined);

  for (const env of [
    { BASIC_AUTH_USER: 'user' },
    { BASIC_AUTH_PASSWORD: 'pass' },
    { BASIC_AUTH_USER: '   ', BASIC_AUTH_PASSWORD: 'pass' },
  ]) {
    assert.throws(
      () => resolveConfig(env),
      /BASIC_AUTH_USER.*BASIC_AUTH_PASSWORD|BASIC_AUTH_PASSWORD.*BASIC_AUTH_USER/,
    );
  }

  assert.throws(
    () => resolveConfig({ BASIC_AUTH_USER: 'bad:user', BASIC_AUTH_PASSWORD: 'pass' }),
    /BASIC_AUTH_USER.*コロン/,
  );
  assert.throws(
    () => resolveConfig({ BASIC_AUTH_USER: 123, BASIC_AUTH_PASSWORD: 'pass' }),
    /BASIC_AUTH_USER.*文字列/,
  );
  assert.throws(
    () => resolveConfig({ BASIC_AUTH_USER: 'user', BASIC_AUTH_PASSWORD: {} }),
    /BASIC_AUTH_PASSWORD.*文字列/,
  );
});

test('B10-B13 HTTP: 無効時は200、有効時は401/正しいcredentialで200', async () => {
  const disabled = await startServer();
  try {
    assert.equal((await fetch(`${disabled.httpUrl}/`)).status, 200);
  } finally {
    await stopServer(disabled);
  }

  const enabled = await startServer({ basicAuth: { user: 'user', password: 'pass' } });
  try {
    const unauthorized = await fetch(`${enabled.httpUrl}/`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Basic realm="chat", charset="UTF-8"');

    for (const value of [authHeader('wrong', 'pass'), authHeader('user', 'wrong')]) {
      assert.equal((await fetch(`${enabled.httpUrl}/`, { headers: { Authorization: value } })).status, 401);
    }
    assert.equal(
      (await fetch(`${enabled.httpUrl}/`, { headers: { Authorization: authHeader('user', 'pass') } })).status,
      200,
    );
  } finally {
    await stopServer(enabled);
  }
});

test('B14-B17 HTTP: malformed、厳密Base64、HEAD/POST、scheme大小文字、コロン入りpassword', async () => {
  const ctx = await startServer({ basicAuth: { user: 'user', password: 'p:a:ss' } });
  try {
    const validToken = Buffer.from('user:p:a:ss').toString('base64');
    const malformed = [
      'Basic',
      'Basic !!!',
      'Bearer x',
      `Basic ${Buffer.from('nocolon').toString('base64')}`,
      `Basic ${validToken.slice(0, 2)}!${validToken.slice(2)}`,
    ];
    for (const value of malformed) {
      assert.equal((await fetch(`${ctx.httpUrl}/`, { headers: { Authorization: value } })).status, 401);
    }

    const lowerCase = authHeader('user', 'p:a:ss', 'basic');
    assert.equal((await fetch(`${ctx.httpUrl}/`, { headers: { Authorization: lowerCase } })).status, 200);
    assert.equal((await fetch(`${ctx.httpUrl}/`, { method: 'HEAD' })).status, 401);
    assert.equal(
      (await fetch(`${ctx.httpUrl}/`, { method: 'HEAD', headers: { Authorization: lowerCase } })).status,
      200,
    );
    assert.equal((await fetch(`${ctx.httpUrl}/`, { method: 'POST' })).status, 401);

    // malformedを連続送信した後もサーバーが正常なcredentialを受理できることを確認する。
    assert.equal((await fetch(`${ctx.httpUrl}/`, { headers: { Authorization: lowerCase } })).status, 200);
  } finally {
    await stopServer(ctx);
  }
});

test('B20-B23 WebSocket: 未認証/誤認証は401、正しいcredentialと無効時は接続成功', async () => {
  const enabled = await startServer({ basicAuth: { user: 'user', password: 'pass' } });
  try {
    await expectWsStatus(enabled.wsUrl, undefined, 401);
    await expectWsStatus(enabled.wsUrl, { Authorization: authHeader('user', 'wrong') }, 401);

    const ws = new WebSocket(enabled.wsUrl, { headers: { Authorization: authHeader('user', 'pass') } });
    await waitForOpen(ws);
    const historyPromise = waitForType(ws, 'history');
    ws.send(JSON.stringify({ type: 'join', nickname: '認証済み' }));
    assert.equal((await historyPromise).type, 'history');
    ws.close();
  } finally {
    await stopServer(enabled);
  }

  const disabled = await startServer();
  try {
    const ws = new WebSocket(disabled.wsUrl);
    await waitForOpen(ws);
    ws.close();
  } finally {
    await stopServer(disabled);
  }
});

test('B24 HTTP/WS: 同一credentialでHTTP取得後にチャット送受信できる', async () => {
  const ctx = await startServer({ basicAuth: { user: 'shared', password: 'secret' } });
  const authorization = authHeader('shared', 'secret');
  try {
    assert.equal(
      (await fetch(`${ctx.httpUrl}/`, { headers: { Authorization: authorization } })).status,
      200,
    );

    const alice = new WebSocket(ctx.wsUrl, { headers: { Authorization: authorization } });
    const bob = new WebSocket(ctx.wsUrl, { headers: { Authorization: authorization } });
    await Promise.all([waitForOpen(alice), waitForOpen(bob)]);

    const aliceHistory = waitForType(alice, 'history');
    alice.send(JSON.stringify({ type: 'join', nickname: 'Alice' }));
    await aliceHistory;
    const bobHistory = waitForType(bob, 'history');
    bob.send(JSON.stringify({ type: 'join', nickname: 'Bob' }));
    await bobHistory;

    const incoming = waitForType(bob, 'message');
    alice.send(JSON.stringify({ type: 'message', body: 'Basic認証越しのメッセージ' }));
    const message = await incoming;
    assert.equal(message.message.author, 'Alice');
    assert.equal(message.message.body, 'Basic認証越しのメッセージ');
    alice.close();
    bob.close();
  } finally {
    await stopServer(ctx);
  }
});
