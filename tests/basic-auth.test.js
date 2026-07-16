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

async function startServer({ basicAuth, now, rateLimits } = {}) {
  const dbPath = tmpDbPath();
  const app = createChatServer({ dbPath, staticDir: 'public', basicAuth, allowLegacyJoin: true, now, rateLimits });
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

    for (const name of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options']) {
      assert.ok(unauthorized.headers.get(name), `401に${name}が必要`);
    }

    const authorized = await fetch(`${enabled.httpUrl}/`, {
      headers: { Authorization: authHeader('user', 'pass') },
    });
    assert.equal(authorized.headers.get('x-content-type-options'), 'nosniff');
    assert.match(authorized.headers.get('content-security-policy'), /object-src 'none'/);

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

test('B25 Safari fallback: Basicを維持したままフォームでSecure Cookieを発行しHTTP/WSへ使える', async () => {
  let currentTime = 1_000;
  const ctx = await startServer({
    basicAuth: { user: 'shared', password: 'secret-password' },
    now: () => currentTime,
  });
  try {
    const page = await fetch(ctx.httpUrl + '/basic-login');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('www-authenticate'), null);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.ok(page.headers.get('content-security-policy'));
    const html = await page.text();
    assert.match(html, /Chat Labへ入る/);
    assert.match(html, /action="\/basic-login"/);
    assert.match(html, /name="user"/);
    assert.match(html, /name="password"/);

    const wrong = await fetch(ctx.httpUrl + '/basic-login', {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ user: 'shared', password: 'wrong' }),
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers.get('www-authenticate'), null);
    assert.match(await wrong.text(), /ユーザー名またはパスワードが違います/);

    const login = await fetch(ctx.httpUrl + '/basic-login', {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ user: 'shared', password: 'secret-password' }),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/');
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^__Host-chat_gate=/);
    assert.match(setCookie, /; Path=\//);
    assert.match(setCookie, /; Max-Age=43200/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /; SameSite=Strict/);
    const cookie = setCookie.split(';', 1)[0];

    const authorized = await fetch(ctx.httpUrl + '/', { headers: { Cookie: cookie } });
    assert.equal(authorized.status, 200);

    const ws = new WebSocket(ctx.wsUrl, { headers: { Cookie: cookie } });
    await waitForOpen(ws);
    const history = waitForType(ws, 'history');
    ws.send(JSON.stringify({ type: 'join', nickname: 'Cookie認証済み' }));
    await history;
    ws.close();

    const last = cookie.at(-1);
    const tampered = cookie.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    assert.equal(
      (await fetch(ctx.httpUrl + '/', { headers: { Cookie: tampered } })).status,
      401,
    );
    assert.equal(
      (await fetch(ctx.httpUrl + '/', { headers: { Cookie: cookie + '; ' + cookie } })).status,
      401,
    );

    currentTime += 12 * 60 * 60 * 1000 + 1;
    assert.equal(
      (await fetch(ctx.httpUrl + '/', { headers: { Cookie: cookie } })).status,
      401,
    );
  } finally {
    await stopServer(ctx);
  }

  const disabled = await startServer();
  try {
    assert.equal((await fetch(disabled.httpUrl + '/basic-login')).status, 404);
  } finally {
    await stopServer(disabled);
  }
});

test('B26 Safari fallback: 不正入力を日本語表示しBasicと同じ失敗回数制限を使う', async () => {
  let currentTime = 10_000;
  const ctx = await startServer({
    basicAuth: { user: 'shared', password: 'secret-password' },
    now: () => currentTime,
    rateLimits: {
      basicAuth: { windowMs: 10_000, maxFailures: 2, blockMs: 5_000 },
      global: { windowMs: 10_000, maxFailures: 100, blockMs: 5_000 },
      maxEntries: 10,
    },
  });
  const post = (password) => fetch(ctx.httpUrl + '/basic-login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'X-Forwarded-For': '198.51.100.70' },
    body: new URLSearchParams({ user: 'shared', password }),
  });
  try {
    assert.equal((await post('wrong-1')).status, 403);
    const limited = await post('wrong-2');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '5');
    assert.match(await limited.text(), /試行回数が多すぎます/);

    assert.equal((await post('secret-password')).status, 429);
    currentTime += 5_001;
    assert.equal((await post('secret-password')).status, 303);
    assert.equal((await post('wrong-after-success')).status, 403);

    const unsupported = await fetch(ctx.httpUrl + '/basic-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unsupported.status, 415);
    assert.match(await unsupported.text(), /入力形式が正しくありません/);
  } finally {
    await stopServer(ctx);
  }
});

