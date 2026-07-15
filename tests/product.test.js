import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createChatServer } from '../src/server.js';

let counter = 0;

function tmpDbPath() {
  return path.join(process.env.TMPDIR || '/tmp', `chat-app-product-${process.pid}-${counter++}.db`);
}

async function startServer() {
  const dbPath = tmpDbPath();
  const app = createChatServer({ dbPath, staticDir: 'public' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, dbPath, url: `ws://127.0.0.1:${app.server.address().port}/` };
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
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });
  return {
    ws,
    async open() {
      if (ws.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    },
    next(type) {
      const index = queue.findIndex((message) => message.type === type);
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);
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

async function register(client, username, password = 'password-123') {
  const responsePromise = client.next('auth_ok');
  client.send('register', { username, password });
  return responsePromise;
}

test('P01 account: 最初の登録者はowner、以降はmember、session resumeとloginが使える', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    await owner.open();
    const ownerAuth = await register(owner, 'owner');
    assert.equal(ownerAuth.user.username, 'owner');
    assert.equal(ownerAuth.user.role, 'owner');
    assert.match(ownerAuth.sessionToken, /^[A-Za-z0-9_-]+$/);

    const member = createClient(ctx.url);
    await member.open();
    const memberAuth = await register(member, 'member');
    assert.equal(memberAuth.user.role, 'member');

    const forbiddenPromise = member.next('error');
    member.send('create_room', { name: 'memberは作れない' });
    assert.equal((await forbiddenPromise).reason, 'forbidden');

    const resumed = createClient(ctx.url);
    await resumed.open();
    const resumePromise = resumed.next('auth_ok');
    resumed.send('resume_session', { token: ownerAuth.sessionToken });
    assert.equal((await resumePromise).user.role, 'owner');

    const login = createClient(ctx.url);
    await login.open();
    const badLoginPromise = login.next('error');
    login.send('login', { username: 'owner', password: 'wrong-password' });
    assert.equal((await badLoginPromise).reason, 'bad_credentials');
    const loginPromise = login.next('auth_ok');
    login.send('login', { username: 'owner', password: 'password-123' });
    assert.equal((await loginPromise).user.username, 'owner');

    owner.close();
    member.close();
    resumed.close();
    login.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P02 roles: ownerがmemberをadminへ変更するとルーム管理権限が付く', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    await register(owner, 'owner');
    const memberAuth = await register(member, 'member');

    const roleUpdatePromise = member.next('users');
    owner.send('set_role', { userId: memberAuth.user.id, role: 'admin' });
    const users = await roleUpdatePromise;
    assert.equal(users.users.find((user) => user.id === memberAuth.user.id).role, 'admin');

    const roomsPromise = member.next('rooms');
    member.send('create_room', { name: 'admin-room' });
    const rooms = await roomsPromise;
    assert.ok(rooms.rooms.some((room) => room.name === 'admin-room'));

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P03 reactions: アカウント単位で絵文字を追加・取消でき、全クライアントへ集計配信される', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    await register(owner, 'owner');
    const memberAuth = await register(member, 'member');

    const messagePromise = member.next('message');
    owner.send('message', { body: 'reaction target' });
    const message = (await messagePromise).message;
    assert.deepEqual(message.reactions, []);

    const addedPromise = owner.next('reaction_update');
    member.send('toggle_reaction', { messageId: message.id, emoji: '👍' });
    const added = await addedPromise;
    assert.equal(added.messageId, message.id);
    assert.deepEqual(added.reactions, [{ emoji: '👍', count: 1, userIds: [memberAuth.user.id] }]);

    const removedPromise = owner.next('reaction_update');
    member.send('toggle_reaction', { messageId: message.id, emoji: '👍' });
    assert.deepEqual((await removedPromise).reactions, []);

    const invalidPromise = member.next('error');
    member.send('toggle_reaction', { messageId: message.id, emoji: '🔥' });
    assert.equal((await invalidPromise).reason, 'bad_reaction');

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P04 standalone threads: 専用作成→一覧→open→返信が独立して動く', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    await register(owner, 'owner');
    await register(member, 'member');

    const createdPromise = owner.next('thread_created');
    const listPromise = member.next('threads');
    owner.send('create_thread', { title: 'UI改善', body: '@member 日時表示を確認して' });
    const created = await createdPromise;
    assert.equal(created.thread.title, 'UI改善');
    assert.equal((await listPromise).threads[0].title, 'UI改善');

    const historyPromise = member.next('thread_history');
    member.send('open_standalone_thread', { threadId: created.thread.id });
    const history = await historyPromise;
    assert.equal(history.thread.id, created.thread.id);
    assert.equal(history.messages[0].body, '@member 日時表示を確認して');

    const replyPromise = owner.next('thread_message');
    member.send('thread_message', { threadId: created.thread.id, body: '確認します' });
    const reply = await replyPromise;
    assert.equal(reply.message.author, 'member');
    assert.equal(reply.message.body, '確認します');

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P05 account boundaries: 重複登録・短いpassword・未認証のaccount操作を拒否する', async () => {
  const ctx = await startServer();
  try {
    const first = createClient(ctx.url);
    const second = createClient(ctx.url);
    await Promise.all([first.open(), second.open()]);
    await register(first, 'same-name');

    const duplicatePromise = second.next('error');
    second.send('register', { username: 'same-name', password: 'password-456' });
    assert.equal((await duplicatePromise).reason, 'account_exists');

    const shortPromise = second.next('error');
    second.send('register', { username: 'short-pass', password: 'short' });
    assert.equal((await shortPromise).reason, 'bad_password');

    const unauthReactionPromise = second.next('error');
    second.send('toggle_reaction', { messageId: 1, emoji: '👍' });
    assert.equal((await unauthReactionPromise).reason, 'not_authenticated');

    first.close();
    second.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P06 message edit/delete: 本人のみ、admin以上は全投稿を操作できる', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    await register(owner, 'owner');
    const memberAuth = await register(member, 'member');

    const ownerMessagePromise = member.next('message');
    const ownerEchoPromise = owner.next('message');
    owner.send('message', { body: 'owner original' });
    const ownerMessage = (await ownerMessagePromise).message;
    assert.equal((await ownerEchoPromise).message.id, ownerMessage.id);

    const forbiddenEdit = member.next('error');
    member.send('edit_message', { messageId: ownerMessage.id, body: '改ざん' });
    assert.equal((await forbiddenEdit).reason, 'forbidden');
    const forbiddenDelete = member.next('error');
    member.send('delete_message', { messageId: ownerMessage.id });
    assert.equal((await forbiddenDelete).reason, 'forbidden');

    const memberMessagePromise = owner.next('message');
    member.send('message', { body: 'member original' });
    const memberMessage = (await memberMessagePromise).message;
    const ownEditPromise = owner.next('message_updated');
    member.send('edit_message', { messageId: memberMessage.id, body: 'member edited' });
    const ownEdit = await ownEditPromise;
    assert.equal(ownEdit.body, 'member edited');
    assert.ok(Number.isInteger(ownEdit.editedAt));
    const statePromise = member.next('state');
    member.send('get_state');
    const persistedMessage = (await statePromise).messages.find((message) => message.id === memberMessage.id);
    assert.equal(persistedMessage.body, 'member edited');
    assert.equal(persistedMessage.edited_at, ownEdit.editedAt);

    const ownDeletePromise = owner.next('message_deleted');
    member.send('delete_message', { messageId: memberMessage.id });
    assert.equal((await ownDeletePromise).messageId, memberMessage.id);

    const createdPromise = owner.next('thread_created');
    owner.send('create_thread', { title: '編集削除', body: 'owner thread body' });
    const thread = (await createdPromise).thread;
    const historyPromise = member.next('thread_history');
    member.send('open_standalone_thread', { threadId: thread.id });
    const initialThreadMessage = (await historyPromise).messages[0];
    const forbiddenThreadDelete = member.next('error');
    member.send('delete_thread_message', {
      threadId: thread.id,
      messageId: initialThreadMessage.id,
    });
    assert.equal((await forbiddenThreadDelete).reason, 'forbidden');

    const replyPromise = owner.next('thread_message');
    member.send('thread_message', { threadId: thread.id, body: 'member reply' });
    const reply = (await replyPromise).message;
    const replyEditPromise = owner.next('thread_message_updated');
    member.send('edit_thread_message', {
      threadId: thread.id,
      messageId: reply.id,
      body: 'member reply edited',
    });
    const replyEdit = await replyEditPromise;
    assert.equal(replyEdit.body, 'member reply edited');
    const editedHistoryPromise = member.next('thread_history');
    member.send('open_standalone_thread', { threadId: thread.id });
    const persistedReply = (await editedHistoryPromise).messages.find((message) => message.id === reply.id);
    assert.equal(persistedReply.body, 'member reply edited');
    assert.equal(persistedReply.edited_at, replyEdit.editedAt);
    const ownerDeleteReply = member.next('thread_message_deleted');
    owner.send('delete_thread_message', { threadId: thread.id, messageId: reply.id });
    assert.equal((await ownerDeleteReply).messageId, reply.id);

    const roleUpdate = member.next('users');
    owner.send('set_role', { userId: memberAuth.user.id, role: 'admin' });
    await roleUpdate;
    const adminEditPromise = owner.next('message_updated');
    member.send('edit_message', { messageId: ownerMessage.id, body: 'admin edited' });
    assert.equal((await adminEditPromise).body, 'admin edited');
    const adminDeletePromise = owner.next('message_deleted');
    member.send('delete_message', { messageId: ownerMessage.id });
    assert.equal((await adminDeletePromise).messageId, ownerMessage.id);

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});
