# chat-app: Basic 認証追加 + Tailscale Funnel 公開 — 実装 Plan（GPT-5.6 実装担当向け）

## Context

このリポジトリ（`/home/shohei/プロジェクト/chat-app`）は、依存が `ws` のみ・ビルドレスの Node.js リアルタイムチャット。HTTP 静的配信と WebSocket を同一ポートで相乗りする。gen8（Ubuntu Server）には systemd unit が登録済みだが、実装開始時点では停止・無効化されている。

これを **Tailscale Funnel で公開インターネットに露出**し、「合言葉を知っている人なら誰でも入れる半公開チャット」にしたい。Funnel 自体に認証機能は無いため、**アプリ内に Basic 認証を実装する**（リバースプロキシは追加しない — 「依存ゼロ・単一プロセス」の設計思想を維持するため）。

- Funnel は TLS を gen8 上の tailscaled で終端し、`HOST=127.0.0.1` のアプリへ平文転送する。credential が平文で外部を流れることはない。
- 主要ブラウザは Basic 認証成立後、同一オリジンの WebSocket upgrade リクエストにも `Authorization` を付与するため、クライアント JS（`public/app.js`）は変更しない。ただし仕様上の挙動差に備え、公開前に iPhone Safari と Chrome 系ブラウザで実機確認する。失敗時は公開せず、セッション Cookie 方式を別 Issue で設計する。

## 既存コードの前提（実装時に流用するもの）

| 対象 | 場所 | 内容 |
|---|---|---|
| HTTP エントリポイント | `src/server.js` の `http.createServer` | `serveStatic` の前に Basic 認証を適用する。ミドルウェア機構なし |
| WebSocket | `src/server.js` の `WebSocketServer` | `noServer: true` と自前 `server.on('upgrade')` で認証する |
| env パース | `src/server.js` の `resolveConfig(env)` | export 済み純関数。Basic 認証値は文字列型を保つ専用 normalizer で空白除去・空値正規化する |
| 定数時間比較 | `src/server.js` の `safeStringEqual(a, b)` | SHA-256 ダイジェスト同士を `timingSafeEqual`。長さ違いでも throw しない。**再利用する** |
| CLI 起動ブロック | `src/server.js` の main module block | `resolveConfig()` → `createChatServer({...})` → listen |
| テスト | `tests/*.test.js`、`node --test`（`npm test`） | 各ファイルに `startServer`/`stopServer` ヘルパー（`createChatServer` → `listen(0)` → 実 fetch/WS で検証）。env テストは `tests/deploy.test.js` T01-T05 |
| systemd | `deploy/chat-app.service` | `EnvironmentFile=-.env` で env 注入。**変更不要**（新変数もそのまま渡る） |

## 仕様

- 新 env: `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`
  - **両方設定** → HTTP・WebSocket 全体に Basic 認証がかかる
  - **両方未設定**（空/空白のみ含む）→ 認証無効（後方互換。`ADMIN_PASSWORD` と同じ流儀）
  - **片方のみ設定** → `resolveConfig` が throw（fail-fast。`parsePort` と同じ流儀）。エラーメッセージには両変数名を含め、journalctl で原因が読めるようにする
  - 専用 normalizer を通すため値の前後空白は trim される（README に明記）
  - 文字列以外の値と、コロンを含む user は起動時に throw。password のコロンは許可する
- `resolveConfig` の戻り値には **`basicAuth: { user, password } | undefined`** のネスト形で追加する（「両方 or 無し」の不変条件を形で表現し、`createChatServer` へ 1 引数で渡せる）
- 認証失敗時: HTTP は `401` + `WWW-Authenticate: Basic realm="chat", charset="UTF-8"`。WS upgrade は生の 401 レスポンスを `socket.end(response)` で完全に送って終了する
- credential の Base64 は文字種・padding・再エンコード一致まで厳密に検証し、不正文字を無視して認証成功させない
- user / password の比較は両方 `safeStringEqual` で行い、**短絡評価せず両方評価してから AND**（タイミング差を作らない）

## 実装ステップ（TDD: テスト先行で進めること）

### Step 1 [Red] テスト追加・既存テスト更新

**新規 `tests/basic-auth.test.js`**（ヘルパーは `tests/deploy.test.js` の `startServer`/`stopServer`/`waitForOpen` パターンを踏襲。`startServer` に `basicAuth` オプションを追加）。ケース一覧は後述の「テストケース」節。

**既存 `tests/deploy.test.js` の更新（必須 — T01/T02 は `assert.deepEqual` で全キー比較しているため、キー追加で壊れる）**:

- T01（:67-71）: env に `BASIC_AUTH_USER: 'u', BASIC_AUTH_PASSWORD: 'p'` を追加し、期待値に `basicAuth: { user: 'u', password: 'p' }` を追加
- T02（:73-76）: 期待値に `basicAuth: undefined` を追加
- T04（:83-89）: 網羅キー配列に `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` を追加

`npm test` で新規テストが落ちることを確認してから Step 2 へ。

