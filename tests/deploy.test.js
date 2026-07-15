// Acceptance tests for #4 デプロイ: env 化・常駐・レスポンシブの仕上げ
//
// 実行: node --test
// resolveConfig（env → 設定値の純粋関数）の正常系・境界系、.env.example の整合、
// admin 有効/無効の回帰を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { resolveConfig, createChatServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let counter = 0;

function tmpDbPath() {
  return path.join(process.env.TMPDIR || '/tmp', `chat-app-deploy-test-${process.pid}-${counter++}.db`);
}

async function startServer({ dbPath = tmpDbPath(), adminPassword } = {}) {
  const app = createChatServer({ dbPath, staticDir: 'public', adminPassword });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  return { app, port, dbPath, url: `ws://127.0.0.1:${port}/` };
}

async function stopServer(ctx) {
  const { existsSync } = await import('node:fs');
  const { rm } = await import('node:fs/promises');
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

async function closeClient(ws) {
  ws.close();
  await once(ws, 'close');
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

test('T01 resolveConfig: 全 env を渡すと各値が反映される', () => {
  const env = {
    PORT: '8080',
    HOST: '127.0.0.1',
    DB_PATH: '/tmp/x.db',
    BASIC_AUTH_USER: 'user',
    BASIC_AUTH_PASSWORD: 'pass',
  };
  const config = resolveConfig(env);
  assert.deepEqual(config, {
    port: 8080,
    host: '127.0.0.1',
    dbPath: '/tmp/x.db',
    basicAuth: { user: 'user', password: 'pass' },
  });
});

test('T02_boundary resolveConfig: env 未設定なら既定値', () => {
  const config = resolveConfig({});
  assert.deepEqual(config, {
    port: 3000,
    host: undefined,
    dbPath: 'data/chat.db',
    basicAuth: undefined,
  });
});

test('T03_boundary resolveConfig: 廃止済みADMIN_PASSWORDは設定へ露出しない', () => {
  const config = resolveConfig({ ADMIN_PASSWORD: 'legacy-secret' });
  assert.equal('adminPassword' in config, false);
});

test('T04 .env.example が resolveConfig 参照キーを網羅', async () => {
  const envExamplePath = path.join(__dirname, '..', '.env.example');
  const content = await readFile(envExamplePath, 'utf8');
  for (const key of [
    'PORT',
    'HOST',
    'DB_PATH',
    'BASIC_AUTH_USER',
    'BASIC_AUTH_PASSWORD',
  ]) {
    assert.match(content, new RegExp(`^${key}=`, 'm'), `.env.example に ${key} が見つからない`);
  }
});

test('T05_boundary resolveConfig: 不正 PORT は throw（fail-fast）', () => {
  for (const bad of ['abc', '0', '65536', '-1', '12.5']) {
    assert.throws(() => resolveConfig({ PORT: bad }), Error, `PORT=${bad} は throw するべき`);
  }
});

test('T05b_boundary resolveConfig: 前後空白付き/空白のみ PORT', () => {
  assert.equal(resolveConfig({ PORT: ' 8080 ' }).port, 8080);
  assert.equal(resolveConfig({ PORT: '   ' }).port, 3000);
});

test('T05c_boundary resolveConfig: HOST/DB_PATH 空白のみは未設定扱い', () => {
  const config = resolveConfig({ HOST: '   ', DB_PATH: '   ' });
  assert.equal(config.host, undefined);
  assert.equal(config.dbPath, 'data/chat.db');
});

test('T06 旧admin_authはADMIN_PASSWORDの有無にかかわらず無効', async () => {
  const ctxDisabled = await startServer();
  try {
    const client = new WebSocket(ctxDisabled.url);
    await waitForOpen(client);
    const responsePromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'admin_auth', password: 'x' }));
    const response = await responsePromise;
    assert.equal(response.type, 'error');
    assert.equal(response.reason, 'admin_disabled');
    await closeClient(client);
  } finally {
    await stopServer(ctxDisabled);
  }

  // createChatServerへ旧引数を渡しても権限は得られない。
  const ctxEnabled = await startServer({ adminPassword: 'correct-horse' });
  try {
    const client = new WebSocket(ctxEnabled.url);
    await waitForOpen(client);
    const okPromise = nextMessage(client);
    client.send(JSON.stringify({ type: 'admin_auth', password: 'correct-horse' }));
    const okResponse = await okPromise;
    assert.equal(okResponse.type, 'error');
    assert.equal(okResponse.reason, 'admin_disabled');
    await closeClient(client);
  } finally {
    await stopServer(ctxEnabled);
  }
});
