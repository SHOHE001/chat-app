import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAccount, createMessageReport, getAccountById, getDefaultRoomId,
  getRecentMessages, insertMessage, listMessageReports, openDb,
  updateMessage,
} from '../src/db.js';
import { runModerationCycle } from '../src/moderation.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-moderation-'));
  const db = openDb(path.join(dir, 'chat.db'));
  const user = createAccount(db, 'member', 'test-hash');
  const roomId = getDefaultRoomId(db);
  return {
    db, user, roomId,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function patrolResponse(prompt, flagged = false) {
  const keys = [...prompt.matchAll(/patrol:message:\d+:\d+/g)].map((match) => match[0]);
  return {
    findings: keys.map((key) => ({
      key, flagged, category: flagged ? 'harassment' : 'none',
      severity: flagged ? 'high' : 'none', rationale: flagged ? '要確認' : '問題なし',
    })),
  };
}

function keepResult() {
  return {
    confirmed: false, decision: 'keep', category: 'none',
    severity: 'none', rationale: '問題なし',
  };
}

test('AI01 patrol: Haikuが全件clearならOpusを呼ばず再巡回もしない', async () => {
  const f = fixture();
  try {
    insertMessage(f.db, f.roomId, f.user.username, 'hello', null, f.user.id);
    const calls = [];
    const invokeModel = async (model, schema, prompt) => {
      calls.push(model);
      assert.match(prompt, /hello/);
      return patrolResponse(prompt);
    };
    assert.deepEqual(await runModerationCycle({ db: f.db, invokeModel }), {
      reports: 0, scanned: 1, escalated: 0, hidden: 0, blocked: 0,
    });
    assert.deepEqual(calls, ['haiku']);
    await runModerationCycle({ db: f.db, invokeModel });
    assert.deepEqual(calls, ['haiku']);
  } finally {
    f.close();
  }
});

test('AI02 patrol: Haiku検知をOpusが誤検知と判断すれば表示を維持する', async () => {
  const f = fixture();
  try {
    insertMessage(f.db, f.roomId, f.user.username, 'ambiguous', null, f.user.id);
    const calls = [];
    const invokeModel = async (model, schema, prompt) => {
      calls.push(model);
      return model === 'opus' ? keepResult() : patrolResponse(prompt, true);
    };
    const stats = await runModerationCycle({ db: f.db, invokeModel });
    assert.deepEqual(calls, ['haiku', 'opus']);
    assert.equal(stats.hidden, 0);
    assert.equal(getRecentMessages(f.db, f.roomId).length, 1);
  } finally {
    f.close();
  }
});

test('AI03 patrol: Opus確定で非表示、30日内の異なる3件で投稿停止する', async () => {
  const f = fixture();
  try {
    for (const body of ['bad 1', 'bad 2', 'bad 3']) {
      insertMessage(f.db, f.roomId, f.user.username, body, null, f.user.id);
    }
    const invokeModel = async (model, schema, prompt) => {
      if (model === 'haiku') return patrolResponse(prompt, true);
      return {
        confirmed: true, decision: 'hide', category: 'harassment',
        severity: 'high', rationale: '明確な嫌がらせ',
      };
    };
    const stats = await runModerationCycle({ db: f.db, invokeModel, now: 2_000_000_000_000 });
    assert.equal(stats.hidden, 3);
    assert.equal(stats.blocked, 1);
    assert.equal(getRecentMessages(f.db, f.roomId).length, 0);
    assert.equal(getAccountById(f.db, f.user.id).posting_blocked_at, 2_000_000_000_000);
  } finally {
    f.close();
  }
});

test('AI04 report: Haikuを通さずOpusが通報と保存済み文脈を先に審査する', async () => {
  const f = fixture();
  try {
    const message = insertMessage(f.db, f.roomId, f.user.username, 'reported', null, f.user.id);
    createMessageReport(f.db, {
      reporterUserId: f.user.id, targetKind: 'message', message, roomId: f.roomId,
      category: 'personal_info', details: '住所に見える',
    });
    const calls = [];
    const invokeModel = async (model, schema, prompt) => {
      calls.push(model);
      if (model === 'opus') {
        assert.match(prompt, /住所に見える/);
        return keepResult();
      }
      return patrolResponse(prompt);
    };
    const stats = await runModerationCycle({ db: f.db, invokeModel });
    assert.equal(stats.reports, 1);
    assert.deepEqual(calls, ['opus', 'haiku']);
    const report = listMessageReports(f.db)[0];
    assert.equal(report.status, 'resolved');
    assert.equal(report.ai_status, 'complete');
  } finally {
    f.close();
  }
});

test('AI05 race: 審査中に編集された新本文を古い判定で非表示にしない', async () => {
  const f = fixture();
  try {
    const message = insertMessage(f.db, f.roomId, f.user.username, 'old text', null, f.user.id);
    const invokeModel = async (model, schema, prompt) => {
      if (model === 'haiku') return patrolResponse(prompt, true);
      updateMessage(f.db, message.id, f.roomId, 'clean edited text');
      return {
        confirmed: true, decision: 'hide', category: 'harassment',
        severity: 'high', rationale: '古い本文への判定',
      };
    };
    const stats = await runModerationCycle({ db: f.db, invokeModel });
    assert.equal(stats.hidden, 0);
    assert.equal(getRecentMessages(f.db, f.roomId)[0].body, 'clean edited text');
    assert.equal(getAccountById(f.db, f.user.id).posting_blocked_at, null);
  } finally {
    f.close();
  }
});
