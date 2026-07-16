// Acceptance tests for #4 デプロイ: env 化・常駐・レスポンシブの仕上げ
//
// 実行: node --test
// resolveConfig（env → 設定値の純粋関数）の正常系・境界系、.env.example の整合、
// admin 有効/無効の回帰を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { resolveConfig, createChatServer } from '../src/server.js';
const execFileAsync = promisify(execFile);

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
    VAPID_SUBJECT: 'https://example.com',
  };
  const config = resolveConfig(env);
  assert.deepEqual(config, {
    port: 8080,
    host: '127.0.0.1',
    dbPath: '/tmp/x.db',
    basicAuth: { user: 'user', password: 'pass' },
    vapidSubject: 'https://example.com',
  });
});

test('T02_boundary resolveConfig: env 未設定なら既定値', () => {
  const config = resolveConfig({});
  assert.deepEqual(config, {
    port: 3000,
    host: undefined,
    dbPath: 'data/chat.db',
    basicAuth: undefined,
    vapidSubject: 'mailto:chat-app@localhost',
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
    'VAPID_SUBJECT',
  ]) {
    assert.match(content, new RegExp(`^${key}=`, 'm'), `.env.example に ${key} が見つからない`);
  }
});

test('T05d_boundary resolveConfig: VAPID_SUBJECTは連絡先URIだけを受理', () => {
  assert.equal(resolveConfig({ VAPID_SUBJECT: 'mailto:admin@example.com' }).vapidSubject, 'mailto:admin@example.com');
  assert.equal(resolveConfig({ VAPID_SUBJECT: 'https://example.com/contact' }).vapidSubject, 'https://example.com/contact');
  assert.throws(() => resolveConfig({ VAPID_SUBJECT: 'admin@example.com' }), /VAPID_SUBJECT/);
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

test('T07 systemd: Webは専用ユーザーと主要hardening、巡回は補助グループを使う', async () => {
  const deployDir = path.join(__dirname, '..', 'deploy');
  const webUnit = await readFile(path.join(deployDir, 'chat-app.service'), 'utf8');
  for (const expected of [
    'User=chat-app',
    'Group=chat-app',
    'WorkingDirectory=/opt/chat-app/current',
    'EnvironmentFile=/etc/chat-app/chat-app.env',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'PrivateDevices=true',
    'ReadWritePaths=/var/lib/chat-app',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'UMask=0007',
  ]) {
    assert.ok(webUnit.split('\n').includes(expected), `missing systemd setting: ${expected}`);
  }
  assert.doesNotMatch(webUnit, /__INSTALL_DIR__|EnvironmentFile=-/);

  const moderationUnit = await readFile(
    path.join(deployDir, 'chat-app-moderation.service'),
    'utf8',
  );
  assert.match(moderationUnit, /^User=shohei$/m);
  assert.match(moderationUnit, /^SupplementaryGroups=chat-app$/m);
  assert.match(moderationUnit, /^ReadWritePaths=\/var\/lib\/chat-app \/home\/shohei\/\.claude$/m);
  assert.match(moderationUnit, /^ProtectHome=read-only$/m);
});

test('T08 deploy scripts: 構文、commit archive、atomic symlink、rollbackを備える', async () => {
  const deployDir = path.join(__dirname, '..', 'deploy');
  const scripts = ['release.sh', 'rollback.sh', 'migrate-state.sh', 'migrate-gen8.sh'];
  for (const script of scripts) {
    await execFileAsync('bash', ['-n', path.join(deployDir, script)]);
  }
  const release = await readFile(path.join(deployDir, 'release.sh'), 'utf8');
  assert.match(release, /git_cmd=.*safe\.directory/);
  assert.match(release, /archive --format=tar/);
  assert.match(release, /npm ci --omit=dev --ignore-scripts/);
  assert.match(release, /mv -Tf .*current/);
  assert.match(release, /restored previous release/);
  const migration = await readFile(path.join(deployDir, 'migrate-gen8.sh'), 'utf8');
  assert.match(migration, /chmod 0660 \/var\/lib\/chat-app\/chat\.db/);
});

test('T09 migration: 一時rootへDB・添付・env・backupを作り、Basic秘密を一度生成する', async () => {
  const temporaryRoot = await mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'chat-app-migration-'));
  const oldDir = path.join(temporaryRoot, 'old');
  const destinationRoot = path.join(temporaryRoot, 'destination');
  const oldUploads = path.join(oldDir, 'uploads');
  await mkdir(oldUploads, { recursive: true });
  const oldEnv = path.join(oldDir, '.env');
  const oldDb = path.join(oldDir, 'chat.db');
  const originalEnv = [
    'PORT=3002',
    'HOST=127.0.0.1',
    'DB_PATH=data/chat.db',
    'BASIC_AUTH_USER=',
    'BASIC_AUTH_PASSWORD=',
    'VAPID_SUBJECT=mailto:test@example.com',
    '',
  ].join('\n');
  await writeFile(oldEnv, originalEnv, { mode: 0o600 });
  await writeFile(oldDb, 'sqlite-data');
  await writeFile(path.join(oldUploads, 'file.bin'), 'upload-data');
  try {
    const script = path.join(__dirname, '..', 'deploy', 'migrate-state.sh');
    const { stdout } = await execFileAsync(
      script,
      [oldEnv, oldDb, oldUploads, destinationRoot],
      { env: { ...process.env, MIGRATION_TIMESTAMP: '20260716T120000Z' } },
    );
    assert.match(stdout, /Basic auth credential \(shown once\): chat:[0-9a-f]{32}/);
    const migratedEnvPath = path.join(destinationRoot, 'etc/chat-app/chat-app.env');
    const migratedEnv = await readFile(migratedEnvPath, 'utf8');
    assert.match(migratedEnv, /^PORT=3002$/m);
    assert.match(migratedEnv, /^HOST=127\.0\.0\.1$/m);
    assert.match(migratedEnv, /^DB_PATH=\/var\/lib\/chat-app\/chat\.db$/m);
    assert.match(migratedEnv, /^BASIC_AUTH_USER=chat$/m);
    assert.match(migratedEnv, /^BASIC_AUTH_PASSWORD=[0-9a-f]{32}$/m);
    assert.equal((await stat(migratedEnvPath)).mode & 0o777, 0o640);
    assert.equal(await readFile(path.join(destinationRoot, 'var/lib/chat-app/chat.db'), 'utf8'), 'sqlite-data');
    assert.equal(await readFile(path.join(destinationRoot, 'var/lib/chat-app/uploads/file.bin'), 'utf8'), 'upload-data');
    assert.equal(
      await readFile(path.join(destinationRoot, 'var/backups/chat-app/20260716T120000Z/chat.db'), 'utf8'),
      'sqlite-data',
    );
    assert.equal(await readFile(oldEnv, 'utf8'), originalEnv);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
