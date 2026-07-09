# test-spec: #3 スレッド: ルーム内スレッド（誰でも作成可）

対象: `tests/threads.test.js`（新設）。plan.md のテスト計画 T31〜T37 と実装差分（`src/db.js` / `src/server.js`）の突き合わせ結果。

注: `check-spec-divergence.mjs` は `git diff main...HEAD`（コミット済み差分）前提のため、未コミットの本フェーズでは全 ID が missing 表示になる（divergences は 0 / exit 0）。実体は orchestrator が実ファイルと `npm test` 結果（28 pass / 0 fail / 0 skip）で突き合わせた。

## plan テスト計画との対応

| ID | 実装 | 判定 |
|---|---|---|
| T31_thread_reply_and_history | tests/threads.test.js:106 | 実装済み。broadcast row の thread_root_id、thread_history の root / 返信 id 昇順を検証 |
| T32_thread_realtime | tests/threads.test.js:151 | 実装済み。別クライアント受信と thread_root_id を検証 |
| T33_timeline_thread_meta | tests/threads.test.js:181 | 実装済み。reply_count 2 / last_reply_at 一致 / 0 件行の count 0・null / 返信のタイムライン不在を検証 |
| T34_boundary_thread_validation | tests/threads.test.js:225 | 実装済み。不存在 id・文字列 "1"・小数・0・他ルーム root・ネスト返信 → thread_not_found、行数不変、join 前 open_thread → not_joined |
| T35_migration_v1_to_v2 | tests/threads.test.js:289 | 実装済み。旧スキーマ v1 → openDb で v2、再オープン冪等、中間状態（列あり・version=1）リカバリ |
| T36_thread_room_isolation | tests/threads.test.js:392 | 実装済み。ルーム B 在室者に届かないことを timeout レースで検証 |
| T37_thread_persistence | tests/threads.test.js:433 | 実装済み。close → openDb 再オープンで getThreadMessages に返信が残る |

期待値乖離: なし（T33 の last_reply_at は broadcast row の created_at と突き合わせており、plan の「broadcast 受信時メタ更新契約」とも整合）。

## 実装差分から新たに生じた分岐と不足テスト

- `src/server.js` message ハンドラの `parsed.threadRootId !== undefined && parsed.threadRootId !== null` 分岐: 「`threadRootId: null` を明示送信」および「キー省略」がどちらも従来のタイムライン投稿になる後方互換パスが暗黙カバー（T31 の root 投稿はキー省略のみ）。**明示 null の退行テストが不足** → T38 として追加する。
- `getThreadMessages` の limit 上限（50 超の返信）: plan の Non-Goals（ページングなし・最新 50 件固定）の範囲で、境界テストは省略（既存 history 上限テストと同型のため優先度低。残置）。
- migration transaction の ROLLBACK パス: 途中失敗の人工再現は node:sqlite では注入点がなく、T35 の冪等・中間状態検証で実質カバー。残置。

## 追加するテスト

| ID | 内容 | 期待値 |
|---|---|---|
| T38_thread_root_id_null_compat | `{type:'message', body, threadRootId: null}` を明示送信 | 通常のタイムライン投稿として broadcast され `thread_root_id: null`、エラーにならない |
