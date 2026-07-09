# Non-Goals (本 Issue で実装しない項目 — Codex は越権指摘しないこと)
- 認証・ログイン（ニックネームのみ、メールアドレス前提にしない）
- 複数ルーム / スレッド / 管理者機能（後続 Issue #2〜#4）
- XSS 以外の高度なモデレーション、レート制限の厳密なチューニング（最低限の防御のみ実装）

# In-Scope / Out-of-Scope
| In-Scope | Out-of-Scope |
|---|---|
| Node.js + `ws` + SQLite サーバー骨格（HTTP 静的配信 + WebSocket 同一ポート） | Express などの重量フレームワーク導入 |
| DB スキーマ users / rooms / messages と起動時のデフォルトルーム "全体" 投入 | 複数ルーム作成・削除・切替（Issue #2） |
| ニックネーム入力 → 入室（認証なし、localStorage 保持） | スレッド機能（Issue #3） |
| 単一ルームでの WebSocket リアルタイム送受信 | gen8 常駐起動・デプロイ仕上げ（Issue #4） |
| 入室時の直近メッセージ履歴表示 | 親の監視 / モデレーション / プッシュ通知 / ファイル添付 |
| acceptance test（WS 送受信・履歴・永続化・境界） | ニックネームのサーバー側一意性強制・本人性検証 |

# Test summary
```json

```

# ci.log (tail 30 lines)
```
  type: 'test'
  ...
# Subtest: T08_boundary 8KB超のフレームはtoo_largeで拒否され接続は維持される
ok 8 - T08_boundary 8KB超のフレームはtoo_largeで拒否され接続は維持される
  ---
  duration_ms: 164.409905
  type: 'test'
  ...
# Subtest: T09_boundary 静的配信のtraversal/不正エンコードが拒否される
ok 9 - T09_boundary 静的配信のtraversal/不正エンコードが拒否される
  ---
  duration_ms: 149.202089
  type: 'test'
  ...
# Subtest: T10_boundary root外を指すsymlink経由のアクセスは403で拒否される
ok 10 - T10_boundary root外を指すsymlink経由のアクセスは403で拒否される
  ---
  duration_ms: 123.026531
  type: 'test'
  ...
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2124.105986

```
