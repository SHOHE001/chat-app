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
  const port = app.server.address().port;
  return {
    app,
    dbPath,
    url: `ws://127.0.0.1:${port}/`,
    httpUrl: `http://127.0.0.1:${port}`,
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

async function register(client, username, password = 'password-123', invite = undefined) {
  const responsePromise = client.next('auth_ok');
  client.send('register', { username, password, invite });
  return responsePromise;
}

async function issueInvite(ctx, sessionToken) {
  const response = await fetch(
    `${ctx.httpUrl}/api/registration-qr?origin=${encodeURIComponent(ctx.httpUrl)}`,
    { method: 'POST', headers: { 'X-Session-Token': sessionToken } },
  );
  assert.equal(response.status, 200);
  return new URL((await response.json()).registrationUrl).searchParams.get('invite');
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
    const memberAuth = await register(member, 'member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken));
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
    const ownerAuth = await register(owner, 'owner');
    const memberAuth = await register(member, 'member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken));

    const roleUpdatePromise = member.next('users');
    owner.send('set_role', { userId: memberAuth.user.id, role: 'admin' });
    const users = await roleUpdatePromise;
    assert.equal(users.users.find((user) => user.id === memberAuth.user.id).role, 'admin');
    await member.next('rooms');

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

test('P02b display roles: 大人・子供・スタッフはmemberと同じ一般権限', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const target = createClient(ctx.url);
    await Promise.all([owner.open(), target.open()]);
    const ownerAuth = await register(owner, 'role-owner');
    const targetAuth = await register(
      target, 'role-target', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken),
    );
    for (const role of ['adult', 'child', 'staff']) {
      const update = target.next('users');
      owner.send('set_role', { userId: targetAuth.user.id, role });
      assert.equal((await update).users.find((user) => user.id === targetAuth.user.id).role, role);
      const forbidden = target.next('error');
      target.send('create_room', { name: `${role}-room` });
      assert.equal((await forbidden).reason, 'forbidden');
    }
    const badRole = owner.next('error');
    owner.send('set_role', { userId: targetAuth.user.id, role: 'moderator' });
    assert.equal((await badRole).reason, 'bad_role');
    owner.close();
    target.close();
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
    const ownerAuth = await register(owner, 'owner');
    const memberAuth = await register(member, 'member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken));

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
    const ownerAuth = await register(owner, 'owner');
    await register(member, 'member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken));

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
    const firstAuth = await register(first, 'same-name');
    const invite = await issueInvite(ctx, firstAuth.sessionToken);

    const duplicatePromise = second.next('error');
    second.send('register', { username: 'same-name', password: 'password-456', invite });
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
    const ownerAuth = await register(owner, 'owner');
    const memberAuth = await register(member, 'member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken));

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

test('P07 ban: 一時BANは接続と全セッションを失効し、解除後に再ログインできる', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    const ownerAuth = await register(owner, 'ban-owner');
    const memberAuth = await register(member, 'ban-member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken));

    const bannedErrorPromise = member.next('error');
    const memberClosedPromise = new Promise((resolve) => member.ws.once('close', resolve));
    const usersPromise = owner.next('users');
    const before = Date.now();
    owner.send('ban_user', { userId: memberAuth.user.id, duration: '1h' });
    const bannedError = await bannedErrorPromise;
    assert.equal(bannedError.reason, 'account_banned');
    assert.ok(bannedError.bannedUntil >= before + 60 * 60 * 1000);
    await memberClosedPromise;
    const users = (await usersPromise).users;
    assert.equal(users.find((user) => user.id === memberAuth.user.id).banned_until, bannedError.bannedUntil);

    const resumed = createClient(ctx.url);
    await resumed.open();
    const resumeError = resumed.next('error');
    resumed.send('resume_session', { token: memberAuth.sessionToken });
    assert.equal((await resumeError).reason, 'invalid_session');

    const login = createClient(ctx.url);
    await login.open();
    const loginError = login.next('error');
    login.send('login', { username: 'ban-member', password: 'password-123' });
    const blocked = await loginError;
    assert.equal(blocked.reason, 'account_banned');
    assert.equal(blocked.bannedUntil, bannedError.bannedUntil);

    const unbannedUsers = owner.next('users');
    owner.send('unban_user', { userId: memberAuth.user.id });
    assert.equal(
      (await unbannedUsers).users.find((user) => user.id === memberAuth.user.id).banned_until,
      null,
    );
    const loginOk = login.next('auth_ok');
    login.send('login', { username: 'ban-member', password: 'password-123' });
    assert.equal((await loginOk).user.username, 'ban-member');

    owner.close();
    resumed.close();
    login.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P08 ban hierarchy: adminは一般ロール、ownerはadminも永久BANでき、期限切れは自動解除', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const admin = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), admin.open(), member.open()]);
    const ownerAuth = await register(owner, 'hierarchy-owner');
    const invite = await issueInvite(ctx, ownerAuth.sessionToken);
    const adminAuth = await register(admin, 'hierarchy-admin', 'password-123', invite);
    const memberAuth = await register(member, 'hierarchy-member', 'password-123', invite);

    const roleUpdate = admin.next('users');
    owner.send('set_role', { userId: adminAuth.user.id, role: 'admin' });
    await roleUpdate;
    await member.next('users');
    const childRoleUpdate = member.next('users');
    owner.send('set_role', { userId: memberAuth.user.id, role: 'child' });
    assert.equal(
      (await childRoleUpdate).users.find((user) => user.id === memberAuth.user.id).role,
      'child',
    );

    for (const targetId of [ownerAuth.user.id, adminAuth.user.id]) {
      const forbidden = admin.next('error');
      admin.send('ban_user', { userId: targetId, duration: '10m' });
      assert.equal((await forbidden).reason, 'forbidden');
    }
    const invalidDuration = admin.next('error');
    admin.send('ban_user', { userId: memberAuth.user.id, duration: 'forever-ish' });
    assert.equal((await invalidDuration).reason, 'bad_ban_duration');

    const memberBanned = member.next('error');
    admin.send('ban_user', { userId: memberAuth.user.id, duration: 'permanent' });
    assert.deepEqual(await memberBanned, {
      type: 'error',
      reason: 'account_banned',
      bannedUntil: -1,
    });

    const adminBanned = admin.next('error');
    owner.send('ban_user', { userId: adminAuth.user.id, duration: '10m' });
    assert.equal((await adminBanned).reason, 'account_banned');

    ctx.app.db.prepare(
      'UPDATE users SET banned_until = ?, banned_at = ?, banned_by_user_id = ? WHERE id = ?',
    ).run(Date.now() - 1, Date.now() - 1000, ownerAuth.user.id, memberAuth.user.id);
    const expiredLogin = createClient(ctx.url);
    await expiredLogin.open();
    const loginOk = expiredLogin.next('auth_ok');
    expiredLogin.send('login', { username: 'hierarchy-member', password: 'password-123' });
    assert.equal((await loginOk).user.banned_until, null);

    owner.close();
    expiredLogin.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P09 reports: 理由選択・自由記述・文脈保全・管理者一覧・重複防止が成立する', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    const ownerAuth = await register(owner, 'report-owner');
    const memberAuth = await register(
      member,
      'report-member',
      'password-123',
      await issueInvite(ctx, ownerAuth.sessionToken),
    );

    const sentMessages = [];
    for (const body of ['前の会話1', '前の会話2', '個人情報らしい投稿', '後の会話1', '後の会話2']) {
      const delivered = member.next('message');
      owner.send('message', { body });
      sentMessages.push((await delivered).message);
    }
    const target = sentMessages[2];

    const badFreeform = member.next('error');
    member.send('report_message', {
      targetKind: 'message',
      messageId: target.id,
      category: 'other',
      details: '',
    });
    assert.equal((await badFreeform).reason, 'bad_report');

    const submitted = member.next('report_submitted');
    const moderatorNotice = owner.next('report_created');
    member.send('report_message', {
      targetKind: 'message',
      messageId: target.id,
      category: 'personal_info',
      details: '学校名のような情報があります',
    });
    assert.ok(Number.isInteger((await submitted).reportId));
    const reported = (await moderatorNotice).report;
    assert.equal(reported.reporter_user_id, memberAuth.user.id);
    assert.equal(reported.category, 'personal_info');
    assert.equal(reported.message.body, '個人情報らしい投稿');
    assert.equal(reported.details, '学校名のような情報があります');
    assert.deepEqual(reported.context.map((item) => item.body), sentMessages.map((item) => item.body));
    assert.equal(reported.ai_status, 'pending');

    const duplicate = member.next('error');
    member.send('report_message', {
      targetKind: 'message',
      messageId: target.id,
      category: 'harassment',
      details: '',
    });
    assert.equal((await duplicate).reason, 'already_reported');

    const forbiddenList = member.next('error');
    member.send('get_reports');
    assert.equal((await forbiddenList).reason, 'forbidden');

    const deleted = member.next('message_deleted');
    owner.send('delete_message', { messageId: target.id });
    assert.equal((await deleted).messageId, target.id);

    const createdThread = owner.next('thread_created');
    owner.send('create_thread', { title: '通報対象スレッド', body: '自由記述で知らせたい投稿' });
    const thread = (await createdThread).thread;
    const threadHistory = member.next('thread_history');
    member.send('open_standalone_thread', { threadId: thread.id });
    const threadMessage = (await threadHistory).messages[0];
    const threadSubmitted = member.next('report_submitted');
    const threadNotice = owner.next('report_created');
    member.send('report_message', {
      targetKind: 'thread',
      threadId: thread.id,
      messageId: threadMessage.id,
      category: 'other',
      details: 'スタッフに直接確認してほしいです',
    });
    await threadSubmitted;
    assert.equal((await threadNotice).report.target_kind, 'thread');

    const reportsPromise = owner.next('reports');
    owner.send('get_reports');
    const reports = (await reportsPromise).reports;
    assert.equal(reports.length, 2);
    const preserved = reports.find((report) => report.target_kind === 'message');
    assert.equal(preserved.message.body, '個人情報らしい投稿');
    assert.equal(preserved.context.length, 5);

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P10 AI posting block: 新規投稿を拒否しowner/adminが解除できる', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    const ownerAuth = await register(owner, 'block-owner');
    const memberAuth = await register(
      member, 'block-member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken),
    );
    member.close();
    ctx.app.db.prepare(
      'UPDATE users SET posting_blocked_at = ?, posting_blocked_reason = ? WHERE id = ?',
    ).run(Date.now(), 'テスト違反', memberAuth.user.id);
    const blocked = createClient(ctx.url);
    await blocked.open();
    const login = blocked.next('auth_ok');
    blocked.send('login', { username: 'block-member', password: 'password-123' });
    assert.ok((await login).user.posting_blocked_at);
    for (const [type, payload] of [
      ['message', { body: 'blocked message' }],
      ['create_thread', { title: 'blocked thread' }],
      ['thread_message', { threadId: 1, body: 'blocked reply' }],
    ]) {
      const error = blocked.next('error');
      blocked.send(type, payload);
      assert.equal((await error).reason, 'posting_blocked');
    }
    const usersUpdate = blocked.next('users');
    owner.send('unblock_posting', { userId: memberAuth.user.id });
    const updated = (await usersUpdate).users.find((user) => user.id === memberAuth.user.id);
    assert.equal(updated.posting_blocked_at, null);
    const delivered = owner.next('message');
    blocked.send('message', { body: 'posting restored' });
    assert.equal((await delivered).message.body, 'posting restored');
    owner.close();
    blocked.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P11 moderator hide: memberを拒否しadmin以上は投稿をDB保持のまま非表示にする', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    const ownerAuth = await register(owner, 'hide-owner');
    const memberAuth = await register(
      member, 'hide-member', 'password-123', await issueInvite(ctx, ownerAuth.sessionToken),
    );
    const received = member.next('message');
    owner.send('message', { body: 'manual hide target' });
    const message = (await received).message;

    const forbidden = member.next('error');
    member.send('hide_message', { messageId: message.id });
    assert.equal((await forbidden).reason, 'forbidden');

    const roleUpdate = member.next('users');
    owner.send('set_role', { userId: memberAuth.user.id, role: 'admin' });
    await roleUpdate;
    const hidden = owner.next('message_hidden');
    member.send('hide_message', { messageId: message.id });
    assert.equal((await hidden).messageId, message.id);
    const stored = ctx.app.db.prepare('SELECT hidden_at, body FROM messages WHERE id = ?').get(message.id);
    assert.equal(stored.body, 'manual hide target');
    assert.ok(stored.hidden_at);

    const created = owner.next('thread_created');
    owner.send('create_thread', { title: 'hide thread', body: 'hide reply target' });
    const thread = (await created).thread;
    const history = member.next('thread_history');
    member.send('open_standalone_thread', { threadId: thread.id });
    const threadMessage = (await history).messages[0];
    const threadHidden = owner.next('thread_message_hidden');
    member.send('hide_thread_message', { threadId: thread.id, messageId: threadMessage.id });
    assert.equal((await threadHidden).messageId, threadMessage.id);
    assert.ok(ctx.app.db.prepare(
      'SELECT hidden_at FROM standalone_thread_messages WHERE id = ?',
    ).get(threadMessage.id).hidden_at);

    owner.close();
    member.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P12 restricted rooms: 指定ロールだけに表示・入室を許可し、権限喪失時は全体へ戻す', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const adultSetup = createClient(ctx.url);
    const childSetup = createClient(ctx.url);
    await Promise.all([owner.open(), adultSetup.open(), childSetup.open()]);
    const ownerAuth = await register(owner, 'room-owner');
    const invite = await issueInvite(ctx, ownerAuth.sessionToken);
    const adultAuth = await register(adultSetup, 'room-adult', 'password-123', invite);
    const childAuth = await register(childSetup, 'room-child', 'password-123', invite);
    adultSetup.close();
    childSetup.close();
    ctx.app.db.prepare('UPDATE users SET role = ? WHERE id = ?').run('adult', adultAuth.user.id);
    ctx.app.db.prepare('UPDATE users SET role = ? WHERE id = ?').run('child', childAuth.user.id);

    const adult = createClient(ctx.url);
    const child = createClient(ctx.url);
    await Promise.all([adult.open(), child.open()]);
    const adultLogin = adult.next('auth_ok');
    adult.send('login', { username: 'room-adult', password: 'password-123' });
    assert.equal((await adultLogin).user.role, 'adult');
    const childLogin = child.next('auth_ok');
    child.send('login', { username: 'room-child', password: 'password-123' });
    assert.equal((await childLogin).user.role, 'child');

    for (const allowedRoles of [['owner'], ['adult', 'adult'], 'adult']) {
      const invalid = owner.next('error');
      owner.send('create_room', { name: 'invalid-room', allowedRoles });
      assert.equal((await invalid).reason, 'bad_room_access');
    }

    const ownerRooms = owner.next('rooms');
    const adultRooms = adult.next('rooms');
    const childRooms = child.next('rooms');
    owner.send('create_room', { name: '大人限定', allowedRoles: ['adult'] });
    const ownerRestricted = (await ownerRooms).rooms.find((room) => room.name === '大人限定');
    const adultRestricted = (await adultRooms).rooms.find((room) => room.name === '大人限定');
    assert.deepEqual(ownerRestricted.allowedRoles, ['adult']);
    assert.equal(adultRestricted.id, ownerRestricted.id);
    assert.equal((await childRooms).rooms.some((room) => room.id === ownerRestricted.id), false);

    const denied = child.next('error');
    child.send('switch_room', { roomId: ownerRestricted.id });
    assert.equal((await denied).reason, 'room_not_found');

    const switched = adult.next('room_switched');
    adult.send('switch_room', { roomId: ownerRestricted.id });
    assert.equal((await switched).roomId, ownerRestricted.id);

    const usersChanged = adult.next('users');
    const evicted = adult.next('room_switched');
    const restrictedListRemoved = adult.next('rooms');
    owner.send('set_role', { userId: adultAuth.user.id, role: 'child' });
    assert.equal(
      (await usersChanged).users.find((user) => user.id === adultAuth.user.id).role,
      'child',
    );
    assert.notEqual((await evicted).roomId, ownerRestricted.id);
    assert.equal(
      (await restrictedListRemoved).rooms.some((room) => room.id === ownerRestricted.id),
      false,
    );

    owner.close();
    adult.close();
    child.close();
  } finally {
    await stopServer(ctx);
  }
});

test('P13 room notifications: アカウントごとにオンオフし、再ログイン後も設定を維持する', async () => {
  const ctx = await startServer();
  try {
    const owner = createClient(ctx.url);
    const member = createClient(ctx.url);
    await Promise.all([owner.open(), member.open()]);
    const ownerAuth = await register(owner, 'notification-owner');
    await register(
      member,
      'notification-member',
      'password-123',
      await issueInvite(ctx, ownerAuth.sessionToken),
    );
    const memberMirror = createClient(ctx.url);
    await memberMirror.open();
    const mirrorAuth = memberMirror.next('auth_ok');
    memberMirror.send('login', { username: 'notification-member', password: 'password-123' });
    await mirrorAuth;

    const memberState = member.next('state');
    member.send('get_state');
    const defaultRoom = (await memberState).rooms[0];
    assert.equal(defaultRoom.notificationsEnabled, true);

    const mutedRooms = member.next('rooms');
    const mirroredMutedRooms = memberMirror.next('rooms');
    member.send('set_room_notification', { roomId: defaultRoom.id, enabled: false });
    assert.equal(
      (await mutedRooms).rooms.find((room) => room.id === defaultRoom.id).notificationsEnabled,
      false,
    );
    assert.equal(
      (await mirroredMutedRooms).rooms.find((room) => room.id === defaultRoom.id)
        .notificationsEnabled,
      false,
    );

    const ownerState = owner.next('state');
    owner.send('get_state');
    assert.equal(
      (await ownerState).rooms.find((room) => room.id === defaultRoom.id).notificationsEnabled,
      true,
    );

    const invalid = member.next('error');
    member.send('set_room_notification', { roomId: defaultRoom.id, enabled: 'no' });
    assert.equal((await invalid).reason, 'bad_room_notification');

    member.close();
    memberMirror.close();
    const relogin = createClient(ctx.url);
    await relogin.open();
    const auth = relogin.next('auth_ok');
    relogin.send('login', { username: 'notification-member', password: 'password-123' });
    await auth;
    const restoredState = relogin.next('state');
    relogin.send('get_state');
    assert.equal(
      (await restoredState).rooms.find((room) => room.id === defaultRoom.id).notificationsEnabled,
      false,
    );

    owner.close();
    relogin.close();
  } finally {
    await stopServer(ctx);
  }
});
