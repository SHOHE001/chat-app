# Non-Goals (本 Issue で実装しない項目 — Codex は越権指摘しないこと)
- 管理者の操作ログ・監査ログは実装しない
- 合言葉のレート制限・ブルートフォース対策は実装しない（家庭内利用の MVP。将来必要なら別 Issue）
- ルームのアーカイブ（論理削除）は実装しない（物理削除のみ）
- DB スキーマ変更・migration 機構の導入はしない（既存の rooms/messages テーブルをそのまま使う）

# In-Scope / Out-of-Scope
| 項目 | In/Out | 備考 |
|---|---|---|
| `ADMIN_PASSWORD` による管理者判定（WS メッセージ `admin_auth`） | In | 未設定時は管理機能を全拒否（安全側） |
| ルーム作成・削除（管理者のみ、WS メッセージ経由） | In | デフォルトルーム「全体」は削除不可 |
| ルーム一覧の配信と作成/削除時の全員へのブロードキャスト | In | `{type: 'rooms', rooms}` |
| ルーム切替（`switch_room`）とルーム別履歴取得 | In | 切替時に該当ルームの直近 50 件を返す |
| ルーム単位の配信分離（在室ルームのメッセージのみ受信） | In | `broadcastMessage` をルームでフィルタ |
| ルーム削除時の在室者のデフォルトルームへの強制移動 | In | デフォルトルームの履歴も再送する |
| ルーム削除時のメッセージ削除 | In | トランザクションで messages → rooms の順に DELETE |
| サイドバー UI（PC 常時表示 / スマホ開閉式） | In | 素の HTML/CSS/JS |
| 管理者 UI（合言葉入力・ルーム作成フォーム・削除ボタン） | In | 認証成功時のみ表示 |
| ルーム名の変更（rename） | Out | 需要が出たら別 Issue |
| ルームごとの参加権限・非公開ルーム | Out | Phase 1 は全ルーム公開 |
| アカウント制・セッション管理 | Out | intake 決定事項（合言葉方式のみ） |
| HTTP REST API としてのルーム CRUD | Out | 既存構成に合わせ WS メッセージで実装 |
| スレッド機能 | Out | Phase 1 の後続 Issue |

# Test summary
```json

```

# ci.log (tail 30 lines)
```
  type: 'test'
  ...
# Subtest: T19_switch_room 正常系はroom_switched+履歴（id昇順・最大50件）、join前はnot_joined、不明id/型不正はroom_not_found
ok 19 - T19_switch_room 正常系はroom_switched+履歴（id昇順・最大50件）、join前はnot_joined、不明id/型不正はroom_not_found
  ---
  duration_ms: 457.897977
  type: 'test'
  ...
# Subtest: T20_isolation ルームA在室者の発言はA在室者だけに届きB在室者には届かない
ok 20 - T20_isolation ルームA在室者の発言はA在室者だけに届きB在室者には届かない
  ---
  duration_ms: 615.541415
  type: 'test'
  ...
# Subtest: T21_room_persistence 作成したルームと投稿がDB再オープン後も残る
ok 21 - T21_room_persistence 作成したルームと投稿がDB再オープン後も残る
  ---
  duration_ms: 222.389819
  type: 'test'
  ...
1..21
# tests 21
# suites 0
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4086.888622

```
