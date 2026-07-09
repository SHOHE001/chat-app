// HTTP 静的配信 + WebSocket（同一ポート相乗り）のサーバー本体。
//
// createChatServer({ dbPath, staticDir }) は factory を export するのみで、
// トップレベルでは listen しない。CLI で直接実行されたときだけ末尾で listen する。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { openDb, insertMessage, getRecentMessages, upsertUser, getDefaultRoomId } from './db.js';

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
 * createChatServer({ dbPath, staticDir }) → { server, wss, db, close }
 * トップレベルでは listen しない。
 */
export function createChatServer({ dbPath, staticDir }) {
  const root = path.resolve(staticDir);
  const rootReal = fs.realpathSync(root);

  const db = openDb(dbPath);
  const roomId = getDefaultRoomId(db);

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
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.nickname = null;

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
        upsertUser(db, nickname);
        const messages = getRecentMessages(db, roomId, HISTORY_LIMIT);
        sendJson(ws, { type: 'history', messages });
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
        const row = insertMessage(db, roomId, ws.nickname, body);
        broadcastMessage(row);
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
  const app = createChatServer({ dbPath, staticDir: 'public' });
  app.server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`chat-app: listening on http://localhost:${PORT}`);
  });
}
