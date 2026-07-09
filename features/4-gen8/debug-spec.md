# debug-spec: #4 STEP 7 最終レビュー採用分の修正

Codex 最終レビュー（advisory）で採用した指摘を反映する。**plan.md の設計を上書きする最新指示はこのファイル**。
既存の全テスト（36 件）を壊さず green を維持すること。

## 修正 1: HOST 既定を undefined にして IPv6 dual-stack 後方互換を維持（src/server.js）

**背景**: 元コード `app.server.listen(PORT)` は host 省略で Node が `::`（IPv6 unspecified、IPv4 dual-stack 受理）で待受していた。現状の HOST 既定 `'0.0.0.0'` は IPv4 限定になり後方互換を壊す。

`resolveConfig` を以下に修正（`normalizeStr` helper を追加し、HOST / DB_PATH / ADMIN_PASSWORD の空白のみ値も未設定扱いに統一する = 修正 2 も同時に満たす）:

```js
export function resolveConfig(env = process.env) {
  const port = parsePort(env.PORT);
  const host = normalizeStr(env.HOST);               // 未設定/空白のみ → undefined（dual-stack 既定を維持）
  const dbPath = normalizeStr(env.DB_PATH) ?? 'data/chat.db';
  const adminPassword = normalizeStr(env.ADMIN_PASSWORD);
  return { port, host, dbPath, adminPassword };
}

// undefined/空/空白のみ → undefined。それ以外は trim した文字列。
function normalizeStr(raw) {
  if (raw === undefined) return undefined;
  const t = String(raw).trim();
  return t === '' ? undefined : t;
}
```

`parsePort` は現状のまま（変更不要）。

main-module ブロックの listen を、host 有無で分岐させる（`listen(port, undefined, cb)` の曖昧さを避ける）:

```js
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
```

## 修正 2: HOST/DB_PATH/ADMIN_PASSWORD の空白のみ値を未設定扱いに（src/server.js）

修正 1 の `normalizeStr` で同時に達成される（PORT と同様、env ファイル手編集の退化入力に対する非対称を解消）。

## 修正 3: `.env.example` の HOST 既定を空に（dual-stack を既定に）

`HOST=0.0.0.0` を以下に変更（コピーしても dual-stack 既定を維持させる）:

```
# bind アドレス。未設定なら全 interface（IPv6 :: + IPv4 dual-stack）で待受。
# IPv4 のみに絞るなら 0.0.0.0、ローカルのみなら 127.0.0.1 を指定。
HOST=
```

（`HOST=` の空行は残す。T04 の `^HOST=` 網羅チェックを満たすため。）

## 修正 4: tests/deploy.test.js の期待値更新＋境界追加＋close await

- **T01**: 変更なし（明示値 `HOST:'127.0.0.1'` → `host:'127.0.0.1'` は不変）。
- **T02_boundary**: 既定の期待値を `host: undefined` に更新（`{ port:3000, host:undefined, dbPath:'data/chat.db', adminPassword:undefined }`）。
- **T05c_boundary（新規）**: `resolveConfig({ HOST:'   ', DB_PATH:'   ', ADMIN_PASSWORD:'   ' })` → `host:undefined`、`dbPath:'data/chat.db'`、`adminPassword:undefined` を assert。
- **T06**: 各ケースの `client.close()` 後に `await once(client, 'close')`（`import { once } from 'node:events'`）してから `stopServer` する helper（例 `closeClient`）を追加し、flaky/openhandle を防ぐ。

## 修正 5: public/style.css の #room-name はみ出し防止

既存 `#room-name { flex: 1; }` を以下に拡張（ルーム名は 32 文字上限で 360px 幅ではヘッダをはみ出しうる具体 overflow の局所修正。他の見た目は変えない）:

```css
#room-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

`html, body { overflow-x: hidden; }` は残す（off-canvas drawer の clip として正しい）。

## 完了条件

- `node --test`（ルートで全ファイル）が全 pass（fail 0 / skip 0）。件数は 36→37（T05c 追加）想定。
- `node -e "..."` 等で HOST 未設定時に IPv6 `::1` と IPv4 `127.0.0.1` の両方で接続を受理することを 1 回確認（dual-stack 維持の実証）。手順例:
  1. `PORT=39940 node src/server.js &` で起動（HOST 未設定）。
  2. `curl -s -o /dev/null -w "v4 %{http_code}\n" http://127.0.0.1:39940/` と `curl -s -o /dev/null -w "v6 %{http_code}\n" "http://[::1]:39940/"` が両方 200。
  3. kill。
- 報告に「変更ファイル」「node --test サマリ」「dual-stack 両接続の確認結果」を含める。
