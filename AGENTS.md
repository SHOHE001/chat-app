# AGENTS.md

## このプロジェクトの位置づけ

`chat-app` は、アカウント・チャンネル・独立スレッド・メッセージ返信・メンション・リアクションを試すリアルタイムチャットのプロトタイプである。
現段階では所有者だけが PC とスマホから触るモックに近く、本番サービスや複数人向けの完成品ではない。

バックエンドの完成度より、Discord風の情報密度、日時表示、PC/スマホの入力と画面遷移など「触り心地」の確定を優先する。
当面はこの Node.js 版を実際に使い、UX、不具合、運用上の違和感、必要な機能を GitHub Issues に蓄積する。その結果を
仕様として整理した後、Rust でゼロから再構築する。Node.js 版は Rust 版の「動く仕様書・比較対象」として残す。

## 現行アーキテクチャ

- Node.js `>=22.22.3`。依存は `ws`、`web-push`、サーバー側PNG生成用の`qrcode`で、フロントエンドはビルドレス。
- `src/server.js` が同一ポートで静的ファイルと WebSocket を提供する。
- SQLite は `node:sqlite` を使い、アカウント、プロフィール、セッション、チャンネル、メッセージ、リアクション、独立スレッド、添付メタデータ、通報スナップショットを保持する。
- 添付本体は`DB_PATH`と同階層の`uploads/`へ保存する。上限100MB、1メッセージ1件。JPEG/PNG/GIF/WebP/AVIFと
  MP4/WebM/QuickTimeだけをinline配信し、HTML、SVG、その他はoctet-stream＋attachmentにする。アバターも安全な
  ラスター画像だけを許可する。
- `public/` は素の HTML/CSS/JavaScript。HTTPS 配下ではクライアントが自動的に `wss:` を使う。
- Web Push購読と永続VAPID鍵をSQLiteへ保存し、Service WorkerとWeb App Manifestでモバイル通知を試作している。
- gen8では`chat-app.service`により常駐する。公開安全化後の標準配置はコード`/opt/chat-app/current`、状態
  `/var/lib/chat-app`、秘密設定`/etc/chat-app/chat-app.env`で、Webは専用`chat-app`ユーザー、AI巡回は`shohei`で動かす。
- 詳細なセットアップと運用手順は `README.md`、Basic 認証実装の判断は
  `features/basic-auth-funnel-plan.md` を参照する。

## 認証と公開

- `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` はサイト入口の共有認証であり、HTTP と WebSocket upgrade の両方を守る。
- 2変数を両方設定すると有効、両方空なら無効、片方だけなら起動時エラーにする。
- `BASIC_AUTH_USER` にコロンは使えない。パスワード内のコロンは使える。
- アプリ内権限はアカウントの `owner` / `admin` / 一般ロール（`member` / `adult` / `child` / `staff`）に紐づける。一般4ロールの通常権限は同一。旧 `ADMIN_PASSWORD` と `admin_auth` は使わない。
- 最初の登録者はowner。ownerだけが他アカウントのロールを変更でき、owner/adminがチャンネルを管理できる。
- owner/adminはチャンネル作成時に一般ロールの入室許可リストを設定できる。未選択は全員向け。owner/adminは常に入室でき、権限外利用者には一覧・直接入室・Web Pushのいずれからも内容を渡さない。作成後の許可リスト変更は未実装。
- 認証済み利用者はチャンネルごとに通知をオン／オフできる。既定はオフ。オン設定はアカウント単位でSQLiteへ保存し、そのチャンネルの通常投稿・スレッド作成・返信だけをWeb Push対象にする。
- 一般ロールは自分のメッセージだけを編集・削除できる。owner/adminは通常チャンネル・独立スレッドの全投稿を操作できる。UIだけでなくWebSocket側で権限を強制する。
- 認証済み利用者は全投稿を通報できる。対象投稿と前後2件ずつを通報時点で保全し、owner/adminだけが通報一覧を閲覧する。同一利用者・同一投稿の重複通報は禁止する。
- adminは一般ロールを、ownerはadminと一般ロールをBAN・解除できる。本人とownerはBAN不可。期間は10分、1時間、24時間、7日、30日、永久で、BAN時は全セッション・通知購読を削除して接続中WebSocketも切断する。
- owner/adminは5分間有効な招待トークン入り登録QRを生成・保存できる。手動更新すると旧QRは即時失効する。初回owner以外の新規登録は有効なQRを必須とし、旧匿名joinは通常運用で無効。生成APIもmemberを拒否し、外部QRサービスへURLを送らない。同じQRの5分以内の複数回利用は許可する。
- Basic credential は厳密な Base64 検証後、SHA-256 digest の定数時間比較で照合する。
- Safariで標準Basicダイアログが機能しない場合だけ`/basic-login`を予備入口に使う。通常URLのBasic認証と
  WebSocketのBasic header認証は削除・弱体化しない。予備入口は同じBasic資格情報を照合し、12時間有効な
  `__Host-` prefix付き`Secure`・`HttpOnly`・`SameSite=Strict` Cookieを発行する。CookieはHTTPと
  WebSocket upgradeでBasic headerとのOR条件として検証し、改ざん・重複・期限切れを拒否する。誤入力は
  Basicと同じ接続元・全体レート制限へ加算し、日本語エラーを画面内へ表示する。
