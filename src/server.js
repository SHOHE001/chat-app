// HTTP 静的配信 + WebSocket（同一ポート相乗り）のサーバー本体。
//
// createChatServer({ dbPath, staticDir }) は factory を export するのみで、
// トップレベルでは listen しない。CLI で直接実行されたときだけ末尾で listen する。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import QRCode from 'qrcode';
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
  createMessageReport,
  listMessageReports,
  createAccount,
  getAccountByUsername,
  getAccountById,
  hasRegisteredAccounts,
  listAccounts,
  setAccountRole,
  setAccountBan,
  clearAccountBan,
  clearPostingBlock,
  hideMessageAsModerator,
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
  listNotificationEnabledRoomIds,
  setRoomNotificationEnabled,
  latestModerationEventId,
  listModerationEventsAfter,
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
const REGISTRATION_INVITE_LIFETIME_MS = 5 * 60 * 1000;
const REGISTRATION_INVITE_HASH_KEY = 'registration_invite_hash';
const REGISTRATION_INVITE_EXPIRY_KEY = 'registration_invite_expires_at';
const BAN_DURATIONS = new Map([
  ['10m', 10 * 60 * 1000],
  ['1h', 60 * 60 * 1000],
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
  ['permanent', null],
]);
const REPORT_CATEGORIES = new Set([
  'harassment',
  'personal_info',
  'scary_media',
  'spam',
  'other',
]);
const ASSIGNABLE_ROLES = new Set(['admin', 'member', 'adult', 'child', 'staff']);
const GENERAL_ROLES = new Set(['member', 'adult', 'child', 'staff']);

const SAFE_RASTER_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const SAFE_INLINE_MIME_TYPES = new Set([
  ...SAFE_RASTER_MIME_TYPES,
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});
const DEFAULT_RATE_LIMITS = Object.freeze({
  appLogin: { windowMs: 15 * 60 * 1000, maxFailures: 5, blockMs: 15 * 60 * 1000 },
  basicAuth: { windowMs: 10 * 60 * 1000, maxFailures: 10, blockMs: 15 * 60 * 1000 },
  global: { windowMs: 60 * 1000, maxFailures: 300, blockMs: 60 * 1000 },
  maxEntries: 10_000,
});
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

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
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

function sendRateLimited(res, retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.writeHead(429, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Retry-After': String(retryAfterSeconds),
  });
  res.end('Too Many Requests');
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requestClientKey(req) {
  const remoteAddress = req.socket?.remoteAddress || 'unknown';
  if (!isLoopbackAddress(remoteAddress)) return remoteAddress;
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  if (typeof raw !== 'string') return remoteAddress;
  const candidate = raw.split(',').at(-1)?.trim();
  return candidate && net.isIP(candidate) ? candidate : remoteAddress;
}

