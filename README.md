# chat-app

チャットアプリのプロジェクト。

## 概要

アカウント、複数チャンネル、独立スレッド、メンション、リアクションに対応した、ビルドレスのリアルタイムチャット。
Node.js版はバックエンドの完成品ではなく、PCとスマホでDiscord風の触り心地を詰めるUI実験場として扱う。
HTTP 静的配信と WebSocket を同一ポートで相乗りさせ、SQLite（`node:sqlite`）に永続化する。gen8（Ubuntu Server）で
systemd 常駐運用し、将来的にRustで再構築することを見据えて、環境依存の値（ポート・DB パス等）は
すべて環境変数で注入できるようにしてある。

## 必要要件

- Node.js **>= 22.22.3**

理由: `node:sqlite`（`DatabaseSync`）をフラグなしで安定して使うためのバージョン固定（`package.json` の
`engines.node` にも同条件を明記済み）。これより古い Node では `node:sqlite` が実験フラグ必須だったり、
`--env-file-if-exists` のような起動フラグが使えなかったりする。起動時に `checkNodeVersion()` が
バージョンを比較し、要件未満なら明示エラーを出して即終了する（fail-fast）。

## セットアップ

```bash
npm install
cp .env.example .env   # 必要に応じて値を編集する
```

`.env` を作らなくても、既定値（後述）で起動できる。

## 環境変数一覧

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket の待受ポート。1-65535 の整数のみ受理。未設定・空・空白のみは既定値にフォールバックし、それ以外の不正値（`abc` / `0` / `65536` / `-1` / `12.5` 等）は起動時に明示エラーで即終了する（fail-fast）。前後の空白は trim して許容する。 |
| `HOST` | `0.0.0.0` | bind アドレス。`0.0.0.0` は全 interface、`127.0.0.1` はローカルのみ。 |
| `DB_PATH` | `data/chat.db` | SQLite DB ファイルのパス。**相対パスは起動時の CWD（カレントディレクトリ）基準**（後述）。 |
| `BASIC_AUTH_USER` | 未設定 | サイト入口の Basic 認証ユーザー名。`BASIC_AUTH_PASSWORD` と両方設定したときだけ認証を有効にする。コロン（`:`）は使用不可。前後空白は trim する。 |
| `BASIC_AUTH_PASSWORD` | 未設定 | サイト入口の Basic 認証パスワード。ユーザー名と片方だけ設定した場合は起動時エラー。前後空白は trim する。パスワード内のコロンは使用可能。 |
| `VAPID_SUBJECT` | `mailto:chat-app@localhost` | Web Push署名の連絡先URI。`mailto:` または `https://` で始める。公開運用では管理者のメールアドレスまたは連絡先URLを推奨。 |

`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` は HTTP の静的ファイル配信と WebSocket upgrade の両方を保護する。
両方未設定（空・空白のみを含む）なら従来どおり認証なしで動作する。片方のみの設定は設定ミスとして fail-fast する。
Basic認証は公開URLの共有入口であり、アプリ内アカウントとは別の認証である。

AI巡回ワーカーは`CLAUDE_BIN`（systemdでは絶対パス推奨）、`MODERATION_BATCH_SIZE`、
`MODERATION_HAIKU_BUDGET_USD`、`MODERATION_OPUS_BUDGET_USD`、`MODERATION_TIMEOUT_MS`、
`MODERATION_STRIKE_THRESHOLD`（既定3件）、`MODERATION_STRIKE_WINDOW_DAYS`（既定30日）、
`MODERATION_MAX_OPUS_CALLS`（1巡回あたり既定10回）で制御する。上限を超えた候補・通報は次回へ繰り越す。

## アカウントと権限

