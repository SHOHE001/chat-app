# Non-Goals (本 Issue で実装しない項目 — Codex は越権指摘しないこと)
- 返信のネスト階層（root 直下の 1 階層のみ。root がスレッド返信のメッセージへの返信は拒否する）
- スレッド履歴のページング（`thread_history` は最新 50 件固定。より古い返信の遡りは対象外）
- ルーム削除時のスレッド特別処理（スレッド返信にも `room_id` を持たせるため、既存 `deleteRoom` の `DELETE FROM messages WHERE room_id = ?` がそのまま返信も消す。追加実装なし）
- `getRecentMessages` の後方互換 API 維持（呼び出し元は本リポジトリ内のみ。契約変更はテストごと更新する）

# In-Scope / Out-of-Scope
| 項目 | In/Out | 備考 |
|---|---|---|
| messages テーブルへの `thread_root_id` 列追加＋既存 DB マイグレーション | In | `PRAGMA user_version` 1 → 2 |
| WS `message` の拡張（`threadRootId` 指定でスレッド返信） | In | join 済みなら誰でも可 |
| WS `open_thread` / `thread_history`（スレッド履歴取得） | In | |
| スレッド返信のリアルタイム配信（同ルーム内） | In | 既存の room 単位 broadcast を流用 |
| タイムラインへの返信件数・最新返信時刻の付与 | In | history / room_switched の各行にメタを付与 |
| スレッド UI（開閉パネル・返信フォーム・返信バッジ） | In | 素の HTML/CSS/JS |
| ネスト返信（返信への返信で階層を掘る） | Out | 返信は常にスレッド root にぶら下がる（Discord 簡易版） |
| スレッドのタイトル・名前付け | Out | root メッセージ本文がそのまま見出し |
| スレッド単位の既読管理・通知・アーカイブ | Out | Phase 1 スコープ外 |
| ルーム横断のスレッド一覧ビュー | Out | |
| スレッド返信の編集・削除 | Out | メッセージ編集・削除自体が未実装 |
| messages(room_id) へのインデックス追加 | Out | 既存クエリの性能改善は別 Issue |

# Test summary
```json

```

# ci.log (tail 30 lines)
```
  type: 'test'
  ...
# Subtest: T36_thread_room_isolation ルームAのrootへのスレッド返信はルームB在室クライアントに届かない
ok 27 - T36_thread_room_isolation ルームAのrootへのスレッド返信はルームB在室クライアントに届かない
  ---
  duration_ms: 976.975632
  type: 'test'
  ...
# Subtest: T37_thread_persistence スレッド返信投稿後にサーバーclose→openDbし直すとgetThreadMessagesで返信が残っている
ok 28 - T37_thread_persistence スレッド返信投稿後にサーバーclose→openDbし直すとgetThreadMessagesで返信が残っている
  ---
  duration_ms: 513.076963
  type: 'test'
  ...
# Subtest: T38_thread_root_id_null_compat threadRootId:nullを明示送信すると通常のタイムライン投稿としてbroadcastされthread_root_idがnullでエラーにならない
ok 29 - T38_thread_root_id_null_compat threadRootId:nullを明示送信すると通常のタイムライン投稿としてbroadcastされthread_root_idがnullでエラーにならない
  ---
  duration_ms: 227.881935
  type: 'test'
  ...
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5891.85232

```
