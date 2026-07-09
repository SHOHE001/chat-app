# Non-Goals (本 Issue で実装しない項目 — Codex は越権指摘しないこと)
- 認証・ネットワークハードニング（bind 先の制限、fail2ban 等）は本 Issue では扱わない。既存の「合言葉で管理者昇格」以上のアクセス制御は追加しない。
- CSS フレームワーク・バンドラ・minifier の導入はしない。アセット最小化は「依存ゼロ・ビルドレスを維持する」ことで達成し、README に明記するに留める。
- 綾瀬サーバーへの実際の移行作業は行わない（手順の文書化のみ）。

# In-Scope / Out-of-Scope
| In-Scope | Out-of-Scope |
|---|---|
| `PORT`（1-65535 検証付き）/ `HOST` / `DB_PATH` / `ADMIN_PASSWORD` の env 化と `.env.example` | 認証・認可の新規追加（管理者合言葉は既存踏襲） |
| `.env` ロードは起動コマンド側（`node --env-file-if-exists`）に寄せる | Docker / コンテナ化（systemd を採用） |
| `staticDir` を CWD 非依存（モジュール相対）に解決 | HTTPS / リバースプロキシ設定（本体スコープ外） |
| systemd unit テンプレート（常駐・自動再起動・boot 復帰） | 親の監視機能・モデレーション（Phase 2 以降） |
| スマホ幅（〜400px）の実測レスポンシブ調整（横スクロール検査） | 実機（スマホ・シンクライアント）での動作確認 |
| README（セットアップ・env・systemd・綾瀬移行手順） | ビルドツール導入によるアセット圧縮（依存ゼロ構成を維持） |
| `resolveConfig` 単体テスト＋admin 有効/無効の回帰テスト | Playwright テストの suite 常設（依存ゼロ維持のため verify 一度きり） |
| — | Unix domain socket 文字列 PORT の後方互換（TCP ポートのみ対応） |

# Test summary
```json

```

# ci.log (tail 30 lines)
```
# Subtest: T38_thread_root_id_null_compat threadRootId:nullを明示送信すると通常のタイムライン投稿としてbroadcastされthread_root_idがnullでエラーにならない
ok 36 - T38_thread_root_id_null_compat threadRootId:nullを明示送信すると通常のタイムライン投稿としてbroadcastされthread_root_idがnullでエラーにならない
  ---
  duration_ms: 199.543693
  type: 'test'
  ...
1..36
# tests 36
# suites 0
# pass 36
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6131.700928

```