### Step 2 [Green] `resolveConfig` 拡張（`src/server.js:210-216`）

```js
export function resolveConfig(env = process.env) {
  // 既存 4 項目はそのまま
  const basicAuthUser = normalizeBasicAuthValue(env.BASIC_AUTH_USER, 'BASIC_AUTH_USER');
  const basicAuthPassword = normalizeBasicAuthValue(env.BASIC_AUTH_PASSWORD, 'BASIC_AUTH_PASSWORD');
  if ((basicAuthUser === undefined) !== (basicAuthPassword === undefined)) {
    throw new Error('BASIC_AUTH_USER と BASIC_AUTH_PASSWORD は両方設定するか両方未設定にしてください（片方のみは不可）');
  }
  const basicAuth = basicAuthUser === undefined
    ? undefined
    : { user: basicAuthUser, password: basicAuthPassword };
  return { port, host, dbPath, adminPassword, basicAuth };
}
```

### Step 3 [Green] HTTP 認証（`src/server.js`）

**純関数 `checkBasicAuth(header, basicAuth)`** を `safeStringEqual` の直後に追加:

```js
function checkBasicAuth(header, basicAuth) {
  if (!basicAuth) return true; // 未設定 = 認証無効（後方互換）
  if (typeof header !== 'string') return false;
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx === -1) return false;
  if (header.slice(0, spaceIdx).toLowerCase() !== 'basic') return false; // RFC 7235: scheme は case-insensitive
  const token = header.slice(spaceIdx + 1).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return false;
  const bytes = Buffer.from(token, 'base64');
  if (bytes.toString('base64') !== token) return false;
  const decoded = bytes.toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;
  const userOk = safeStringEqual(decoded.slice(0, colonIdx), basicAuth.user);
  const passOk = safeStringEqual(decoded.slice(colonIdx + 1), basicAuth.password);
  return userOk && passOk; // 両方評価してから AND
}
```

- コロン分割は**最初のコロンのみ**（RFC 7617: user 名にコロン不可、password にはコロンを含められる）
- `Buffer.from(str, 'base64')` は不正文字を無視するため、デコード前の形式検証と再エンコード一致を必須にする

**`sendUnauthorized(res)`** を `sendStatus`（:67-70）付近に追加:

```js
function sendUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="chat", charset="UTF-8"',
  });
  res.end('Unauthorized');
}
```

**`createChatServer`**: シグネチャを `{ dbPath, staticDir, adminPassword, basicAuth }` に拡張。冒頭の
`assertBasicAuthConfig` で factory 直呼び時も型・空値・user のコロンを拒否する。

HTTP ハンドラ（:260-262）を差し替え:

```js
const server = http.createServer((req, res) => {
  if (!checkBasicAuth(req.headers.authorization, basicAuth)) {
    sendUnauthorized(res);
    return;
  }
  serveStatic(req, res, root, rootReal);
});
```

認証チェックは `serveStatic` の 405/404 等の判定より**前**に置く（未認証 POST は 405 でなく 401。リソース存在の情報漏洩を避ける）。

### Step 4 [Green] WS upgrade 認証（`src/server.js:264`）

`verifyClient` は ws 公式が非推奨のため使わない。`noServer: true` + 自前 upgrade ハンドラ（ws 公式推奨パターン）:

```js
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

server.on('upgrade', (req, socket, head) => {
  const onSocketError = () => socket.destroy();
  socket.on('error', onSocketError); // 認証中の client abort で unhandled 'error' クラッシュを防ぐ
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
  socket.removeListener('error', onSocketError); // 以降は ws が socket のエラーを管理
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
```

検証済みの互換性メモ:

- `maxPayload` は `noServer` でも constructor オプションとして有効（維持必須）
- 生 401 に `Content-Length: 0` を付けて well-formed にする → ws クライアントが `unexpected-response` イベントで受け取れる（テストで利用）
- 既存 `close()`（:476-486）は変更不要 — `node_modules/ws/lib/websocket-server.js:186-200` で `noServer` と `server` は close() 内で同一分岐であることを確認済み
- 非 WebSocket な Upgrade は `wss.handleUpgrade` が 400 を返す（従来と同等）
- `wss.on('connection', ...)`（:294）は変更不要

### Step 5 [Green] main 配線（`src/server.js:499-516`）

`const { port, host, dbPath, adminPassword, basicAuth } = resolveConfig();` → `createChatServer({ dbPath, staticDir, adminPassword, basicAuth })`。

### Step 6 ドキュメント・設定ファイル

- **`.env.example`**: 末尾に追加

  ```
  # Basic 認証（Tailscale Funnel 等で外部公開する際に使用）
  # 両方設定すると HTTP/WebSocket 全体に Basic 認証がかかる。両方空なら無効。
  # 片方だけの設定は起動時エラー（fail-fast）。値の前後空白は trim される。
  BASIC_AUTH_USER=
  BASIC_AUTH_PASSWORD=
  ```

