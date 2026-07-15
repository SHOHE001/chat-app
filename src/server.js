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
import webpush from 'web-push';
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
  getThreadMessages,
  getMessageById,
  updateMessage,
  deleteMessage,
  createAccount,
  getAccountByUsername,
  getAccountById,
  listAccounts,
  setAccountRole,
  setAccountBan,
  clearAccountBan,
  setAccountProfile,
  createSession,
  getAccountBySession,
  deleteSession,
  deleteSessionsForUser,
  deleteExpiredSessions,
  toggleReaction,
  createStandaloneThread,
  listStandaloneThreads,
  getStandaloneThread,
  getStandaloneThreadMessages,
  insertStandaloneThreadMessage,
  getStandaloneThreadMessage,
  updateStandaloneThreadMessage,
  deleteStandaloneThreadMessage,
  createAttachment,
  getAttachmentById,
  getAppConfig,
  setAppConfig,
  upsertPushSubscription,
  removePushSubscription,
  deletePushSubscriptionByEndpoint,
  deletePushSubscriptionsForUser,
  listPushSubscriptions,
} from './db.js';

const MIN_NODE_VERSION = '22.22.3';
const WS_MAX_PAYLOAD_BYTES = 64 * 1024; // ws 層: 異常フレームだけを close させる上限
const APP_MAX_BODY_BYTES = 8192; // アプリ層: too_large 判定（UTF-8 バイト長）
const MAX_NICKNAME_LENGTH = 32;
const MAX_BODY_LENGTH = 2000;
const MAX_THREAD_TITLE_LENGTH = 80;
const HISTORY_LIMIT = 50;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '🎉', '👀']);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PUSH_API_BYTES = 16 * 1024;
const BAN_DURATIONS = new Map([
  ['10m', 10 * 60 * 1000],
  ['1h', 60 * 60 * 1000],
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
  ['permanent', null],
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
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

function sendUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="chat", charset="UTF-8"',
  });
  res.end('Unauthorized');
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

  const headers = { 'Content-Type': getMimeType(targetReal) };
  if (path.basename(targetReal) === 'sw.js') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
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

function validateThreadTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_THREAD_TITLE_LENGTH || CONTROL_CHAR_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [algorithm, saltText, hashText, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !hashText || extra !== undefined) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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
 * threadRootId / rootId 入力を検証して root 行を解決する。
 * JSON number の正の安全な整数（parseRoomId を流用。文字列数値は拒否）→ メッセージ存在
 * → クライアントの現在ルームに属する → root 自体がスレッド返信でない、をすべて満たせば
 * root 行オブジェクトを返す。どれか欠ければ null（呼び出し側で thread_not_found に変換）。
 */
function resolveThreadRoot(db, roomId, value) {
  const rootId = parseRoomId(value);
  if (rootId === null) return null;
  const root = getMessageById(db, rootId);
  if (!root) return null;
  if (root.room_id !== roomId) return null;
  if (root.thread_root_id !== null) return null;
  return root;
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
 * Authorization header を厳密に検証する。Node の base64 decoder は不正文字を無視するため、
 * 文字種・長さ・再エンコード一致を確認してから credential を比較する。
 */
function checkBasicAuth(header, basicAuth) {
  if (!basicAuth) return true;
  if (typeof header !== 'string') return false;

  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1 || header.slice(0, spaceIndex).toLowerCase() !== 'basic') return false;

  const token = header.slice(spaceIndex + 1).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return false;
  const bytes = Buffer.from(token, 'base64');
  if (bytes.toString('base64') !== token) return false;

  const decoded = bytes.toString('utf8');
  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return false;

  const userOk = safeStringEqual(decoded.slice(0, colonIndex), basicAuth.user);
  const passwordOk = safeStringEqual(decoded.slice(colonIndex + 1), basicAuth.password);
  return userOk && passwordOk;
}

function assertBasicAuthConfig(basicAuth) {
  if (basicAuth === undefined) return;
  if (
    basicAuth === null ||
    typeof basicAuth !== 'object' ||
    typeof basicAuth.user !== 'string' ||
    typeof basicAuth.password !== 'string' ||
    basicAuth.user.length === 0 ||
    basicAuth.password.length === 0
  ) {
    throw new Error('basicAuth には空でない文字列の user と password が必要です');
  }
  if (basicAuth.user.includes(':')) {
    throw new Error('BASIC_AUTH_USER にコロン (:) は使用できません');
  }
}