test('B30-B34 Basic rate limit: HTTP/WSの429、接続元分離、成功・時間経過で解除', async () => {
  let currentTime = 1_000;
  const ctx = await startServer({
    basicAuth: { user: 'user', password: 'pass' },
    now: () => currentTime,
    rateLimits: {
      basicAuth: { windowMs: 10_000, maxFailures: 2, blockMs: 5_000 },
      global: { windowMs: 10_000, maxFailures: 100, blockMs: 5_000 },
      maxEntries: 10,
    },
  });
  try {
    const wrong = authHeader('user', 'wrong');
    const first = await fetch(`${ctx.httpUrl}/`, {
      headers: { Authorization: wrong, 'X-Forwarded-For': '198.51.100.10' },
    });
    assert.equal(first.status, 401);
    const second = await fetch(`${ctx.httpUrl}/`, {
      headers: { Authorization: wrong, 'X-Forwarded-For': '198.51.100.10' },
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '5');

    const separateSource = await fetch(`${ctx.httpUrl}/`, {
      headers: { Authorization: wrong, 'X-Forwarded-For': '203.0.113.20' },
    });
    assert.equal(separateSource.status, 401);

    const valid = await fetch(`${ctx.httpUrl}/`, {
      headers: { Authorization: authHeader('user', 'pass'), 'X-Forwarded-For': '198.51.100.10' },
    });
    assert.equal(valid.status, 200);
    const afterSuccess = await fetch(`${ctx.httpUrl}/`, {
      headers: { Authorization: wrong, 'X-Forwarded-For': '198.51.100.10' },
    });
    assert.equal(afterSuccess.status, 401);

    currentTime += 6_000;
    await expectWsStatus(
      ctx.wsUrl,
      { Authorization: wrong, 'X-Forwarded-For': '192.0.2.30' },
      401,
    );
    await expectWsStatus(
      ctx.wsUrl,
      { Authorization: wrong, 'X-Forwarded-For': '192.0.2.30' },
      429,
    );
  } finally {
    await stopServer(ctx);
  }
});

test('B35-B38 app login rate limit: 閾値、retry_after_ms、成功解除', async () => {
  let currentTime = 10_000;
  const ctx = await startServer({
    now: () => currentTime,
    rateLimits: {
      appLogin: { windowMs: 10_000, maxFailures: 2, blockMs: 5_000 },
      global: { windowMs: 10_000, maxFailures: 100, blockMs: 5_000 },
      maxEntries: 10,
    },
  });
  try {
    const ws = new WebSocket(ctx.wsUrl, { headers: { 'X-Forwarded-For': '198.51.100.50' } });
    await waitForOpen(ws);
    let response = waitForType(ws, 'auth_ok');
    ws.send(JSON.stringify({ type: 'register', username: 'owner', password: 'password-123' }));
    await response;

    response = waitForType(ws, 'error');
    ws.send(JSON.stringify({ type: 'login', username: 'owner', password: 'wrong-pass' }));
    assert.equal((await response).reason, 'bad_credentials');
    response = waitForType(ws, 'error');
    ws.send(JSON.stringify({ type: 'login', username: 'owner', password: 'wrong-pass' }));
    const limited = await response;
    assert.equal(limited.reason, 'rate_limited');
    assert.equal(limited.retry_after_ms, 5_000);

    response = waitForType(ws, 'auth_ok');
    ws.send(JSON.stringify({ type: 'login', username: 'owner', password: 'password-123' }));
    await response;
    response = waitForType(ws, 'error');
    ws.send(JSON.stringify({ type: 'login', username: 'owner', password: 'wrong-pass' }));
    assert.equal((await response).reason, 'bad_credentials');
    ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('B39-B41 global auth limit: 異なるキーを合算し、全接続を止め、期限後に解除する', async () => {
  let currentTime = 20_000;
  const ctx = await startServer({
    now: () => currentTime,
    rateLimits: {
      appLogin: { windowMs: 10_000, maxFailures: 100, blockMs: 5_000 },
      global: { windowMs: 10_000, maxFailures: 2, blockMs: 5_000 },
      maxEntries: 10,
    },
  });
  try {
    const first = new WebSocket(ctx.wsUrl, { headers: { 'X-Forwarded-For': '198.51.100.60' } });
    await waitForOpen(first);
    let response = waitForType(first, 'error');
    first.send(JSON.stringify({ type: 'login', username: 'unknown-a', password: 'wrong-pass' }));
    assert.equal((await response).reason, 'bad_credentials');
    response = waitForType(first, 'error');
    first.send(JSON.stringify({ type: 'login', username: 'unknown-b', password: 'wrong-pass' }));
    assert.equal((await response).reason, 'rate_limited');

    const second = new WebSocket(ctx.wsUrl, { headers: { 'X-Forwarded-For': '203.0.113.61' } });
    await waitForOpen(second);
    response = waitForType(second, 'error');
    second.send(JSON.stringify({ type: 'login', username: 'unknown-c', password: 'wrong-pass' }));
    assert.equal((await response).reason, 'rate_limited');

    currentTime += 6_000;
    response = waitForType(second, 'error');
    second.send(JSON.stringify({ type: 'login', username: 'unknown-c', password: 'wrong-pass' }));
    assert.equal((await response).reason, 'bad_credentials');
    first.close();
    second.close();
  } finally {
    await stopServer(ctx);
  }
});
