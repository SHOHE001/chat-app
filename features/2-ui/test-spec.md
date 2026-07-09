# test-spec: #2 ルーム: 管理者によるルーム作成・削除とルーム切替UI

## テスト実装状況（plan テスト計画との突き合わせ）

`node --test` 全体: 21 tests / 21 pass / 0 fail / 0 skipped（既存 T01〜T10 + 新規 T11〜T21）。

| plan ID | 実装 | 場所 |
|---|---|---|
| T11_admin_auth | 済 | tests/rooms.test.js |
| T12_boundary_admin_disabled | 済 | tests/rooms.test.js |
| T13_boundary_forbidden | 済 | tests/rooms.test.js |
| T14_create_room | 済 | tests/rooms.test.js |
| T15_boundary_room_name | 済 | tests/rooms.test.js |
| T16_boundary_delete_default | 済 | tests/rooms.test.js |
| T17_delete_room | 済 | tests/rooms.test.js |
| T18_delete_room_eviction | 済 | tests/rooms.test.js |
| T19_switch_room | 済 | tests/rooms.test.js |
| T20_isolation | 済 | tests/rooms.test.js |
| T21_room_persistence | 済 | tests/rooms.test.js |

既存 T01〜T10（tests/chat.test.js）は無変更のまま green（退行なし）。

## check-spec-divergence.mjs の結果

- divergences: 0
- missing impls: 11 → **false negative と判定**。スクリプトは diff 中の `test 関数定義行`（`fn`/`function`/`def`/`it`/`test` + 空白 + 識別子）を探すが、node:test の `test('T11_... ', async () => {})` は関数名でなく文字列引数に T-ID を持つためマッチしない。実体は `grep -o "T[0-9]*_[a-z_]*" tests/rooms.test.js` で 11 ID 全件の存在を確認し、`node --test tests/rooms.test.js` で 11 pass を確認済み。

## 実装差分で新たに生じた分岐とカバー状況

| 分岐 | カバー |
|---|---|
| `parseRoomId` の型不正（文字列 id / 小数 / null / 配列） | T16（delete_room 側）/ T19（switch_room 側） |
| `admin_auth` の password が非文字列 → '' 扱いで bad_admin_password | T11 の変形。危険側でないため追加テストなし（判定は safeStringEqual に一本化されている） |
| `create_room` の UNIQUE 違反 catch → room_exists | T15 |
| `delete_room` の存在確認（getRoomById）→ room_not_found | T17 |
| 削除ルーム在室者の強制移動 + デフォルトルーム履歴再送 | T18 |
| `broadcastMessage` の client.roomId フィルタ | T20 |
| join 応答の history（roomId 付き）→ rooms の順序・rooms 要素が {id,name} のみ | T14 |

## フロント（public/）の確認

フロントは自動テスト対象外（素の HTML/CSS/JS、テストフレームなし）。サーバー側プロトコルのテストで代替し、UI の見た目・スマホ開閉は人間の実機確認に委ねる（Issue の完了条件は acceptance test green が対象）。