- ログイン画面の「登録」からユーザー名と8文字以上のパスワードを登録する。
- DB上で最初に登録したアカウントが `owner`、以降は `member` になる。
- `owner` はメンバー一覧から他アカウントを `admin` / `member` に変更できる。
- `owner`は一般アカウントへ`member`（メンバー）、`adult`（大人）、`child`（子供）、`staff`（スタッフ）を設定できる。これら4ロールの権限は同一で、スタッフという表示名でも管理機能は付与されない。`admin`だけが管理権限を持つ。
- `owner` と `admin` はチャンネルを作成・削除できる。旧 `ADMIN_PASSWORD` / `admin_auth` は廃止済み。
- `admin`は4種類の一般ロールを、`owner`は`admin`と一般ロールをBAN・解除できる。本人と`owner`はBANできない。
- BAN期間は10分、1時間、24時間、7日、30日、永久から選ぶ。BAN時は全端末のセッションと通知購読を失効し、接続中の端末も即時切断する。一時BANは期限を過ぎると自動解除される。
- セッションはブラウザとDBに30日間保存する。同じアカウントをPC・スマホの両方で利用できる。
- 既存のニックネームと同名で初回登録すると、そのユーザー行をアカウントとして引き継ぐ。
- 自分のアカウント欄にある編集ボタンから、表示名、160文字以内の自己紹介、5MB以下のアイコン画像を設定できる。
- メンバー一覧を選ぶとプロフィールカードを閲覧できる。メンションには変更できない`@ユーザー名`を使い、表示名とは分ける。
- アイコンと表示名は、既存の過去メッセージにも現在のプロフィールとして反映する。

## 登録用QRコード

- `owner`と`admin`は、自分のアカウント欄にある「▦」ボタンから5分間有効な登録用QRコードを生成できる。`member`にはこの操作を表示せず、生成APIも403で拒否する。
- QRコードには現在開いているChat Labと同じオリジンの登録URL、ランダムな招待トークン、有効期限を格納する。読み取った端末では、保存済みセッションがあっても最初にアカウント登録画面を表示する。
- 「QRを更新」を押すと新しいQRを生成し、それ以前のQRは有効期限内でも即時無効になる。ダイアログには5:00からの残り時間を表示し、期限切れ後はコピー・保存を無効化する。
- DBにアカウントがない初回セットアップだけは招待なし登録を許可して`owner`を作る。それ以降の新規登録は有効な招待QRが必須で、通常ログイン画面から登録導線を隠す。既存アカウントのログインは影響を受けない。
- ダイアログから登録URLをコピーするか、512px PNG画像として保存できる。QR生成は外部サービスを使わず、サーバー内の`qrcode`パッケージで行う。
- Basic認証を有効にした環境では、QRを読んだ利用者はサイト入口のBasic認証を通過した後にアカウント登録画面へ進む。
- 同じQRは5分以内なら複数アカウントの登録に使える。1回限りの招待、利用回数制限、QRをその場で読めない利用者向けの代替導線は未実装。

## メッセージの編集と削除

- `member`は自分のメッセージだけを編集・削除できる。`owner`と`admin`は全員のメッセージを操作できる。
- `owner`と`admin`は全投稿を手動で非表示にできる。手動非表示はDBと監査履歴に保持し、AI違反回数には加算しない。現状は管理画面からの再表示には対応していない。
- 通常チャンネルと独立スレッドの投稿が対象。権限はWebSocket API側でも検証する。
- PCではメッセージへポインターを重ね、スマホでは長押しして操作メニューを開く。
- 編集後は本文に「（編集済み）」と表示し、表示へポインターを重ねると編集日時を確認できる。
- 削除時はブラウザ標準確認ではなく、対象本文を表示するアプリ内ダイアログで確認する。
- 添付付きメッセージを編集しても添付は維持する。削除した添付ファイル本体の自動清掃は現状行わない。

メッセージ入力欄では、登録済みユーザーの`@ユーザー名`を水色で強調する。入力自体は通常のtextareaで行い、
ハイライト層を同期することでスマホのIME、カーソル、キーボード表示を維持する。

## 通報

- 通常チャンネルと独立スレッドの全投稿に「通報」を表示する。PCでは投稿へポインターを重ね、スマホでは長押しして開く。
- 理由は「いやなことを言われた」「個人情報が書かれている」「こわい画像・動画」「迷惑な連続投稿」から選ぶか、「自由に書く」を選んで2000文字以内で入力できる。大分類を選んだ場合も補足は任意で入力できる。
- 同じ利用者が同じ投稿を重複通報することはできない。通報完了時は送信者へ完了表示を返し、接続中の`owner`/`admin`へ即時通知する。
- 通報時点の投稿本文、投稿者、日時、添付メタデータと前後2件ずつの会話をSQLiteへスナップショット保存する。元投稿が後から削除されても管理者の通報一覧には残る。
- `owner`/`admin`だけがアカウント欄の「🚩」から通報一覧を閲覧できる。通報者の氏名など、アプリが元から保持していない情報は追加収集しない。
- 通報は次のワーカー起動時にHaikuを経由せず、理由、保存済み本文、前後の文脈をOpusが確認する。

## AI巡回と投稿停止