- WebSocket は `WebSocketServer({ noServer: true })` と自前の `upgrade` ハンドラで認証する。HTTPだけを認証して
  WebSocketを迂回可能に戻してはいけない。
- Basic失敗は接続元ごとに10分10回、アプリログイン失敗はユーザー名＋接続元ごとに15分5回で15分停止する。
  全体は毎分300失敗を上限とし、HTTP/upgradeは429、アプリは`rate_limited`と`retry_after_ms`を返す。
- 全HTTP応答にCSP、`nosniff`、`no-referrer`、frame拒否を付ける。Funnelからloopback経由の場合だけ
  `X-Forwarded-For`右端の妥当なIPを接続元に使う。レート制限は最大10,000件のインメモリで再起動時に消える。

公開運用の現状:

- アプリ: `127.0.0.1:3002`（3000番は別の dropzone が使用中）
- 公開URL: `https://gen8.tailfc82bb.ts.net/`
- Funnel: 公開443番から `http://127.0.0.1:3002` へ転送し、`--bg` で永続化
- systemd: `chat-app.service` は enabled / active

開発用`.env`はGit対象外・600、公開用`/etc/chat-app/chat-app.env`は`root:chat-app 0640`で運用する。
実パスワード、セッショントークン、DB内データをコード、Issue、ログ、`AGENTS.md`、READMEへ書かない。
初回移行で生成するBasicパスワードは端末へ一度だけ表示し、以後は値そのものではなく設定済みかだけを確認する。

運用確認:

```bash
systemctl status chat-app --no-pager
tailscale funnel status
journalctl -u chat-app -f
```

公開停止:

```bash
sudo tailscale funnel --https=443 off
```

## 開発・検証ルール

- 作業前に `git status` と既存差分を確認し、ユーザーの未コミット変更を消さない。
- 通常の検証は `npm test`。アカウント・UI機能追加後も既存回帰を含む全テスト成功を必須とする。
- 認証変更では、HTTPの401/200だけでなく、WebSocketの401/101、join、履歴、メッセージ送受信までテストする。
- 新しい環境変数を追加したら、`resolveConfig`、`.env.example`、README、設定境界テストを同時に更新する。
- 標準配置への移行後、テスト済みの通常変更はGitHubへのpush後に
  `sudo deploy/release.sh /home/shohei/プロジェクト/chat-app`でcommit単位のreleaseを作って反映する。
  単純なservice再起動だけでは`/opt/chat-app/current`のコードは更新されない。失敗時は旧symlinkへ自動復旧し、
  手動時は`deploy/rollback.sh <sha>`を使う。
- `.env`の秘密値変更、DBの破壊的移行、Funnelの公開先・公開範囲変更、データ削除、停止を伴う長時間メンテナンスは通常反映に含めず、実行前にユーザーへ確認する。
- AI巡回はユーザーが2026-07-16に明示承認済み。3時間ごとのHaiku一次確認、候補と通報のOpus最終確認、30日内3件で投稿停止、owner/admin解除を通常運用としてよい。モデル、送信範囲、費用上限、実行間隔を広げる変更は再確認する。
- Funnel公開前後は `HOST=127.0.0.1` を維持し、LANへアプリの生ポートを公開しない。
- Funnel初回はPublic DNSの反映に時間差がある。`tailscale funnel status` と外部DNSを分けて診断する。
- 依存ゼロ・単一プロセスのプロトタイプ方針を維持し、Rust版の要件が固まる前にNode版を過剰に拡張しない。

## GitとGitHubの必須運用