- **`README.md`**: 環境変数一覧の表（:32-37 付近）に 2 行追加 + 新セクション「Tailscale Funnel での外部公開」（下記の運用手順を記載）
- **`deploy/chat-app.service`** / **`public/app.js`**: 変更不要（理由は Context 節参照）

### Step 7 検証

1. `npm test` 全パス
2. 手動 curl:
   ```bash
   # .env に BASIC_AUTH_USER/PASSWORD を設定して npm start した状態で
   curl -i http://127.0.0.1:3002/              # → 401 + WWW-Authenticate
   curl -i -u user:pass http://127.0.0.1:3002/ # → 200
   ```
3. ブラウザ実機: 認証ダイアログ → 入場 → WS 接続確立・チャット送受信（DevTools Network で upgrade の 101 を確認）。**これは必須** — 同一オリジンの WS handshake への Authorization 自動付与は主要ブラウザの実挙動だが仕様保証ではないため

## テストケース（`tests/basic-auth.test.js`）

**resolveConfig 系（純関数、サーバー起動不要）**

- B01: 両方設定 → `basicAuth` が `{ user, password }`（trim 済み）
- B02: 両方未設定 → `basicAuth === undefined`
- B03: user のみ / password のみ → それぞれ throw（メッセージに両変数名を含む）
- B04: 空白のみ user + 実値 password → throw（専用 normalizer の境界）
- B05: 両方空文字 → undefined（無効・後方互換）
- B06: 文字列以外の値 / コロンを含む user → throw

**HTTP 統合（fetch。ヘルパー `authHeader = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')`）**

- B10: 認証無効 → `GET /` 200（回帰）
- B11: 有効 + ヘッダ無し → 401、`WWW-Authenticate` に `Basic realm=` を含む
- B12: 正しい credential → 200
- B13: user 誤り / password 誤り → 各 401
- B14: malformed 群（`Basic` 単独、`Basic !!!`、`Bearer x`、base64("nocolon")、正しい Base64 への不正文字混入）→ すべて 401 **かつサーバー存命**（直後の正常リクエストで 200 確認）
- B15: コロン入りパスワード（設定 `p:a:ss`）→ 正しい credential で 200
- B16: HEAD 未認証 401 / HEAD 認証済み 200 / POST 未認証 401（405 より 401 が先）
- B17: 小文字 scheme `basic` → 200（RFC 7235）

**WS 統合（ws クライアントの `headers` オプションと `unexpected-response` イベントを使う）**

- B20: 有効 + ヘッダ無し → `unexpected-response` で `res.statusCode === 401`
- B21: 有効 + 正しい `Authorization` → open → join → history 受信（フルフロー）
- B22: 有効 + 誤 credential → 401
- B23: 無効 → 接続成功（noServer 化の明示回帰）
- B24: 同一 credential で `GET /` 200 かつ WS join → message 送受信（HTTP/WS 両レイヤ貫通）

**既存テスト更新**: `tests/deploy.test.js` T01 / T02 / T04（Step 1 参照）

## Tailscale Funnel 運用手順（README に記載する内容。コード変更なし・実装後に人間/リーダーが実施）

前提: gen8 で tailscale ログイン済み・v1.50+、tailnet ACL に funnel 属性（未設定なら CLI が有効化 URL を出す）、MagicDNS + HTTPS certificates 有効。

```bash
# 1. .env に PORT=3002 / HOST=127.0.0.1 / BASIC_AUTH_USER / BASIC_AUTH_PASSWORD を設定
# 2. systemd を有効化して起動
sudo systemctl enable --now chat-app
# 3. ローカルで認証確認（Step 7-2 と同じ）
# 4. Funnel 有効化（公開 443 → localhost:3002。--bg で永続）
sudo tailscale funnel --bg --https=443 http://127.0.0.1:3002
tailscale funnel status
# 5. https://<machine>.<tailnet>.ts.net へアクセス → Basic 認証 → チャット動作確認
# 停止: tailscale funnel --https=443 off（全消しは tailscale funnel reset）
```

運用ノート（README にも記載）:

- Funnel の公開ポートは 443/8443/10000 のみ。ローカル側は既存の 3002 を使う（3000 は dropzone が使用中）
- Funnel 専用運用では `HOST=127.0.0.1` を必須とし、LAN からの直接到達を避ける
- 既知の制限: レート制限なし（ブルートフォース対策は将来課題 — パスワードは強いランダム文字列にする）、Basic 認証にログアウト概念なし（ブラウザ終了まで credential キャッシュ）

## 完了条件

- [ ] `npm test` 全パス（新規 basic-auth.test.js + 既存 4 ファイル）
- [ ] 認証無効時（env 未設定）の挙動が現行と完全一致（既存テスト無修正パス、ただし deploy.test.js の T01/T02/T04 の期待値更新は除く）
- [ ] curl での 401/200 確認
- [ ] ブラウザ実機で認証 → チャット送受信（WS 貫通）確認
- [ ] README / .env.example 更新済み
