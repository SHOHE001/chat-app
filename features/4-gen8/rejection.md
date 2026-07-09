# Rejection log for #4

## STEP 3 設計レビュー round 1（Codex 3 persona, advisory）

### 採用（plan.md に反映済み）

- PORT バリデーション（architect/contrarian/migration 一致・high）: `resolveConfig` で 1-65535 の整数検証、不正は throw で fail-fast。
- `.env` 二重ロード解消（3persona・medium）: アプリ内 `process.loadEnvFile` を廃止し、`npm start` は `node --env-file-if-exists=.env`、systemd は `EnvironmentFile=-`。優先順位「OS/systemd env > .env」を明記。
- DB_PATH の CWD 相対 vs staticDir モジュール相対の非対称性（architect/migration・medium）: 理由（可変データ vs 同梱アセット）を README とテスト名に明記。
- admin 有効/無効の回帰テスト（migration・medium）: T06 として追加。
- レスポンシブ合否基準（contrarian・medium）: 360px で `scrollWidth <= innerWidth` を playwright 実測・記録。

### 不採用（再提起抑制のための根拠）

- Unix domain socket 文字列 PORT の後方互換（migration・high）: 本アプリは TCP ポート上の HTTP+WS のみ。`PORT=/tmp/x.sock` の既存利用はなく、Issue スコープ外。PORT は「1-65535 の整数」と定義する。
- Playwright ブラウザテストを `node --test` suite にコミット（contrarian・medium）: devDep 追加は Non-Goal「依存ゼロ・ビルドレス維持」に反する。responsive 検証は verify フェーズの一度きり実測＋結果記録に留める。

## STEP 7 最終レビュー（Codex 3 persona, advisory）— architect:pass / contrarian:fail(1) / migration:fail(2)

### 採用（implementer 再 dispatch = debug-spec.md、または orchestrator 自身で修正）

- 既定 HOST=0.0.0.0 で IPv6 dual-stack 後方互換喪失（migration・high）: 元 `listen(PORT)` は host 省略で `::`（IPv4/IPv6 dual-stack）。HOST 既定を undefined にし、明示時のみ bind。plan の「挙動を保ちつつ」に整合。→ src/server.js + T01/T02 + .env.example
- README の systemd EnvironmentFile 優先順位が不正確（contrarian/migration・high）: `--env-file`（OS env 優先）と systemd `EnvironmentFile`（サービス環境構築・シェル env 非継承）を混同していた。npm start と systemd を分けて正確に記述。→ README（orchestrator 自身で修正）
- HOST/DB_PATH の空白のみ値が未設定扱いにならない（3persona・medium）: PORT と同様 trim し空白のみは既定へ。→ src/server.js + 境界テスト
- T06 が ws close 未 await で flaky 可能性（contrarian・low）: close を await。→ tests/deploy.test.js
- 長いルーム名でヘッダはみ出し（contrarian・medium の具体部分）: `#room-name` に min-width:0 + ellipsis。ルーム名は 32 文字上限で 360px 超は解析可能な実 overflow（推測ではない）。→ public/style.css

### 不採用（根拠）

- staticDir モジュール相対の単体テスト欠如 / テスト名（architect・low）: 別 CWD（/tmp）起動で GET 200・DB 生成を orchestrator が実地検証済み。main-module 結合テストは本 Issue スコープ外。
- overflow-x:hidden は「隠すだけ」批判の一般部分（contrarian・medium）: off-canvas drawer（fixed+translateX で画面外退避）に対する overflow-x:hidden は定石の正しい clip であり band-aid ではない。具体的な header overflow のみ局所修正で対応し、それ以外の投機的 CSS は足さない。
