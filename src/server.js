// HTTP 静的配信 + WebSocket（同一ポート相乗り）のサーバー本体。
//
// createChatServer({ dbPath, staticDir }) は factory を export するのみで、
// トップレベルでは listen しない。CLI で直接実行されたときだけ末尾で listen する。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  openDb,
  insertMessage,
  getRecentMessages,
  upsertUser,
  getDefaultRoomId,
  listRooms,
  createRoom,
  deleteRoom,
  getRoomById,
} from './db.js';

const MIN_NODE_VERSION = '22.22.3';
const WS_MAX_PAYLOAD_BYTES = 64 * 1024; // ws 層: 異常フレームだけを close させる上限
const APP_MAX_BODY_BYTES = 8192; // アプリ層: too_large 判定（UTF-8 バイト長）
const MAX_NICKNAME_LENGTH = 32;
const MAX_BODY_LENGTH = 2000;
const HISTORY_LIMIT = 50;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
};

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function checkNodeVersion() {
  if (compareVersions(process.versions.node, MIN_NODE_VERSION) < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `chat-app には Node.js >= ${MIN_NODE_VERSION} が必要です（現在: ${process.versions.node}）。` +
        'node:sqlite をフラグなしで使うためのバージョン固定です（.nvmrc / package.json engines を参照）。',
    );
    process.exit(1);
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function sendStatus(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * 静的ファイル配信。root は factory 起動時に正規化済みの絶対パス。
 * rootReal は root の realpath（symlink 逃げ検証のキャッシュ）。
 */
function serveStatic(req, res, root, rootReal) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, 'Method Not Allowed');
    return;
  }

  let pathname;
  try {
    // 注意: new URL(req.url, base) は WHATWG URL の仕様上 ".." のようなドットセグメントを
    // パース時点で正規化してしまい、後段の境界チェックに ".." が届かなくなる
    // （= traversal 防御が発火しなくなる）。req.url はクエリ文字列を単純に切り離すだけに留め、
    // URL 正規化を経由しないことで境界チェックが機能するようにする。
    const rawPath = req.url.split('?')[0];
    pathname = decodeURIComponent(rawPath);
  } catch {
    sendStatus(res, 400, 'Bad Request');
    return;
  }

  let resolved = path.resolve(root, '.' + pathname);
  const withinRootString = resolved === root || resolved.startsWith(root + path.sep);
  if (!withinRootString) {
    sendStatus(res, 403, 'Forbidden');
    return;
  }

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory || pathname === '/') {
    resolved = path.join(resolved, 'index.html');
  }

  if (!fs.existsSync(resolved)) {
    sendStatus(res, 404, 'Not Found');
    return;
  }

  let targetReal;
  try {
    targetReal = fs.realpathSync(resolved);
  } catch {
    sendStatus(res, 404, 'Not Found');
    return;
  }

  const withinRootReal = targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
  if (!withinRootReal) {
    sendStatus(res, 403, 'Forbidden');
    return;
  }

  res.writeHead(200, { 'Content-Type': getMimeType(targetReal) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(targetReal).pipe(res);
}

/**
 * nickname を検証する。trim → 空拒否 → 最大32文字 → 制御文字/改行拒否。
 * 不正なら null を返す。
 */
function validateNickname(nickname) {
  if (typeof nickname !== 'string') return null;
  const trimmed = nickname.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NICKNAME_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * body を検証・整形する。trim → 空なら null（無視）→ 2000文字で切り詰め。
 */
function sanitizeBody(body) {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_BODY_LENGTH ? trimmed.slice(0, MAX_BODY_LENGTH) : trimmed;
}

/**
 * ルーム名を検証する。ニックネームと同じ規則（trim → 空拒否 → 32文字以内 → 制御文字拒否）。
 * 不正なら null を返す。
 */
function validateRoomName(name) {
  return validateNickname(name);
}

/**
 * roomId 入力を正規化する。number 型かつ正の安全な整数のみ受理。
 * それ以外（文字列 "1"・小数・null・配列など）は null を返す。
 */
function parseRoomId(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * 2つの文字列を定数時間で比較する（timingSafeEqual を SHA-256 ダイジェスト同士で行う）。
 * 長さの異なる文字列同士でも throw しない。
 */
function safeStringEqual(a, b) {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * createChatServer({ dbPath, staticDir, adminPassword }) → { server, wss, db, close }
 * トップレベルでは listen しない。
 */
export function createChatServer({ dbPath, staticDir, adminPassword }) {
  const root = path.resolve(staticDir);
  const rootReal = fs.realpathSync(root);

  const db = openDb(dbPath);
  const defaultRoomId = getDefaultRoomId(db);

  /**
   * DB のルーム一覧を WS プロトコルの形（{id, name}）に整形する。
   * created_at はクライアントに露出させない。
   */
  function roomsPayload() {
    return listRooms(db).map((room) => ({ id: room.id, name: room.name }));
  }

  const server = http.createServer((req, res) => {
    serveStatic(req, res, root, rootReal);
  });

  const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD_BYTES });

  function sendJson(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function sendError(ws, reason) {
    sendJson(ws, { type: 'error', reason });
  }

  function broadcastMessage(row) {
    const payload = JSON.stringify({ type: 'message', message: row });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.roomId === row.room_id) {
        client.send(payload);
      }
    }
  }

  function broadcastRooms() {
    const payload = JSON.stringify({ type: 'rooms', rooms: roomsPayload() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.nickname = null;
    ws.isAdmin = false;
    ws.roomId = null; // join 成功時に defaultRoomId をセット

    ws.on('message', (data) => {
      const rawText = data.toString('utf8');

      if (Buffer.byteLength(rawText, 'utf8') > APP_MAX_BODY_BYTES) {
        sendError(ws, 'too_large');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        sendError(ws, 'bad_json');
        return;
      }

      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        sendError(ws, 'unknown_type');
        return;
      }

      if (parsed.type === 'join') {
        const nickname = validateNickname(parsed.nickname);
        if (nickname === null) {
          sendError(ws, 'bad_nickname');
          return;
        }
        ws.nickname = nickname;
        ws.roomId = defaultRoomId;
        upsertUser(db, nickname);
        const messages = getRecentMessages(db, ws.roomId, HISTORY_LIMIT);
        sendJson(ws, { type: 'history', roomId: ws.roomId, messages });
        sendJson(ws, { type: 'rooms', rooms: roomsPayload() });
        return;
      }

      if (parsed.type === 'message') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const body = sanitizeBody(parsed.body);
        if (body === null) {
          // 空白のみの body は保存もブロードキャストもしない（エラーも返さない）。
          return;
        }
        const row = insertMessage(db, ws.roomId, ws.nickname, body);
        broadcastMessage(row);
        return;
      }

      if (parsed.type === 'admin_auth') {
        if (!adminPassword) {
          sendError(ws, 'admin_disabled');
          return;
        }
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        if (!safeStringEqual(password, adminPassword)) {
          sendError(ws, 'bad_admin_password');
          return;
        }
        ws.isAdmin = true;
        sendJson(ws, { type: 'admin_auth_ok' });
        return;
      }

      if (parsed.type === 'create_room') {
        if (!ws.isAdmin) {
          sendError(ws, 'forbidden');
          return;
        }
        const name = validateRoomName(parsed.name);
        if (name === null) {
          sendError(ws, 'bad_room_name');
          return;
        }
        try {
          createRoom(db, name);
        } catch (err) {
          // UNIQUE 制約違反（名前重複）のときだけ room_exists に変換する。
          // それ以外（DB ロック・I/O エラー等）は握りつぶさず再 throw し、想定外はクラッシュで顕在化させる。
          const isUniqueViolation =
            err.errcode === 2067 || // SQLITE_CONSTRAINT_UNIQUE
            (typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed'));
          if (!isUniqueViolation) {
            throw err;
          }
          sendError(ws, 'room_exists');
          return;
        }
        broadcastRooms();
        return;
      }

      if (parsed.type === 'delete_room') {
        if (!ws.isAdmin) {
          sendError(ws, 'forbidden');
          return;
        }
        const targetRoomId = parseRoomId(parsed.roomId);
        if (targetRoomId === null) {
          sendError(ws, 'room_not_found');
          return;
        }
        if (targetRoomId === defaultRoomId) {
          sendError(ws, 'cannot_delete_default');
          return;
        }
        const existing = getRoomById(db, targetRoomId);
        if (!existing) {
          sendError(ws, 'room_not_found');
          return;
        }
        deleteRoom(db, targetRoomId);

        // 削除ルーム在室中のクライアントをデフォルトルームへ強制移動
        const defaultMessages = getRecentMessages(db, defaultRoomId, HISTORY_LIMIT);
        for (const client of wss.clients) {
          if (client.roomId === targetRoomId) {
            client.roomId = defaultRoomId;
            sendJson(client, { type: 'room_switched', roomId: defaultRoomId, messages: defaultMessages });
          }
        }

        broadcastRooms();
        return;
      }

      if (parsed.type === 'switch_room') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const targetRoomId = parseRoomId(parsed.roomId);
        if (targetRoomId === null) {
          sendError(ws, 'room_not_found');
          return;
        }
        const existing = getRoomById(db, targetRoomId);
        if (!existing) {
          sendError(ws, 'room_not_found');
          return;
        }
        ws.roomId = targetRoomId;
        const messages = getRecentMessages(db, targetRoomId, HISTORY_LIMIT);
        sendJson(ws, { type: 'room_switched', roomId: targetRoomId, messages });
        return;
      }

      sendError(ws, 'unknown_type');
    });
  });

  function close(callback) {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => {
      server.close(() => {
        db.close();
        if (callback) callback();
      });
    });
  }

  return { server, wss, db, close };
}

const isMainModule = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  checkNodeVersion();
  const PORT = process.env.PORT ?? 3000;
  const dbPath = 'data/chat.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const app = createChatServer({ dbPath, staticDir: 'public', adminPassword: process.env.ADMIN_PASSWORD });
  app.server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`chat-app: listening on http://localhost:${PORT}`);
  });
}