- コード、設定、テスト、文書などを変更したら、AIが変更のまとまりを判断し、意味のあるチェックポイントでコミットして現在のブランチをGitHubへ通常pushする。毎ターン・数行ごとの機械的なcommit/pushは行わない。
- チェックポイントで全テストが成功し、通常再起動で安全に適用できる変更は、AIの判断でpushと本番反映まで続ける。ユーザーへ毎回push・反映の可否を問い直さない。
- チェックポイントの目安は、機能や修正がひとまとまり完成したとき、関連テストが通って動作可能な状態になったとき、別の大きな作業へ移る前、またはユーザーがpushを求めたときとする。
- 試行錯誤中、未完成、テスト失敗中、同じ目的の変更が直後も続くと合理的に判断できる場合は、履歴を細切れにしないためコミットを保留してよい。ただし長期間ため込まず、次の自然なチェックポイントでまとめる。
- コミット前に差分とステージ対象を確認し、関連する変更だけを意味の分かる単位でまとめる。読み取り、調査、説明だけのターンでは空コミットを作らない。
- 最終回答では、変更がある場合に「commit/push済み」か「まだローカルに保留中」かを明記する。保留する場合は、その理由と次のチェックポイントを簡潔に示す。
- pushが失敗した場合は完了扱いにせず、変更とコミットを保持したまま失敗理由をユーザーへ報告する。
- `git commit --amend`、rebase、reset、既存タグの移動・削除、ブランチ削除、force pushなど履歴を書き換える操作は、現在の会話でユーザーが明示承認しない限り行わない。
- 明示承認された履歴操作でも、可能なら`--force-with-lease`を使い、その1回のpushにだけ`GIT_HISTORY_REWRITE_APPROVED=1`を設定する。GitHub側のブランチ保護変更も別途必要なため、明示承認後に一時変更し、操作直後に必ず保護を戻す。恒久的なhook無効化はしない。
- `.githooks/pre-commit`と`.githooks/pre-push`を回避する`--no-verify`は使わない。clone後は`git config core.hooksPath .githooks`を設定する。
- 実資格情報、`.env`、DB、アップロード本体、セッショントークンはコミットしない。ステージ内容をcommit前に必ず確認する。

## ドッグフーディング

同一アカウントでPCとスマホへログインして同期・遅延・再接続を確認する。必要に応じて別アカウントも作り、権限とメンションを確認する。例:

- PC: `shohei-pc`
- スマホ: `shohei-mobile`

アカウント、端末間の同時ログイン、ユーザー別権限、明示的ログアウト、入室可能な全メッセージ対象のWeb Push通知は実装済み。
通知は送信者と同じアカウントおよび入室権限のないアカウントを除外するため、実機通知の確認にはPCとスマホで別アカウントを使う。未読管理、
メンション限定通知、パスワード変更・再発行は未実装であり、
Rust版へ持ち込むかドッグフーディングで判断する。

優先して確認する項目:

- PC・スマホ間のリアルタイム送受信と再接続
- チャンネル切り替えと独立スレッドの作成・返信
- メッセージの日時、連投グルーピング、直接返信、メンション、リアクション
- PCホバー／スマホ長押しでのメッセージ編集・削除と「編集済み」表示
- PCホバー／スマホ長押しでの通報、理由選択・自由記述、管理者一覧、元投稿削除後の証拠保全
- 写真・動画・ファイル選択、アップロード進捗、動画再生、失敗時の復帰
- アイコン、表示名、自己紹介、メンバーのプロフィール閲覧
- owner/adminでの登録用QR生成、別端末での読み取り、登録画面への直接遷移
- スマホの入力、スクロール、画面復帰
- ノッチ／Dynamic Island端末で主要操作がsafe area内に収まり、タップ領域が44px以上あること
- 通信切断後の表示と復旧
- iPhoneホーム画面アプリ／Android対応ブラウザでの通知許可、バックグラウンド受信、通知からの画面復帰
- 長文、連続投稿、履歴の見え方
- Basic認証後のSafari/Chrome系ブラウザでのWebSocket接続

気づいた内容は、まず事実と再現手順を残し、GitHub Issueへ「不具合」「UX改善」「新機能」「Rust版でのみ対応」に
分類する。モック段階では、観測した不便をすぐ大規模実装へ変換しない。

## 大人限定公開と延期項目

現在の公開対象は信頼できる大人の少人数だけとし、子どもはまだ参加させない。添付ACL、EXIF除去、保存期間・孤児清掃、
owner冗長化、子どもの初期ロール固定、初回owner自動付与廃止、子ども向け通知本文制御、1回限りの招待、監査ログは
GitHub IssueとRust版必須要件へ残す。`features/child-safety-plan.md`の最優先項目が満たされるまで子ども公開は禁止する。

HTML/SVGを含む一般ファイルのアップロード自体は許可するが、inline表示やアバター利用は許可しない。添付URLは現状
capability URLであり、チャンネル権限やBAN状態との再認証は未実装。通常の`<img>`/`<video>`では
`X-Session-Token`を付与できないため、Rust版ではHttpOnly Cookie、署名URL、別オリジンのいずれかで設計する。

Rust実装を始める前に、ドッグフーディングで集めたIssueを整理し、少なくとも次を決定する。
## Rust再構築フェーズへの入口


- Node版で試したアカウント・権限モデルをRust版へどう移植するか
- HTTP/WebSocketの公開プロトコルとエラー形式
- SQLiteスキーマ、既存データを移行するか破棄するか
- ルーム、スレッド、履歴、再接続、未読、通知の必須範囲
- Basic認証とFunnelを継続するか、セッションCookie等へ変えるか
- Node版とRust版の並行稼働、切り替え、ロールバック手順

Rust版はNode版を直接置換しながら作らず、比較可能な別プロセスとして構築する。現行URLを最終的に維持する場合も、
新ポートで検証してからFunnelの転送先を切り替える。SQLite DBのコピーまたは移行を先に検証し、稼働中DBへ直接
破壊的変更を加えない。