- Webサーバーとは別のoneshotワーカーをsystemd timerで3時間ごとに起動する。新規・編集後の未審査メッセージだけをHaikuが一次確認し、候補だけをOpusが独立して再確認する。
- Opusが違反を確定した投稿はDBから削除せず、通常の履歴と接続中画面から非表示にする。誤検知と判断した投稿は維持する。
- 30日内に異なる3投稿がOpusで違反確定したアカウントは、新規メッセージ、スレッド作成、スレッド返信を停止する。ログイン・閲覧・既存投稿の編集削除は維持し、`owner`/`admin`がメンバー一覧から解除できる。
- モデルにはツールを渡さず、safe mode、セッション非保存、JSON Schema、1回ごとの費用上限を強制する。モデルはDBを操作せず、アプリ側だけが固定された非表示・停止処理を行う。
- journalには処理件数と成否だけを出し、本文・ユーザー名・通報内容は出さない。Claudeへの本文は標準入力で渡し、プロセス引数にも残さない。公開前に、会話が外部AIへ送信されることを利用者へ明示する。
- 手動実行は`npm run moderate`。失敗時は未審査のまま残り、次回起動で再試行される。

## 写真・動画・ファイル添付

- メッセージ入力欄の「＋」から、スマホ・PCの写真、動画、一般ファイルを1件選択できる。
- 1ファイルの上限は100MB。アップロード進捗と失敗理由を入力欄の上に表示する。
- 写真はインライン画像、動画はブラウザ標準プレイヤー、その他はダウンロード可能なファイルカードとして表示する。
- ファイル本体は`DB_PATH`と同じディレクトリの`uploads/`へ保存し、メタデータとメッセージ参照をSQLiteへ保存する。
- 動画配信はHTTP Rangeに対応する。バックアップ・移行時はSQLiteファイルだけでなく`uploads/`も一緒にコピーする。
- 現状は添付単体の削除、複数添付、動画圧縮、サムネイル生成、容量の自動清掃を実装していない。

## モバイル通知（Web Pushプロトタイプ）

- ログイン後、アカウント欄のベルを押すと、その端末の通知をオン／オフにできる。
- Android/PCの対応ブラウザでは、HTTPSの公開URLを開いてベルを押し、ブラウザの通知確認を許可する。
- iPhone/iPadではiOS/iPadOS 16.4以降が必要。Safariの共有メニューから「ホーム画面に追加」し、追加したChat Labの
  アイコンから起動してベルを押す。Safariの通常タブでベルを押した場合は、ホーム画面追加の案内を表示する。
- 通常メッセージ、独立スレッド作成、独立スレッド返信を通知する。アプリがその端末で表示中ならOS通知は出さない。
- 送信したアカウント自身の購読先は配送対象から外す。通知確認はPCとスマホを**別アカウント**にし、片方で通知をオン、
  もう片方から投稿して行う。同一アカウントでのリアルタイム同期・遅延確認はできるが、自己通知は届かない。
- 通知を選ぶと該当チャンネル／スレッドを開く。明示的なログアウトでは、その端末の通知購読も解除する。
- VAPID鍵は初回起動時に生成してSQLiteの`app_config`へ保存する。DBを失うと既存端末へ配信できなくなるため、
  バックアップ・移行時はDBを維持する。
- 現段階では全メッセージ通知のみ。メンション限定、チャンネル別設定、通知時間帯、未読数バッジ、配達保証は未実装。

実機確認では、スマホで通知をオンにした後、Chat Labを閉じるかバックグラウンドへ移し、別アカウントのPCから投稿する。
通知がロック画面／通知センターに届くことと、選択時に該当画面が開くことを確認する。

### DB_PATH は CWD 基準、静的アセットはモジュール基準（非対称に注意）

- `staticDir`（`public/` の同梱アセット、読み取り専用）は `src/server.js` の**モジュール自身の場所からの相対パス**で解決するため、
  どの CWD から起動しても同じ `public/` を確実に見つける。
- 一方 `DB_PATH`（書き込みが発生する可変データ）は**起動時の CWD 基準の相対パス**のままにしている。
  これは意図的な非対称（読み取り専用アセット vs 書き込みデータで基準を分けている）。
- `npm start` をプロジェクトルートで実行する分には問題にならないが、**systemd 経由で起動する場合は
  unit の `WorkingDirectory` が実際の DB 保存先を決める**ので注意する（`deploy/chat-app.service` 参照）。
- 本番環境では `DB_PATH` に**絶対パスを指定することを推奨**する（CWD に依存しない確実な保存先になるため）。

