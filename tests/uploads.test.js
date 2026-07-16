import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';
import { getRecentMessages } from '../src/db.js';

async function startServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-app-upload-'));
  const app = createChatServer({ dbPath: path.join(dir, 'chat.db'), staticDir: 'public' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  return { app, dir, httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/` };
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

test('U01 upload: 認証付きアップロード→通常配信・Range配信→添付メッセージが成立する', async () => {
  const ctx = await startServer();
  try {
    const client = await createClient(ctx.wsUrl);
    const auth = await register(client, 'owner');
    const bytes = Buffer.from('0123456789-video-data');

    const unauthorized = await fetch(`${ctx.httpUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent('録画.mp4'), 'Content-Type': 'video/mp4' },
      body: bytes,
    });
    assert.equal(unauthorized.status, 401);

    const uploaded = await fetch(`${ctx.httpUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        'X-Session-Token': auth.sessionToken,
        'X-File-Name': encodeURIComponent('録画.mp4'),
        'Content-Type': 'video/mp4',
      },
      body: bytes,
    });
    assert.equal(uploaded.status, 201);
    const { attachment } = await uploaded.json();
    assert.equal(attachment.name, '録画.mp4');
    assert.equal(attachment.mime_type, 'video/mp4');
    assert.equal(attachment.size, bytes.length);

    const downloaded = await fetch(`${ctx.httpUrl}${attachment.url}`);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    assert.equal(downloaded.headers.get('accept-ranges'), 'bytes');

    const ranged = await fetch(`${ctx.httpUrl}${attachment.url}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 2-5/${bytes.length}`);
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '2345');

    const broadcast = client.next('message');
    client.send('message', { body: '', attachmentId: attachment.id });
    const message = (await broadcast).message;
    assert.equal(message.body, '');
    assert.equal(message.attachment.name, '録画.mp4');
    assert.equal(getRecentMessages(ctx.app.db, message.room_id)[0].attachment.id, attachment.id);
    client.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('U02 upload boundaries: 他人の添付参照・空ファイル・不明ファイルを拒否する', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const member = await createClient(ctx.wsUrl);
    const ownerAuth = await register(owner, 'owner');
    await register(member, 'member', await issueInvite(ctx, ownerAuth.sessionToken));

    const empty = await fetch(`${ctx.httpUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        'X-Session-Token': ownerAuth.sessionToken,
        'X-File-Name': encodeURIComponent('empty.txt'),
        'Content-Type': 'text/plain',
      },
      body: Buffer.alloc(0),
    });
    assert.equal(empty.status, 400);

    const uploaded = await fetch(`${ctx.httpUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        'X-Session-Token': ownerAuth.sessionToken,
        'X-File-Name': encodeURIComponent('private.txt'),
        'Content-Type': 'text/plain',
      },
      body: Buffer.from('hello'),
    });
    const { attachment } = await uploaded.json();

    const forbidden = member.next('error');
    member.send('message', { body: 'steal', attachmentId: attachment.id });
    assert.equal((await forbidden).reason, 'bad_attachment');

    const missing = await fetch(`${ctx.httpUrl}/uploads/not-found`);
    assert.equal(missing.status, 404);
    owner.ws.close();
    member.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('U03 profile: 表示名・自己紹介・本人の画像を設定し、他人の画像は拒否する', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const member = await createClient(ctx.wsUrl);
    const ownerAuth = await register(owner, 'owner');
    await register(member, 'member', await issueInvite(ctx, ownerAuth.sessionToken));
    const uploaded = await fetch(`${ctx.httpUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        'X-Session-Token': ownerAuth.sessionToken,
        'X-File-Name': encodeURIComponent('avatar.png'),
        'Content-Type': 'image/png',
      },
      body: Buffer.from('fake-png'),
    });
    const { attachment } = await uploaded.json();

    const updated = owner.next('profile_updated');
    owner.send('update_profile', {
      displayName: 'オーナー表示名',
      bio: 'UIを試しています',
      avatarId: attachment.id,
    });
    const profile = (await updated).user;
    assert.equal(profile.display_name, 'オーナー表示名');
    assert.equal(profile.bio, 'UIを試しています');
    assert.equal(profile.avatar.id, attachment.id);

    const rejected = member.next('error');
    member.send('update_profile', { displayName: 'member', bio: '', avatarId: attachment.id });
    assert.equal((await rejected).reason, 'bad_avatar');
    owner.ws.close();
    member.ws.close();
  } finally {
    await stopServer(ctx);
  }
});

test('U04 upload security: HTML/SVGはdownload、安全な画像・動画だけinline、SVG avatarは拒否', async () => {
  const ctx = await startServer();
  try {
    const owner = await createClient(ctx.wsUrl);
    const auth = await register(owner, 'owner');
    async function upload(name, mimeType, body) {
      const response = await fetch(`${ctx.httpUrl}/api/uploads`, {
        method: 'POST',
        headers: {
          'X-Session-Token': auth.sessionToken,
          'X-File-Name': encodeURIComponent(name),
          'Content-Type': mimeType,
        },
        body: Buffer.from(body),
      });
      assert.equal(response.status, 201);
      return (await response.json()).attachment;
    }

    const html = await upload('attack.html', 'text/html; charset=utf-8', '<script>alert(1)</script>');
    const svg = await upload('attack.svg', 'image/svg+xml', '<svg onload="alert(1)"/>');
    const png = await upload('safe.png', 'Image/PNG; charset=binary', 'fake-png');
    const video = await upload('safe.mov', 'video/quicktime', 'fake-video');

    for (const attachment of [html, svg]) {
      const response = await fetch(`${ctx.httpUrl}${attachment.url}`);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.match(response.headers.get('content-disposition'), /^attachment;/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
    for (const attachment of [png, video]) {
      const response = await fetch(`${ctx.httpUrl}${attachment.url}`);
      assert.equal(response.headers.get('content-type'), attachment.mime_type);
      assert.match(response.headers.get('content-disposition'), /^inline;/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal(png.mime_type, 'image/png');

    const rejected = owner.next('error');
    owner.send('update_profile', { displayName: 'owner', bio: '', avatarId: svg.id });
    assert.equal((await rejected).reason, 'bad_avatar');
    owner.ws.close();
  } finally {
    await stopServer(ctx);
  }
});
