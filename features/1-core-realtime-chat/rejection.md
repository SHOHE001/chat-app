# Rejection log for #1

## round 1

### [棄却] contrarian medium: DB を messages 単体に落とせ（users/rooms は先取り）

- 指摘: Phase 1 は単一ルーム・認証なしなので `messages(author, body, created_at)` と定数 room で足り、users/rooms は Issue #2 以降で追加すべき。
- 棄却根拠: 後続 Issue #2（ルーム作成・削除・切替）と #3（スレッド）は **intake 済みで確定**しており、messages は最初から `room_id` FK を持つ設計にしておくのが migration コスト最小。単一ルームでも `room_id` を "全体" ルームの id で埋めるだけで、Issue #2 で ALTER TABLE / データ移行が不要になる。users テーブルは #2 以降の管理者判定・表示名管理の受け皿として今入れておくコストが小さい（起動時 `INSERT OR IGNORE` のみ）。よって先取りではなく、確定した後続 Issue に対する前方互換設計として維持する。