## 起動

```bash
npm start
```

`package.json` の `start` スクリプトは `node --env-file-if-exists=.env src/server.js`。`.env` が無くても
エラーにならず既定値で起動する（Node 22.9+ 標準の `--env-file-if-exists` フラグ）。

## テスト

```bash
npm test
```

`node --test` で `tests/*.test.js` を実行する。

## Git・GitHub保護

このcloneではバージョン管理されたGit hooksを次の設定で有効化している。新しくcloneした端末でも一度実行する。

```bash
git config core.hooksPath .githooks
```

- `pre-commit`: 差分の空白エラーを検査し、`.env`、DB、アップロード本体などローカルデータの誤コミットを拒否する。
- `pre-push`: `npm test`を全件実行し、ref削除とnon-fast-forward pushを拒否する。
- GitHubの`main`ブランチ保護: force pushとブランチ削除を管理者にも禁止する。

commit/pushのタイミングはAIが変更のまとまりを見て判断する。機能・修正の完成、テスト成功、別作業への切り替えなどを
自然なチェックポイントとし、毎ターンの細かい履歴は作らない。履歴変更は原則禁止とし、必要な場合はユーザーの明示承認後に
ローカルhookとGitHub側の保護を一時変更し、作業直後に保護を戻す。`--no-verify`による回避は行わない。

## `.env` の読み込みと優先順位

起動経路（`npm start` と systemd）で `.env` の扱いが異なるので、それぞれ分けて説明する。

### `npm start`（`node --env-file-if-exists=.env`）の場合

`node --env-file` / `--env-file-if-exists` は、**既に OS 側で設定済みの環境変数を上書きしない**。
`.env` はあくまで「未設定の変数だけを補完する」ものである。以下のコマンドで実際に確認した：

```bash
$ echo "FOO=b" > .env
$ FOO=a node --env-file=.env -e "console.log(process.env.FOO)"
a
```

OS 側で `FOO=a` を export した状態で `.env` に `FOO=b` と書いても、`process.env.FOO` は `a`（OS 側の値）のまま
になり、`.env` の値では上書きされない。

優先順位: **OS 環境変数 > `.env` ファイル > コード内既定値**。

### systemd（`EnvironmentFile=`）の場合

systemd サービスは対話シェルの環境を**継承しない**（`PATH` 等の最小限を除く）。この unit では
`EnvironmentFile=-__INSTALL_DIR__/.env` がサービス実行環境への設定注入の実質的な唯一の入口になる。
`node --env-file` の「未設定のみ補完」とは仕組みが異なるので、同一視しないこと。

- unit 内では `Environment=` と `EnvironmentFile=` が**記述順に評価され、後に評価された定義が前を上書きする**。
- 特定の変数だけ `.env` と別の値にしたい場合は、drop-in で `EnvironmentFile=` より後に `Environment=` を置く：

  ```bash
  sudo systemctl edit chat-app
  # 追記（EnvironmentFile より後に評価されるため .env の値を上書きできる）:
  #   [Service]
  #   Environment=PORT=8080
  ```

優先順位（この unit）: **`EnvironmentFile=` より後の `Environment=`（drop-in 含む）> `.env`（EnvironmentFile）> コード内既定値**。

## systemd 常駐（gen8 での運用）

1. インストール先ディレクトリにリポジトリを配置し、`npm install` する。
2. `.env` を用意する（`cp .env.example .env` して編集。無くても既定値で動く）。
3. `deploy/chat-app.service` のプレースホルダを実値に置換して配置する：

   ```bash
   sudo sed \
     -e "s|__INSTALL_DIR__|/opt/chat-app|g" \
     -e "s|__NODE_BIN__|$(which node)|g" \
     deploy/chat-app.service | sudo tee /etc/systemd/system/chat-app.service
   ```

   （`__INSTALL_DIR__` は実際のインストール先ディレクトリ、`__NODE_BIN__` は `which node` で得られる
   Node 実行ファイルの絶対パスに置き換える。）