function createFailureLimiter({ windowMs, maxFailures, blockMs, maxEntries, now }) {
  const entries = new Map();

  function prune(currentTime) {
    for (const [key, entry] of entries) {
      if (entry.blockedUntil <= currentTime && entry.windowStartedAt + windowMs <= currentTime) {
        entries.delete(key);
      }
    }
  }

  function retryAfterMs(key) {
    const currentTime = now();
    const entry = entries.get(key);
    if (!entry || entry.blockedUntil <= currentTime) return 0;
    return entry.blockedUntil - currentTime;
  }

  function recordFailure(key) {
    const currentTime = now();
    prune(currentTime);
    let entry = entries.get(key);
    if (!entry || entry.windowStartedAt + windowMs <= currentTime) {
      entry = { failures: 0, windowStartedAt: currentTime, blockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= maxFailures) entry.blockedUntil = currentTime + blockMs;
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return Math.max(0, entry.blockedUntil - currentTime);
  }

  function clear(key) {
    entries.delete(key);
  }

  return { retryAfterMs, recordFailure, clear };
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
  if (!root || root.hidden_at) return null;
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
  qrEncoder = QRCode,
  allowLegacyJoin = false,
  now = Date.now,
  rateLimits = DEFAULT_RATE_LIMITS,
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
  const maxRateLimitEntries = rateLimits.maxEntries ?? DEFAULT_RATE_LIMITS.maxEntries;
  const appLoginLimiter = createFailureLimiter({
    ...DEFAULT_RATE_LIMITS.appLogin,
    ...rateLimits.appLogin,
    maxEntries: maxRateLimitEntries,
    now,
  });
  const basicAuthLimiter = createFailureLimiter({
    ...DEFAULT_RATE_LIMITS.basicAuth,
    ...rateLimits.basicAuth,
    maxEntries: maxRateLimitEntries,
    now,
  });
  const globalAuthLimiter = createFailureLimiter({
    ...DEFAULT_RATE_LIMITS.global,
    ...rateLimits.global,
    maxEntries: 1,
    now,
  });

  /**
   * DB のルーム一覧を利用者ごとに絞り、WSプロトコルの形へ整形する。
   * created_at はクライアントに露出させない。
   */
  function canAccessRoom(user, room) {
    if (!room) return false;
    if (!room.allowed_roles?.length) return true;
    if (user && ['owner', 'admin'].includes(user.role)) return true;
    return Boolean(user && room.allowed_roles.includes(user.role));
  }

  function roomsPayload(user) {
    const notificationEnabledRoomIds = new Set(
      user ? listNotificationEnabledRoomIds(db, user.id) : [],
    );
    return listRooms(db)
      .filter((room) => canAccessRoom(user, room))
      .map((room) => ({
        id: room.id,
        name: room.name,
        allowedRoles: room.allowed_roles,
        notificationsEnabled: notificationEnabledRoomIds.has(room.id),
      }));
  }

  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);
    const clientKey = requestClientKey(req);
    const basicAuthOk = checkBasicAuth(req.headers.authorization, basicAuth);
    if (basicAuth && !basicAuthOk) {
      const existingRetry = Math.max(
        globalAuthLimiter.retryAfterMs('global'),
        basicAuthLimiter.retryAfterMs(clientKey),
      );
      const retryAfterMs = existingRetry || Math.max(
        globalAuthLimiter.recordFailure('global'),
        basicAuthLimiter.recordFailure(clientKey),
      );
      if (retryAfterMs) sendRateLimited(res, retryAfterMs);
      else sendUnauthorized(res);
      return;
    }
    if (basicAuth) {
      basicAuthLimiter.clear(clientKey);
      globalAuthLimiter.clear('global');
    }
    let requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://localhost');
    } catch {
      sendStatus(res, 400, 'Bad Request');
      return;
    }
    const { pathname } = requestUrl;
    if (pathname === '/api/uploads') {
      handleUpload(req, res);
      return;
    }
    if (pathname === '/api/push/public-key' || pathname === '/api/push/subscription') {
      void handlePushApi(req, res, pathname);
      return;
    }
    if (pathname === '/api/registration-qr') {
      void handleRegistrationQr(req, res, requestUrl);
      return;
    }
    if (pathname === '/api/registration-policy') {
      if (req.method !== 'GET') {
        sendApiError(res, 405, 'method_not_allowed');
        return;
      }
      sendApiJson(res, 200, { inviteRequired: hasRegisteredAccounts(db) });
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

  async function handleRegistrationQr(req, res, requestUrl) {
    if (req.method !== 'POST') {
      sendApiError(res, 405, 'method_not_allowed');
      return;
    }
    const user = accountFromRequest(req);
    if (!user) {
      sendApiError(res, 401, 'not_authenticated');
      return;
    }
    if (!['owner', 'admin'].includes(user.role)) {
      sendApiError(res, 403, 'forbidden');
      return;
    }

    const originValue = requestUrl.searchParams.get('origin');
    let origin;
    try {
      origin = new URL(originValue);
    } catch {
      sendApiError(res, 400, 'bad_origin');
      return;
    }
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.origin !== originValue ||
      origin.host !== req.headers.host
    ) {
      sendApiError(res, 400, 'bad_origin');
      return;
    }

    const invite = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + REGISTRATION_INVITE_LIFETIME_MS;
    const registrationUrl = new URL('/', origin);
    registrationUrl.searchParams.set('register', '1');
    registrationUrl.searchParams.set('invite', invite);
    registrationUrl.searchParams.set('expires', String(expiresAt));
    try {
      const image = await qrEncoder.toDataURL(registrationUrl.toString(), {
        type: 'image/png',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 512,
        color: { dark: '#111214', light: '#ffffff' },
      });
      setAppConfig(db, REGISTRATION_INVITE_HASH_KEY, hashSessionToken(invite));
      setAppConfig(db, REGISTRATION_INVITE_EXPIRY_KEY, String(expiresAt));
      sendApiJson(res, 200, { registrationUrl: registrationUrl.toString(), image, expiresAt });
    } catch {
      sendApiError(res, 500, 'qr_generation_failed');
    }
  }

  function registrationInviteError(invite, now = Date.now()) {
    if (!hasRegisteredAccounts(db)) return null;
    if (typeof invite !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invite)) {
      return 'invite_required';
    }
    const expectedHash = getAppConfig(db, REGISTRATION_INVITE_HASH_KEY);
    const expiresAt = Number(getAppConfig(db, REGISTRATION_INVITE_EXPIRY_KEY));
    if (!expectedHash || !Number.isFinite(expiresAt)) return 'invite_invalid';
    if (expiresAt <= now) return 'invite_expired';
    return safeStringEqual(hashSessionToken(invite), expectedHash) ? null : 'invite_invalid';
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
    const mimeType = String(req.headers['content-type'] || 'application/octet-stream')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
      .slice(0, 120) || 'application/octet-stream';
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
        sendApiJson(res, 201, { attachment });
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
    const inline = SAFE_INLINE_MIME_TYPES.has(attachment.mime_type);
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': inline ? attachment.mime_type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
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
  let moderationEventCursor = latestModerationEventId(db);

  server.on('upgrade', (req, socket, head) => {
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);

    const clientKey = requestClientKey(req);
    const basicAuthOk = checkBasicAuth(req.headers.authorization, basicAuth);
    if (basicAuth && !basicAuthOk) {
      const existingRetry = Math.max(
        globalAuthLimiter.retryAfterMs('global'),
        basicAuthLimiter.retryAfterMs(clientKey),
      );
      const retryAfterMs = existingRetry || Math.max(
        globalAuthLimiter.recordFailure('global'),
        basicAuthLimiter.recordFailure(clientKey),
      );
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      socket.end(
        `HTTP/1.1 ${retryAfterMs ? '429 Too Many Requests' : '401 Unauthorized'}\r\n` +
          (retryAfterMs ? `Retry-After: ${retryAfterSeconds}\r\n` : 'WWW-Authenticate: Basic realm="chat", charset="UTF-8"\r\n') +
          `Content-Security-Policy: ${SECURITY_HEADERS['Content-Security-Policy']}\r\n` +
          'X-Content-Type-Options: nosniff\r\n' +
          'Referrer-Policy: no-referrer\r\n' +
          'X-Frame-Options: DENY\r\n' +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n' +
          '\r\n',
      );
      return;
    }
    if (basicAuth) {
      basicAuthLimiter.clear(clientKey);
      globalAuthLimiter.clear('global');
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

  function queuePushNotification({ excludeUserId, roomId, title, body, tag, url }) {
    const task = (async () => {
      const payload = JSON.stringify({
        title,
        body: String(body || '新しいメッセージ').slice(0, 180),
        tag,
        url,
      });
      const room = getRoomById(db, roomId);
      const subscriptions = listPushSubscriptions(db, excludeUserId, roomId)
        .filter(
          (subscription) =>
            subscription.notifications_enabled && canAccessRoom(subscription, room),
        );
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
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: 'rooms', rooms: roomsPayload(client.user) });
      }
    }
  }

  function broadcastRoomsForUser(userId) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.user?.id === userId) {
        sendJson(client, { type: 'rooms', rooms: roomsPayload(client.user) });
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
      if (client.user) {
        const currentRoom = getRoomById(db, client.roomId);
        if (!canAccessRoom(client.user, currentRoom)) {
          client.roomId = defaultRoomId;
          sendJson(client, {
            type: 'room_switched',
            roomId: defaultRoomId,
            messages: getRecentMessages(db, defaultRoomId, HISTORY_LIMIT),
            threads: threadsPayload(defaultRoomId),
          });
        }
        sendJson(client, { type: 'rooms', rooms: roomsPayload(client.user) });
      }
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

  function broadcastToModerators(payload) {
    for (const client of wss.clients) {
      if (client.user && ['owner', 'admin'].includes(client.user.role)) sendJson(client, payload);
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
    return actor.role === 'admin' && GENERAL_ROLES.has(target.role);
  }

  function isAccountBanned(user, now = Date.now()) {
    return user?.banned_until === -1 || Number(user?.banned_until) > now;
  }

  function postingIsBlocked(user) {
    return Boolean(user?.posting_blocked_at);
  }

  function canModifyMessage(ws, message) {
    return Boolean(
      ws.user && (message.author_user_id === ws.user.id || canManageRooms(ws)),
    );
  }

  deleteExpiredSessions(db);

  wss.on('connection', (ws, req) => {
    ws.nickname = null;
    ws.user = null;
    ws.sessionTokenHash = null;
    ws.roomId = null;
    ws.clientKey = requestClientKey(req);

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
        const inviteError = registrationInviteError(parsed.invite);
        if (inviteError) {
          sendError(ws, inviteError);
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
        const loginKey = `${username || ''}\0${ws.clientKey}`;
        const globalRetry = globalAuthLimiter.retryAfterMs('global');
        if (globalRetry) {
          sendError(ws, 'rate_limited', { retry_after_ms: globalRetry });
          return;
        }
        const user = username ? getAccountByUsername(db, username) : undefined;
        if (!user || !verifyPassword(password, user.password_hash)) {
          const retryAfterMs = Math.max(
            appLoginLimiter.retryAfterMs(loginKey),
            appLoginLimiter.recordFailure(loginKey),
            globalAuthLimiter.recordFailure('global'),
          );
          if (retryAfterMs) {
            sendError(ws, 'rate_limited', { retry_after_ms: retryAfterMs });
            return;
          }
          sendError(ws, 'bad_credentials');
          return;
        }
        appLoginLimiter.clear(loginKey);
        globalAuthLimiter.clear('global');
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
        if (!allowLegacyJoin) {
          sendError(ws, 'account_required');
          return;
        }
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
        sendJson(ws, { type: 'rooms', rooms: roomsPayload(ws.user) });
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
          rooms: roomsPayload(ws.user),
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
        if (postingIsBlocked(ws.user)) {
          sendError(ws, 'posting_blocked', { blockReason: ws.user.posting_blocked_reason });
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
          roomId: ws.roomId,
          title: `#${room?.name || 'チャット'} · ${ws.user?.display_name || ws.nickname}`,
          body: pushBody(row.body, row.attachment),
          tag: `message-${row.id}`,
          url: `/?room=${ws.roomId}`,
        });
        return;
      }

      if (
        parsed.type === 'edit_message' ||
        parsed.type === 'delete_message' ||
        parsed.type === 'hide_message'
      ) {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const messageId = parseRoomId(parsed.messageId);
        const message = messageId ? getMessageById(db, messageId) : undefined;
        if (!message || message.hidden_at || message.room_id !== ws.roomId || message.thread_root_id !== null) {
          sendError(ws, 'message_not_found');
          return;
        }
        if (parsed.type === 'hide_message' ? !canManageRooms(ws) : !canModifyMessage(ws, message)) {
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
        } else if (parsed.type === 'delete_message') {
          deleteMessage(db, message.id, ws.roomId);
          broadcastToRoom(ws.roomId, { type: 'message_deleted', messageId: message.id });
        } else {
          hideMessageAsModerator(db, {
            targetKind: 'message',
            messageId: message.id,
            roomId: ws.roomId,
            moderatorUserId: ws.user.id,
            reason: `@${ws.user.username} が手動で非表示`,
          });
          broadcastToRoom(ws.roomId, { type: 'message_hidden', messageId: message.id });
        }
        return;
      }

      if (parsed.type === 'report_message') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const targetKind = parsed.targetKind;
        const messageId = parseRoomId(parsed.messageId);
        const category = REPORT_CATEGORIES.has(parsed.category) ? parsed.category : null;
        const details = typeof parsed.details === 'string'
          ? parsed.details.trim().slice(0, MAX_BODY_LENGTH)
          : '';
        if (!messageId || !category || (category === 'other' && !details)) {
          sendError(ws, 'bad_report');
          return;
        }

        let message;
        let threadId = null;
        let attachment = null;
        if (targetKind === 'message') {
          message = getMessageById(db, messageId);
          if (!message || message.hidden_at || message.room_id !== ws.roomId || message.thread_root_id !== null) {
            sendError(ws, 'message_not_found');
            return;
          }
          if (message.attachment_id) {
            const storedAttachment = getAttachmentById(db, message.attachment_id);
            if (storedAttachment) {
              attachment = {
                name: storedAttachment.name,
                mime_type: storedAttachment.mime_type,
                size: storedAttachment.size,
              };
            }
          }
        } else if (targetKind === 'thread') {
          threadId = parseRoomId(parsed.threadId);
          const thread = threadId ? getStandaloneThread(db, threadId, ws.roomId) : undefined;
          message = thread ? getStandaloneThreadMessage(db, messageId, thread.id) : undefined;
          if (!thread || !message) {
            sendError(ws, 'message_not_found');
            return;
          }
        } else {
          sendError(ws, 'bad_report');
          return;
        }

        try {
          const created = createMessageReport(db, {
            reporterUserId: ws.user.id,
            targetKind,
            message,
            roomId: ws.roomId,
            threadId,
            category,
            details,
            attachment,
          });
          const report = listMessageReports(db).find((item) => item.id === created.id);
          sendJson(ws, { type: 'report_submitted', reportId: created.id });
          broadcastToModerators({ type: 'report_created', report });
        } catch (err) {
          if (err.code === 'REPORT_EXISTS') {
            sendError(ws, 'already_reported');
            return;
          }
          throw err;
        }
        return;
      }

      if (parsed.type === 'get_reports') {
        if (!canManageRooms(ws)) {
          sendError(ws, 'forbidden');
          return;
        }
        sendJson(ws, { type: 'reports', reports: listMessageReports(db) });
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
        if (!userId || !ASSIGNABLE_ROLES.has(parsed.role)) {
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

      if (parsed.type === 'unblock_posting') {
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
        clearPostingBlock(db, target.id, `@${ws.user.username} が解除`);
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
            !SAFE_RASTER_MIME_TYPES.has(avatar.mime_type)
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
        if (
          parsed.allowedRoles !== undefined &&
          (
            !Array.isArray(parsed.allowedRoles) ||
            parsed.allowedRoles.some((role) => !GENERAL_ROLES.has(role)) ||
            new Set(parsed.allowedRoles).size !== parsed.allowedRoles.length
          )
        ) {
          sendError(ws, 'bad_room_access');
          return;
        }
        const allowedRoles = [...(parsed.allowedRoles || [])]
          .sort((a, b) => [...GENERAL_ROLES].indexOf(a) - [...GENERAL_ROLES].indexOf(b));
        try {
          createRoom(db, name, allowedRoles);
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

      if (parsed.type === 'set_room_notification') {
        if (!ws.user) {
          sendError(ws, 'not_authenticated');
          return;
        }
        const targetRoomId = parseRoomId(parsed.roomId);
        const targetRoom = targetRoomId ? getRoomById(db, targetRoomId) : undefined;
        if (!targetRoom || !canAccessRoom(ws.user, targetRoom)) {
          sendError(ws, 'room_not_found');
          return;
        }
        if (typeof parsed.enabled !== 'boolean') {
          sendError(ws, 'bad_room_notification');
          return;
        }
        setRoomNotificationEnabled(db, ws.user.id, targetRoomId, parsed.enabled);
        broadcastRoomsForUser(ws.user.id);
        return;
      }

      if (parsed.type === 'delete_room') {
        if (!canManageRooms(ws)) {
          sendError(ws, 'forbidden');
          return;
        }
        const targetRoomId = parseRoomId(parsed.roomId);
        const targetRoom = targetRoomId ? getRoomById(db, targetRoomId) : undefined;
        if (!targetRoom || !canAccessRoom(ws.user, targetRoom)) {
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
        const targetRoom = targetRoomId ? getRoomById(db, targetRoomId) : undefined;
        if (!targetRoom || !canAccessRoom(ws.user, targetRoom)) {
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
        if (postingIsBlocked(ws.user)) {
          sendError(ws, 'posting_blocked', { blockReason: ws.user.posting_blocked_reason });
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
          roomId: ws.roomId,
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
        if (postingIsBlocked(ws.user)) {
          sendError(ws, 'posting_blocked', { blockReason: ws.user.posting_blocked_reason });
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
          roomId: ws.roomId,
          title: `${thread.title} · ${ws.user.display_name || ws.user.username}`,
          body,
          tag: `thread-message-${message.id}`,
          url: `/?room=${ws.roomId}&thread=${thread.id}`,
        });
        return;
      }

      if (
        parsed.type === 'edit_thread_message' ||
        parsed.type === 'delete_thread_message' ||
        parsed.type === 'hide_thread_message'
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
        if (!message || message.hidden_at) {
          sendError(ws, 'message_not_found');
          return;
        }
        if (
          parsed.type === 'hide_thread_message'
            ? !canManageRooms(ws)
            : !canModifyMessage(ws, message)
        ) {
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
        } else if (parsed.type === 'delete_thread_message') {
          deleteStandaloneThreadMessage(db, message.id, thread.id);
          broadcastToRoom(ws.roomId, {
            type: 'thread_message_deleted',
            threadId: thread.id,
            messageId: message.id,
          });
          broadcastThreads(ws.roomId);
        } else {
          hideMessageAsModerator(db, {
            targetKind: 'thread',
            messageId: message.id,
            roomId: ws.roomId,
            threadId: thread.id,
            moderatorUserId: ws.user.id,
            reason: `@${ws.user.username} が手動で非表示`,
          });
          broadcastToRoom(ws.roomId, {
            type: 'thread_message_hidden',
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

  const moderationEventTimer = setInterval(() => {
    try {
      for (const event of listModerationEventsAfter(db, moderationEventCursor)) {
        moderationEventCursor = event.id;
        if (event.action === 'message_hidden') {
          const type = event.target_kind === 'thread' ? 'thread_message_hidden' : 'message_hidden';
          broadcastToRoom(event.room_id, {
            type,
            messageId: event.target_message_id,
            threadId: event.thread_id,
          });
          if (event.target_kind === 'thread') broadcastThreads(event.room_id);
        } else if (event.action === 'posting_blocked' || event.action === 'posting_unblocked') {
          broadcastUsers();
        }
      }
    } catch (error) {
      console.warn(`chat-app: moderation event poll failed (${error.code || 'unknown'})`);
    }
  }, 3000);
  moderationEventTimer.unref();

  function close(callback) {
    clearInterval(moderationEventTimer);
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