/**
 * env（デフォルトは process.env）から起動設定を解決する。
 * PORT は 1-65535 の整数を検証し、不正値は明示エラーで throw して fail-fast する。
 * HOST は未設定/空白のみなら undefined（Node の既定 = IPv6 dual-stack 待受を維持）。
 */
export function resolveConfig(env = process.env) {
  const port = parsePort(env.PORT);
  const host = normalizeStr(env.HOST);
  const dbPath = normalizeStr(env.DB_PATH) ?? 'data/chat.db';
  const basicAuthUser = normalizeBasicAuthValue(env.BASIC_AUTH_USER, 'BASIC_AUTH_USER');
  const basicAuthPassword = normalizeBasicAuthValue(env.BASIC_AUTH_PASSWORD, 'BASIC_AUTH_PASSWORD');
  if ((basicAuthUser === undefined) !== (basicAuthPassword === undefined)) {
    throw new Error(
      'BASIC_AUTH_USER と BASIC_AUTH_PASSWORD は両方設定するか両方未設定にしてください（片方のみは不可）',
    );
  }
  if (basicAuthUser?.includes(':')) {
    throw new Error('BASIC_AUTH_USER にコロン (:) は使用できません');
  }
  const basicAuth =
    basicAuthUser === undefined ? undefined : { user: basicAuthUser, password: basicAuthPassword };
  const vapidSubject = normalizeStr(env.VAPID_SUBJECT) ?? 'mailto:chat-app@localhost';
  if (!/^(mailto:|https:\/\/)/.test(vapidSubject)) {
    throw new Error('VAPID_SUBJECT は mailto: または https:// で始めてください');
  }
  return { port, host, dbPath, basicAuth, vapidSubject };
}

// undefined/空/空白のみ → undefined。それ以外は trim した文字列。
function normalizeStr(raw) {
  if (raw === undefined) return undefined;
  const t = String(raw).trim();
  return t === '' ? undefined : t;
}

