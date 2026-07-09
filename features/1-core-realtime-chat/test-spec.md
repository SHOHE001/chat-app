# test-spec: #1 コア: ニックネーム参加＋単一ルームのリアルタイムチャット

- フレームワーク: `node:test`（`node --test`）、追加依存なし
- テストファイル: `tests/chat.test.js`
- 実行結果: 10 tests / 10 pass / 0 fail / 0 skip（3 回連続で安定）

各テストは一時 DB パスとランダムポート（`listen(0)`）で `createChatServer` を起動し、`ws` クライアント（T09/T10 は `node:http` の生リクエスト）で検証、終了時に `close` & 一時 DB を unlink する。

| T-ID | 検証内容 | assertion（実装済み） |
|---|---|---|
| T01 | 2 クライアント間のリアルタイム配信 | A 送信 `body:"hi"` → B が `type:"message"` を受信し `message.body==="hi"` / `message.author==="アリス"` |
| T02 | 入室時の履歴を id 昇順で受信 | 事前 3 件 → join で `type:"history"` / `messages.length===3` / body が投入順 `["one","two","three"]` / 各行に `created_at` / id 昇順 |
| T03_boundary | 空白のみ body は保存も配信もされない | `body:"   "` 送信後 200ms 待機で `type:"message"` を受けない、`getRecentMessages` 件数不変 |
| T04_persistence | DB 再オープンで履歴が残る | `openDb`→insert→`close`→再 `openDb` で `messages.length===1` / `body==="persisted"`（SQLite 永続化） |
| T05_boundary | 未 join の message は error で保存されない | いきなり message → `type:"error"` / `reason:"not_joined"`、件数不変 |
| T06_boundary | 2001 文字以上の body は 2000 に切り詰め | `'あ'.repeat(2500)` 送信 → 受信 `message.body.length===2000` かつ `'あ'.repeat(2000)` 一致 |
| T07_boundary | 不正 nickname の join を拒否 | 制御文字/33 文字以上の nickname → `type:"error"` / `reason:"bad_nickname"`、以降 message 不可・users 非保存 |
| T08_boundary | 8KB 超フレームは too_large で接続維持 | UTF-8 8192 超・64KB 未満 → `type:"error"` / `reason:"too_large"`、同接続で後続正常メッセージ可 |
| T09_boundary | 静的配信の traversal/不正エンコード拒否 | `GET /`=200(index) / 生リクエスト `GET /../src/server.js`=403 / 不正 percent-encoding=400 |
| T10_boundary | root 外 symlink 経由アクセスを拒否 | `public/` 配下に root 外 dir への symlink を一時作成しその配下要求 → 403（symlink 不可環境は `t.skip`） |

## plan.md 期待値との対応

plan.md「テスト計画」の T01〜T10 と 1:1 対応。T02 の順序契約は `id ASC`（plan.md round 2 で確定）に一致。T09 は plan.md round 5 の実装知見（`new URL()` を使わず生 `..` を残す）に沿って生リクエストで検証。

## 実装との整合（check-spec-divergence 対象）

- 履歴順: `getRecentMessages` = `id ASC` ⇔ T02 の id 昇順 assertion 一致
- 切り詰め: body 2000 文字 ⇔ T06 の `length===2000` 一致
- payload: `Buffer.byteLength(...,'utf8') > 8192` ⇔ T08 一致
- nickname: 32 文字・制御文字拒否 ⇔ T07 一致
- 静的配信: 実体境界 403 ⇔ T09/T10 一致