4. 有効化・起動する：

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable chat-app
   sudo systemctl start chat-app
   ```

5. AI巡回unitの3つのプレースホルダを置換し、タイマーを有効化する。

   ```bash
   sudo sed -e "s|__INSTALL_DIR__|/opt/chat-app|g" \
     -e "s|__NODE_BIN__|$(which node)|g" \
     -e "s|__CLAUDE_HOME__|$HOME|g" \
     deploy/chat-app-moderation.service | sudo tee /etc/systemd/system/chat-app-moderation.service
   sudo cp deploy/chat-app-moderation.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now chat-app-moderation.timer
   sudo systemctl start chat-app-moderation.service
   ```

5. ログを確認する：

   ```bash
   journalctl -u chat-app -f
   ```

`Restart=always` により、プロセスが落ちても自動再起動する。`WantedBy=multi-user.target` により、マシン再起動後も
自動で起動する。`EnvironmentFile=-__INSTALL_DIR__/.env`（先頭 `-`）により、`.env` が存在しなくてもサービス起動は
失敗せず既定値で立ち上がる。

## Tailscale Funnel で半公開する

Tailscale Funnel は公開 HTTPS を gen8 上で終端し、ローカルの chat-app へ転送する。Funnel 自体にはアプリ利用者向けの
認証がないため、公開前にアプリ側の Basic 認証を必ず有効にする。この gen8 では 3000 番を別サービスが使用しているため、
chat-app は 3002 番を使う。

1. `.env` を次の形にする。パスワードには十分長いランダム値を使う（例: `openssl rand -hex 32`）。

   ```env
   PORT=3002
   HOST=127.0.0.1
   BASIC_AUTH_USER=chat
   BASIC_AUTH_PASSWORD=<十分長いランダム値>
   ```

   `HOST=127.0.0.1` はFunnel専用運用の必須設定とし、LANからアプリのHTTPポートへ直接到達できないようにする。

2. サービスを有効化・起動し、まずループバックで認証を確認する。

   ```bash
   sudo systemctl enable --now chat-app
   curl -i http://127.0.0.1:3002/                    # 401 + WWW-Authenticate
   curl -i -u 'chat:<パスワード>' http://127.0.0.1:3002/ # 200
   ```

3. 公開443番をローカル3002番へ転送する。`--bg` により、再起動後もTailscaleが設定を復元する。

   ```bash
   sudo tailscale funnel --bg --https=443 http://127.0.0.1:3002
   tailscale funnel status
   ```

4. 表示された `https://<machine>.<tailnet>.ts.net/` を iPhone Safari と Chrome 系ブラウザで開き、Basic認証後に
   チャットの送受信まで確認する。特に DevTools の Network で WebSocket upgrade が `101` になることを確認する。
   どちらかで認証済みWebSocketが接続できない場合は公開を止め、セッションCookie方式を別途設計する。

公開を止める場合は `sudo tailscale funnel --https=443 off`、Funnel設定をすべて消す場合は
`sudo tailscale funnel reset` を使う。Funnelの公開ポートは443/8443/10000に限られる。Basic認証自体には個別アカウントや
レート制限がないため、これは強い共有パスワードを知る利用者向けの半公開運用とする。アプリ内では別途アカウントログインと
ログアウトを使用する。

## 綾瀬サーバーへの移行手順

将来 gen8 から綾瀬サーバーへ移行する際は、以下の手順を想定している（コード側の変更は不要な設計にしてある）。

1. 綾瀬サーバーにリポジトリを配置し、`npm install` する（Node >= 22.22.3 が入っていることを確認）。
2. `.env` を綾瀬サーバー用の値（`PORT` / `HOST` / `DB_PATH` / Basic 認証2変数）で作成する。
   `DB_PATH` は本番運用のため絶対パス指定を推奨。
3. gen8 上の DB（`DB_PATH` が指すファイル）を綾瀬サーバーの新しい `DB_PATH` にコピーする（SQLite は単一ファイルの
   ためファイルコピーのみで移行できる）。
4. `deploy/chat-app.service` を綾瀬サーバー用の `__INSTALL_DIR__` / `__NODE_BIN__` で置換し、systemd に登録する
   （上記「systemd 常駐」の手順と同じ）。
5. 綾瀬サーバー側で `systemctl start chat-app` し、動作確認後、gen8 側の systemd unit を無効化する。

パス・ポート等はすべて `.env` で注入する設計にしているため、コード変更なしで移行できる。

## アセット方針（依存ゼロ・ビルドレス）

`public/` 配下の HTML/CSS/JS はビルドツール・バンドラ・minifier を経由せず、そのまま配信する。CSS フレームワークも
導入しない。低スペック環境（gen8・シンクライアント想定）でのパース負荷とデプロイの単純さを優先し、アセット圧縮は
「依存ゼロ・ビルドレスを維持する」ことで担保する方針とする（ビルド工程を増やさない）。
