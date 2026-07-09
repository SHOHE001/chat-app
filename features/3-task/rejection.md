# Rejection log for #3

## Round 1（design）

### 採用（plan.md 反映済み）

- [high / architect, migration] SCHEMA_SQL 内の thread_root_id index が v1 既存 DB で ALTER 前に失敗 → index を SCHEMA_SQL から分離し、version 分岐後に全パス共通で作成する構造に変更
- [high / contrarian, medium / migration] v1→v2 migration の途中失敗で duplicate column 再実行不能 → transaction 化 + `table_info` による列有無チェックで冪等化。T35 に冪等・中間状態リカバリの期待値を追加
- [medium / architect] DB 層不変条件が server 検証頼み → `insertMessage` の責務注記を明文化し、集計 JOIN に `AND r.room_id = m.room_id` の防御を追加
- [medium / architect] broadcast 受信時のバッジ更新契約が弱い → 「`thread_reply_count += 1`、`thread_last_reply_at = row.created_at`、再取得で上書き回復」を契約として明文化
- [medium / contrarian] thread_history.root とタイムライン行の形状ずれ → root はメタ無しと明記し、UI は root 表示にメタを使わない契約を追加
- [medium / migration] history 行に `thread_root_id` が含まれるか曖昧 → タイムライン行にも `thread_root_id: null` を含めて broadcast row とキー集合を統一
- [low / architect] before/after が「イメージ」止まり → getRecentMessages の before SQL 全体、getThreadMessages / getMessageById / validateThreadRoot の具体スニペットを追記

### 棄却

- [medium / contrarian] 「getRecentMessages を温存し getTimelineMessagesWithThreadMeta 新関数を追加すべき」
  - 棄却根拠: 呼び出し元は src/server.js の 3 箇所（join / delete_room 強制移動 / switch_room）と tests のみで、全箇所が「タイムライン表示」用途。旧契約（スレッド返信込み・メタ無し）の関数を残すと、以後の呼び出し側が誤って旧関数を使いスレッド返信がタイムラインに漏れる誤用リスクの方が大きい。「タイムライン = root のみ」への意味変更はアプリ全体の契約変更であり、名前を分けて両立させる意味的余地がない。影響範囲はテスト追従で吸収できる規模（実装対象に明記済み）。
- [low / contrarian] 「messages(room_id) の index / EXPLAIN QUERY PLAN 確認を今回入れるべき」
  - 棄却根拠: In-Scope/Out-of-Scope 表で明示的に Out にした項目（既存クエリの性能改善は別 Issue）。Phase 1 の想定規模（小規模教室ユース・単一 SQLite ファイル）では full scan でも実害がなく、スコープ拡大は Issue の粒度を壊す。必要になったら別 Issue で room_id/thread_root_id/id 複合 index を検討する。

## Round 2（design）

### 採用（plan.md 反映済み）

- [high / migration] T34 の文字列 `"1"` 拒否と `parseRoomId` 流用の型契約が曖昧 → 事実としては既存 `parseRoomId` は `typeof value === 'number'` チェックで文字列数値を拒否する実装（src/server.js:172-175）のため矛盾はないが、plan 上で「JSON number の正の安全な整数のみ許可、文字列数値は拒否」を入力型契約として明文化した
- [medium / architect, migration] `pragma_table_info(?)` の fallback が実装者裁量 → `PRAGMA table_info(messages)` の all() 方式に確定し、代替注記を削除
- [medium / architect, contrarian] `getThreadMessages` に room 整合防御がない → シグネチャを `getThreadMessages(db, rootId, roomId, limit)` に変更し `AND room_id = ?` を追加
- [medium / migration] DB 直呼びテストが不整合データを作れる → テスト計画に fixture 契約（WS 経由を原則、直呼び時は同 room の root id のみ）を明記
- [low / contrarian] validateThreadRoot と open_thread の root 二重取得 → ヘルパーを `resolveThreadRoot`（root 行を返す）に変更し二重取得を解消
- [low / architect] 「broadcastMessage 変更なし」の表現が payload 形状変更と矛盾 → 「本体ロジックは変更しないが送信 payload に thread_root_id が追加される」に書き分け

### 棄却

- なし（round 2 の指摘はすべて採用）