function normalizeBasicAuthValue(raw, name) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${name} は文字列で指定してください`);
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

// 未設定/空/空白のみ → 3000。設定ありは 1-65535 の整数のみ受理。それ以外は throw（fail-fast）。
// env ファイル由来の前後空白は許容（trim）。小数・符号・非数字は拒否。
function parsePort(raw) {
  if (raw === undefined) return 3000;
  const trimmed = String(raw).trim();
  if (trimmed === '') return 3000;
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`PORT が不正です（1-65535 の整数を指定してください）: ${raw}`);
  }
  const n = Number(trimmed);
  if (n < 1 || n > 65535) {
    throw new Error(`PORT が範囲外です（1-65535）: ${raw}`);
  }
  return n;
}

/**
 * createChatServer({ dbPath, staticDir, basicAuth }) → { server, wss, db, close }
 * トップレベルでは listen しない。
 */
export function createChatServer({
  dbPath,
  staticDir,
  basicAuth,
  vapidSubject = 'mailto:chat-app@localhost',
  pushTransport = webpush,
}) {
  assertBasicAuthConfig(basicAuth);
  const root = path.resolve(staticDir);
  const rootReal = fs.realpathSync(root);

  const db = openDb(dbPath);
  let vapidPublicKey = getAppConfig(db, 'vapid_public_key');
  let vapidPrivateKey = getAppConfig(db, 'vapid_private_key');
  if (!vapidPublicKey || !vapidPrivateKey) {
    const generated = pushTransport.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    setAppConfig(db, 'vapid_public_key', vapidPublicKey);
    setAppConfig(db, 'vapid_private_key', vapidPrivateKey);
  }
  pushTransport.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const pendingPushes = new Set();
  const defaultRoomId = getDefaultRoomId(db);
  const uploadsDir = path.resolve(path.dirname(dbPath), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  /**
   * DB のルーム一覧を WS プロトコルの形（{id, name}）に整形する。
   * created_at はクライアントに露出させない。
   */
  function roomsPayload() {
    return listRooms(db).map((room) => ({ id: room.id, name: room.name }));
  }

  const server = http.createServer((req, res) => {
    if (!checkBasicAuth(req.headers.authorization, basicAuth)) {
      sendUnauthorized(res);
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendStatus(res, 400, 'Bad Request');
      return;
    }
    if (pathname === '/api/uploads') {
      handleUpload(req, res);
      return;
    }
    if (pathname === '/api/push/public-key' || pathname === '/api/push/subscription') {
      void handlePushApi(req, res, pathname);
      return;
    }
    if (pathname.startsWith('/uploads/')) {
      serveUpload(req, res, pathname.slice('/uploads/'.length));
      return;
    }
    serveStatic(req, res, root, rootReal);
  });

  function sendApiError(res, status, error) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error }));
  }

  function sendApiJson(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  function accountFromRequest(req) {
    const headerToken = req.headers['x-session-token'];
    const bearer = req.headers.authorization;
    const token = typeof headerToken === 'string'
      ? headerToken
      : (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
    if (!token) return undefined;
    return getAccountBySession(db, hashSessionToken(token));
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_PUSH_API_BYTES) {
          fail(new Error('too_large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => fail(new Error('bad_json')));
      req.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('bad_json'));
        }
      });
    });
  }

  function normalizePushSubscription(value) {
    if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string') return undefined;
    let endpoint;
    try {
      const url = new URL(value.endpoint);
      if (url.protocol !== 'https:') return undefined;
      endpoint = url.toString();
    } catch {
      return undefined;
    }
    const p256dh = value.keys?.p256dh;
    const auth = value.keys?.auth;
    if (
      endpoint.length > 2048 ||
      typeof p256dh !== 'string' ||
      typeof auth !== 'string' ||
      !/^[A-Za-z0-9_-]{16,512}$/.test(p256dh) ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(auth)
    ) {
      return undefined;
    }
    return { endpoint, keys: { p256dh, auth } };
  }

  async function handlePushApi(req, res, pathname) {
    const user = accountFromRequest(req);
    if (!user) {
      sendApiError(res, 401, 'not_authenticated');
      return;
    }
    if (pathname === '/api/push/public-key') {
      if (req.method !== 'GET') {
        sendApiError(res, 405, 'method_not_allowed');
        return;
      }
      sendApiJson(res, 200, { publicKey: vapidPublicKey });
      return;
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      sendApiError(res, 405, 'method_not_allowed');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendApiError(res, error.message === 'too_large' ? 413 : 400, error.message);
      return;
    }
    if (req.method === 'POST') {
      const subscription = normalizePushSubscription(body);
      if (!subscription) {
        sendApiError(res, 400, 'bad_subscription');
        return;
      }
      upsertPushSubscription(db, user.id, subscription);
      sendApiJson(res, 201, { subscribed: true });
      return;
    }
    if (!body || typeof body.endpoint !== 'string' || body.endpoint.length > 2048) {
      sendApiError(res, 400, 'bad_subscription');
      return;
    }
    removePushSubscription(db, user.id, body.endpoint);
    sendApiJson(res, 200, { subscribed: false });
  }

  function handleUpload(req, res) {
    if (req.method !== 'POST') {
      sendApiError(res, 405, 'method_not_allowed');
      return;
    }
    const user = accountFromRequest(req);
    if (!user) {
      sendApiError(res, 401, 'not_authenticated');
      return;
    }
    const declaredSize = Number(req.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
      sendApiError(res, 413, 'file_too_large');
      return;
    }
    let originalName;
    try {
      originalName = decodeURIComponent(String(req.headers['x-file-name'] || '')).trim();
    } catch {
      originalName = '';
    }
    originalName = originalName.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 255);
    if (!originalName) {
      sendApiError(res, 400, 'bad_file_name');
      return;
    }
    const mimeType = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120);
    const id = crypto.randomBytes(18).toString('base64url');
    const storedName = `${id}.bin`;
    const temporaryPath = path.join(uploadsDir, `${storedName}.part`);
    const finalPath = path.join(uploadsDir, storedName);
    const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
    let size = 0;
    let settled = false;

    const fail = (status, error) => {
      if (settled) return;
      settled = true;
      req.unpipe(output);
      output.destroy();
      fs.rm(temporaryPath, { force: true }, () => {});
      if (!res.headersSent) sendApiError(res, status, error);
      req.resume();
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) fail(413, 'file_too_large');
    });
    req.on('aborted', () => fail(400, 'upload_aborted'));
    req.on('error', () => fail(400, 'upload_failed'));
    output.on('error', () => fail(500, 'upload_failed'));
    output.on('finish', () => {
      if (settled) return;
      if (size === 0) {
        fail(400, 'empty_file');
        return;
      }
      try {
        fs.renameSync(temporaryPath, finalPath);
        const attachment = createAttachment(db, {
          id,
          uploaderUserId: user.id,
          originalName,
          storedName,
          mimeType,
          size,
        });
        settled = true;
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ attachment }));
      } catch {
        fs.rmSync(finalPath, { force: true });
        fail(500, 'upload_failed');
      }
    });
    req.pipe(output);
  }

  function serveUpload(req, res, id) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendStatus(res, 405, 'Method Not Allowed');
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      sendStatus(res, 404, 'Not Found');
      return;
    }
    const attachment = getAttachmentById(db, id, true);
    if (!attachment) {
      sendStatus(res, 404, 'Not Found');
      return;
    }
    const filePath = path.join(uploadsDir, attachment.stored_name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      sendStatus(res, 404, 'Not Found');
      return;
    }
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': attachment.mime_type,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'Cache-Control': 'private, max-age=86400',
    };
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(filePath).pipe(res);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);

    if (!checkBasicAuth(req.headers.authorization, basicAuth)) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\n' +
          'WWW-Authenticate: Basic realm="chat", charset="UTF-8"\r\n' +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n' +
          '\r\n',
      );
      return;
    }

    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  function sendJson(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function sendError(ws, reason, details = {}) {
    sendJson(ws, { type: 'error', reason, ...details });
  }

  function broadcastMessage(row) {
    const payload = JSON.stringify({ type: 'message', message: row });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.roomId === row.room_id) {
        client.send(payload);
      }
    }
  }

  function queuePushNotification({ excludeUserId, title, body, tag, url }) {
    const task = (async () => {
      const payload = JSON.stringify({
        title,
        body: String(body || '新しいメッセージ').slice(0, 180),
        tag,
        url,
      });
      const subscriptions = listPushSubscriptions(db, excludeUserId);
      await Promise.allSettled(
        subscriptions.map(async (subscription) => {
          try {
            await pushTransport.sendNotification(subscription, payload, {
              TTL: 60 * 60,
              urgency: 'normal',
            });
          } catch (error) {
            if (error?.statusCode === 404 || error?.statusCode === 410) {
              deletePushSubscriptionByEndpoint(db, subscription.endpoint);
              return;
            }
            // Endpointや鍵をログへ出さず、配送失敗の種別だけを残す。
            // eslint-disable-next-line no-console
            console.warn(`chat-app: push delivery failed (${error?.statusCode || 'unknown'})`);
          }
        }),
      );
    })();
    pendingPushes.add(task);
    void task
      .finally(() => pendingPushes.delete(task))
      .catch(() => {});
  }

  function pushBody(body, attachment) {
    const text = String(body || '').trim();
    if (text) return text;
    return attachment ? `📎 ${attachment.name}` : '新しいメッセージ';
  }

  function broadcastRooms() {
    const payload = JSON.stringify({ type: 'rooms', rooms: roomsPayload() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function threadsPayload(roomId) {
    return listStandaloneThreads(db, roomId);
  }

  function broadcastUsers() {
    const users = listAccounts(db);
    for (const client of wss.clients) {
      if (client.user) {
        const current = users.find((user) => user.id === client.user.id);
        if (current) {
          client.user = current;
          client.nickname = current.username;
        }
      }
      sendJson(client, { type: 'users', users });
    }
  }

  function broadcastUserSnapshot(exceptClient) {
    const payload = { type: 'users_snapshot', users: listAccounts(db) };
    for (const client of wss.clients) {
      if (client.user && client !== exceptClient) sendJson(client, payload);
    }
  }

  function broadcastThreads(roomId) {
    const payload = { type: 'threads', roomId, threads: threadsPayload(roomId) };
    for (const client of wss.clients) {
      if (client.roomId === roomId) sendJson(client, payload);
    }
  }

  function broadcastToRoom(roomId, payload) {
    for (const client of wss.clients) {
      if (client.roomId === roomId) sendJson(client, payload);
    }
  }

  function issueSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    createSession(db, hashSessionToken(token), user.id, Date.now() + SESSION_LIFETIME_MS);
    return token;
  }

  function authenticateSocket(ws, user) {
    ws.user = user;
    ws.nickname = user.username;
    ws.roomId = defaultRoomId;
  }

  function canManageRooms(ws) {
    return ws.user?.role === 'owner' || ws.user?.role === 'admin';
  }

  function canModerateUser(actor, target) {
    if (!actor || !target || actor.id === target.id || target.role === 'owner') return false;
    if (actor.role === 'owner') return true;
    return actor.role === 'admin' && target.role === 'member';
  }

  function isAccountBanned(user, now = Date.now()) {
    return user?.banned_until === -1 || Number(user?.banned_until) > now;
  }

  function canModifyMessage(ws, message) {
    return Boolean(
      ws.user && (message.author_user_id === ws.user.id || canManageRooms(ws)),
    );
  }

  deleteExpiredSessions(db);

  wss.on('connection', (ws) => {
    ws.nickname = null;
    ws.user = null;
    ws.sessionTokenHash = null;
    ws.roomId = null;

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

      if (parsed.type === 'register') {
        const username = validateNickname(parsed.username);
        if (!username) {
          sendError(ws, 'bad_username');
          return;
        }
        if (!validatePassword(parsed.password)) {
          sendError(ws, 'bad_password');
          return;
        }
        try {
          const user = createAccount(db, username, hashPassword(parsed.password));
          const token = issueSession(user);
          authenticateSocket(ws, user);
          ws.sessionTokenHash = hashSessionToken(token);
          sendJson(ws, { type: 'auth_ok', user, sessionToken: token });
          broadcastUserSnapshot(ws);
        } catch (err) {
          if (err.code === 'ACCOUNT_EXISTS') {
            sendError(ws, 'account_exists');
            return;
          }
          throw err;
        }
        return;
      }

      if (parsed.type === 'login') {
        const username = validateNickname(parsed.username);
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        const user = username ? getAccountByUsername(db, username) : undefined;
        if (!user || !verifyPassword(password, user.password_hash)) {
          sendError(ws, 'bad_credentials');
          return;
        }
        if (isAccountBanned(user)) {
          sendError(ws, 'account_banned', { bannedUntil: user.banned_until });
          return;
        }
        delete user.password_hash;
        const token = issueSession(user);
        authenticateSocket(ws, user);
        ws.sessionTokenHash = hashSessionToken(token);
        sendJson(ws, { type: 'auth_ok', user, sessionToken: token });
        return;
      }

      if (parsed.type === 'resume_session') {
        if (typeof parsed.token !== 'string' || !parsed.token) {
          sendError(ws, 'invalid_session');
          return;
        }
        const tokenHash = hashSessionToken(parsed.token);
        const user = getAccountBySession(db, tokenHash);
        if (!user) {
          sendError(ws, 'invalid_session');
          return;
        }
        authenticateSocket(ws, user);
        ws.sessionTokenHash = tokenHash;
        sendJson(ws, { type: 'auth_ok', user });
        return;
      }

      if (parsed.type === 'logout') {
        if (ws.sessionTokenHash) deleteSession(db, ws.sessionTokenHash);
        ws.user = null;
        ws.nickname = null;
        ws.roomId = null;
        ws.sessionTokenHash = null;
        sendJson(ws, { type: 'logged_out' });
        return;
      }

      // 旧クライアントと保存済みニックネームの互換用。新UIはアカウント認証のみを使う。
      if (parsed.type === 'join') {
        const nickname = validateNickname(parsed.nickname);
        if (!nickname) {
          sendError(ws, 'bad_nickname');
          return;
        }
        const account = getAccountByUsername(db, nickname);
        if (isAccountBanned(account)) {
          sendError(ws, 'account_banned', { bannedUntil: account.banned_until });
          return;
        }
        ws.nickname = nickname;
        ws.roomId = defaultRoomId;
        upsertUser(db, nickname);
        sendJson(ws, {
          type: 'history',
          roomId: ws.roomId,
          messages: getRecentMessages(db, ws.roomId, HISTORY_LIMIT),
        });
        sendJson(ws, { type: 'rooms', rooms: roomsPayload() });
        return;
      }

      if (parsed.type === 'get_state') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        sendJson(ws, {
          type: 'state',
          roomId: ws.roomId,
          rooms: roomsPayload(),
          messages: getRecentMessages(db, ws.roomId, HISTORY_LIMIT),
          threads: threadsPayload(ws.roomId),
          users: listAccounts(db),
        });
        return;
      }

      if (parsed.type === 'message') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const body = sanitizeBody(parsed.body) || '';
        let attachmentId = null;
        if (parsed.attachmentId !== undefined && parsed.attachmentId !== null) {
          if (!ws.user || typeof parsed.attachmentId !== 'string') {
            sendError(ws, 'bad_attachment');
            return;
          }
          const attachment = getAttachmentById(db, parsed.attachmentId, true);
          if (!attachment || attachment.uploader_user_id !== ws.user.id) {
            sendError(ws, 'bad_attachment');
            return;
          }
          attachmentId = attachment.id;
        }
        if (!body && !attachmentId) return;
        let threadRootId = null;
        if (parsed.threadRootId !== undefined && parsed.threadRootId !== null) {
          const root = resolveThreadRoot(db, ws.roomId, parsed.threadRootId);
          if (!root) {
            sendError(ws, 'thread_not_found');
            return;
          }
          threadRootId = root.id;
        }
        const row = insertMessage(
          db,
          ws.roomId,
          ws.nickname,
          body,
          threadRootId,
          ws.user?.id ?? null,
          attachmentId,
        );
        broadcastMessage(row);
        const room = getRoomById(db, ws.roomId);
        queuePushNotification({
          excludeUserId: ws.user?.id ?? null,
          title: `#${room?.name || 'チャット'} · ${ws.user?.display_name || ws.nickname}`,
          body: pushBody(row.body, row.attachment),
          tag: `message-${row.id}`,
          url: `/?room=${ws.roomId}`,
        });
        return;
      }

      if (parsed.type === 'edit_message' || parsed.type === 'delete_message') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const messageId = parseRoomId(parsed.messageId);
        const message = messageId ? getMessageById(db, messageId) : undefined;
        if (!message || message.room_id !== ws.roomId || message.thread_root_id !== null) {
          sendError(ws, 'message_not_found');
          return;
        }
        if (!canModifyMessage(ws, message)) {
          sendError(ws, 'forbidden');
          return;
        }
        if (parsed.type === 'edit_message') {
          const body = sanitizeBody(parsed.body) || '';
          if (!body && !message.attachment_id) {
            sendError(ws, 'empty_message');
            return;
          }
          const editedAt = updateMessage(db, message.id, ws.roomId, body);
          broadcastToRoom(ws.roomId, {
            type: 'message_updated',
            messageId: message.id,
            body,
            editedAt,
          });
        } else {
          deleteMessage(db, message.id, ws.roomId);
          broadcastToRoom(ws.roomId, { type: 'message_deleted', messageId: message.id });
        }
        return;
      }

      if (parsed.type === 'admin_auth') {
        sendError(ws, 'admin_disabled');
        return;
      }

      if (parsed.type === 'set_role') {
        if (ws.user?.role !== 'owner') {
          sendError(ws, 'forbidden');
          return;
        }
        const userId = parseRoomId(parsed.userId);
        if (!userId || !['admin', 'member'].includes(parsed.role)) {
          sendError(ws, 'bad_role');
          return;
        }
        if (!setAccountRole(db, userId, parsed.role)) {
          sendError(ws, 'user_not_found');
          return;
        }
        broadcastUsers();
        return;
      }

      if (parsed.type === 'ban_user' || parsed.type === 'unban_user') {
        if (!canManageRooms(ws)) {
          sendError(ws, 'forbidden');
          return;
        }
        const userId = parseRoomId(parsed.userId);
        const target = userId ? getAccountById(db, userId) : undefined;
        if (!target) {
          sendError(ws, 'user_not_found');
          return;
        }
        if (!canModerateUser(ws.user, target)) {
          sendError(ws, 'forbidden');
          return;
        }

        if (parsed.type === 'unban_user') {
          clearAccountBan(db, target.id);
          broadcastUsers();
          return;
        }

        if (!BAN_DURATIONS.has(parsed.duration)) {
          sendError(ws, 'bad_ban_duration');
          return;
        }
        const durationMs = BAN_DURATIONS.get(parsed.duration);
        const bannedUntil = durationMs === null ? -1 : Date.now() + durationMs;
        setAccountBan(db, target.id, bannedUntil, ws.user.id);
        deleteSessionsForUser(db, target.id);
        deletePushSubscriptionsForUser(db, target.id);

        for (const client of wss.clients) {
          if (client.user?.id !== target.id) continue;
          sendError(client, 'account_banned', { bannedUntil });
          client.user = null;
          client.nickname = null;
          client.roomId = null;
          client.sessionTokenHash = null;
          client.close(4003, 'account banned');
        }
        broadcastUsers();
        return;
      }

      if (parsed.type === 'update_profile') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        if (typeof parsed.displayName !== 'string' || typeof parsed.bio !== 'string') {
          sendError(ws, 'bad_profile');
          return;
        }
        const displayName = parsed.displayName.trim();
        const bio = parsed.bio.trim();
        if (
          displayName.length > 32 ||
          bio.length > 160 ||
          CONTROL_CHAR_RE.test(displayName) ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bio)
        ) {
          sendError(ws, 'bad_profile');
          return;
        }
        let avatarId = null;
        if (parsed.avatarId !== null && parsed.avatarId !== undefined) {
          if (typeof parsed.avatarId !== 'string') {
            sendError(ws, 'bad_avatar');
            return;
          }
          const avatar = getAttachmentById(db, parsed.avatarId, true);
          if (
            !avatar ||
            avatar.uploader_user_id !== ws.user.id ||
            !avatar.mime_type.startsWith('image/')
          ) {
            sendError(ws, 'bad_avatar');
            return;
          }
          avatarId = avatar.id;
        }
        const user = setAccountProfile(db, ws.user.id, displayName || null, bio, avatarId);
        ws.user = user;
        sendJson(ws, { type: 'profile_updated', user });
        broadcastUsers();
        return;
      }

      if (parsed.type === 'create_room') {
        if (!canManageRooms(ws)) {
          sendError(ws, 'forbidden');
          return;
        }
        const name = validateRoomName(parsed.name);
        if (!name) {
          sendError(ws, 'bad_room_name');
          return;
        }
        try {
          createRoom(db, name);
        } catch (err) {
          const isUniqueViolation =
            err.errcode === 2067 ||
            (typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed'));
          if (!isUniqueViolation) throw err;
          sendError(ws, 'room_exists');
          return;
        }
        broadcastRooms();
        return;
      }

      if (parsed.type === 'delete_room') {
        if (!canManageRooms(ws)) {
          sendError(ws, 'forbidden');
          return;
        }
        const targetRoomId = parseRoomId(parsed.roomId);
        if (!targetRoomId || !getRoomById(db, targetRoomId)) {
          sendError(ws, 'room_not_found');
          return;
        }
        if (targetRoomId === defaultRoomId) {
          sendError(ws, 'cannot_delete_default');
          return;
        }
        deleteRoom(db, targetRoomId);
        const defaultMessages = getRecentMessages(db, defaultRoomId, HISTORY_LIMIT);
        for (const client of wss.clients) {
          if (client.roomId === targetRoomId) {
            client.roomId = defaultRoomId;
            sendJson(client, {
              type: 'room_switched',
              roomId: defaultRoomId,
              messages: defaultMessages,
              threads: threadsPayload(defaultRoomId),
            });
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
        if (!targetRoomId || !getRoomById(db, targetRoomId)) {
          sendError(ws, 'room_not_found');
          return;
        }
        ws.roomId = targetRoomId;
        sendJson(ws, {
          type: 'room_switched',
          roomId: targetRoomId,
          messages: getRecentMessages(db, targetRoomId, HISTORY_LIMIT),
          threads: threadsPayload(targetRoomId),
        });
        return;
      }

      if (parsed.type === 'toggle_reaction') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const messageId = parseRoomId(parsed.messageId);
        if (!messageId || !ALLOWED_REACTIONS.has(parsed.emoji)) {
          sendError(ws, 'bad_reaction');
          return;
        }
        const reactions = toggleReaction(db, messageId, ws.roomId, ws.user.id, parsed.emoji);
        if (!reactions) {
          sendError(ws, 'message_not_found');
          return;
        }
        broadcastToRoom(ws.roomId, { type: 'reaction_update', messageId, reactions });
        return;
      }

      if (parsed.type === 'create_thread') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const title = validateThreadTitle(parsed.title);
        const body = parsed.body ? sanitizeBody(parsed.body) : null;
        if (!title) {
          sendError(ws, 'bad_thread_title');
          return;
        }
        const thread = createStandaloneThread(db, ws.roomId, ws.user, title, body);
        sendJson(ws, { type: 'thread_created', thread });
        broadcastThreads(ws.roomId);
        queuePushNotification({
          excludeUserId: ws.user.id,
          title: `新しいスレッド · ${ws.user.display_name || ws.user.username}`,
          body: body || title,
          tag: `thread-${thread.id}`,
          url: `/?room=${ws.roomId}&thread=${thread.id}`,
        });
        return;
      }

      if (parsed.type === 'open_standalone_thread') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const threadId = parseRoomId(parsed.threadId);
        const thread = threadId ? getStandaloneThread(db, threadId, ws.roomId) : undefined;
        if (!thread) {
          sendError(ws, 'thread_not_found');
          return;
        }
        sendJson(ws, {
          type: 'thread_history',
          thread,
          messages: getStandaloneThreadMessages(db, thread.id),
        });
        return;
      }

      if (parsed.type === 'thread_message') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const threadId = parseRoomId(parsed.threadId);
        const thread = threadId ? getStandaloneThread(db, threadId, ws.roomId) : undefined;
        const body = sanitizeBody(parsed.body);
        if (!thread) {
          sendError(ws, 'thread_not_found');
          return;
        }
        if (!body) return;
        const message = insertStandaloneThreadMessage(db, thread.id, ws.user, body);
        broadcastToRoom(ws.roomId, { type: 'thread_message', threadId: thread.id, message });
        broadcastThreads(ws.roomId);
        queuePushNotification({
          excludeUserId: ws.user.id,
          title: `${thread.title} · ${ws.user.display_name || ws.user.username}`,
          body,
          tag: `thread-message-${message.id}`,
          url: `/?room=${ws.roomId}&thread=${thread.id}`,
        });
        return;
      }

      if (
        parsed.type === 'edit_thread_message' ||
        parsed.type === 'delete_thread_message'
      ) {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const threadId = parseRoomId(parsed.threadId);
        const messageId = parseRoomId(parsed.messageId);
        const thread = threadId ? getStandaloneThread(db, threadId, ws.roomId) : undefined;
        if (!thread) {
          sendError(ws, 'thread_not_found');
          return;
        }
        const message = messageId
          ? getStandaloneThreadMessage(db, messageId, thread.id)
          : undefined;
        if (!message) {
          sendError(ws, 'message_not_found');
          return;
        }
        if (!canModifyMessage(ws, message)) {
          sendError(ws, 'forbidden');
          return;
        }
        if (parsed.type === 'edit_thread_message') {
          const body = sanitizeBody(parsed.body);
          if (!body) {
            sendError(ws, 'empty_message');
            return;
          }
          const editedAt = updateStandaloneThreadMessage(db, message.id, thread.id, body);
          broadcastToRoom(ws.roomId, {
            type: 'thread_message_updated',
            threadId: thread.id,
            messageId: message.id,
            body,
            editedAt,
          });
        } else {
          deleteStandaloneThreadMessage(db, message.id, thread.id);
          broadcastToRoom(ws.roomId, {
            type: 'thread_message_deleted',
            threadId: thread.id,
            messageId: message.id,
          });
          broadcastThreads(ws.roomId);
        }
        return;
      }

      // 旧クライアント用のメッセージ起点スレッド読み取り互換。
      if (parsed.type === 'open_thread') {
        if (!ws.nickname) {
          sendError(ws, 'not_joined');
          return;
        }
        const root = resolveThreadRoot(db, ws.roomId, parsed.rootId);
        if (!root) {
          sendError(ws, 'thread_not_found');
          return;
        }
        sendJson(ws, {
          type: 'thread_history',
          rootId: root.id,
          root,
          messages: getThreadMessages(db, root.id, ws.roomId, HISTORY_LIMIT),
        });
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
        void Promise.allSettled([...pendingPushes]).then(() => {
          db.close();
          if (callback) callback();
        });
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
  const { port, host, dbPath, basicAuth, vapidSubject } = resolveConfig();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const app = createChatServer({ dbPath, staticDir, basicAuth, vapidSubject });
  if (host) {
    app.server.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(`chat-app: listening on http://${host}:${port}`);
    });
  } else {
    app.server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`chat-app: listening on port ${port} (all interfaces)`);
    });
  }
}
