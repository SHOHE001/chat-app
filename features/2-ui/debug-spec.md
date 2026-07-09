# debug-spec: #2 final review round 3 の修正依頼

## 修正 1（high・採用）: フロントの管理者 UI 状態が再接続・認証失敗後も残留する

`public/app.js` の問題:

- `connect()` 開始時に `isAdmin` をリセットしない
- `bad_admin_password` / `admin_disabled` 受信時に `sessionStorage` は消すが、`isAdmin = false` にせず管理 UI（ルーム作成フォーム・削除ボタン）も隠さない

再現シナリオ: 認証成功 → サーバー再起動で `ADMIN_PASSWORD` 変更 → タブが再接続して自動 re-auth が `bad_admin_password` → 管理 UI が表示されたまま（サーバー側は forbidden で防ぐが、完了条件「ADMIN_PASSWORD を入力した利用者だけがルーム作成・削除 UI を使える」に反する）。

修正内容:

- `connect()` 開始時（または `close` イベント時）に `isAdmin = false` とし、管理 UI を非表示に戻す降格処理を入れる
- `bad_admin_password` / `admin_disabled` 受信時にも同じ降格処理を呼ぶ
- 降格処理は関数化して 3 箇所（connect 開始・close・認証失敗）で共有する

## 修正 2（medium・採用）: createRoom の例外をすべて room_exists に変換している

`src/server.js` の `create_room` ハンドラが `createRoom(db, name)` の例外を無差別に catch して `room_exists` を返す。DB ロック・I/O エラー等も重複名扱いになり障害の切り分けができない。

修正内容:

- UNIQUE 制約違反（node:sqlite のエラーは `message` に `UNIQUE constraint failed` を含む。可能なら `errcode` 2067 = SQLITE_CONSTRAINT_UNIQUE も併用）のときだけ `room_exists` を返す
- それ以外の例外は再 throw する（既存の挙動方針: 想定外はクラッシュで顕在化させる）

## 棄却済み（対応不要）

- architect の「eviction ループが WebSocket.OPEN を確認せず送信」→ `sendJson` が内部で `readyState === WebSocket.OPEN` を確認しており例外は起きない。false positive として棄却済み（rejection.md 参照）

## 完了確認

- `node --test` 全 21 テスト green を維持
- 可能であれば修正 2 に対応するサーバー側テスト（UNIQUE 違反時のみ room_exists）は既存 T15 の重複ケースで担保されるため追加不要。修正 1 はフロントのみで自動テスト対象外（test-spec.md の方針どおり）
