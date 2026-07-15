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

`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` は HTTP の静的ファイル配信と WebSocket upgrade の両方を保護する。
両方未設定（空・空白のみを含む）なら従来どおり認証なしで動作する。片方のみの設定は設定ミスとして fail-fast する。
Basic認証は公開URLの共有入口であり、アプリ内アカウントとは別の認証である。

## アカウントと権限

- ログイン画面の「登録」からユーザー名と8文字以上のパスワードを登録する。
- DB上で最初に登録したアカウントが `owner`、以降は `member` になる。
- `owner` はメンバー一覧から他アカウントを `admin` / `member` に変更できる。
- `owner` と `admin` はチャンネルを作成・削除できる。旧 `ADMIN_PASSWORD` / `admin_auth` は廃止済み。
- セッションはブラウザとDBに30日間保存する。同じアカウントをPC・スマホの両方で利用できる。
- 既存のニックネームと同名で初回登録すると、そのユーザー行をアカウントとして引き継ぐ。
- 自分のアカウント欄にある編集ボタンから、表示名、160文字以内の自己紹介、5MB以下のアイコン画像を設定できる。
- メンバー一覧を選ぶとプロフィールカードを閲覧できる。メンションには変更できない`@ユーザー名`を使い、表示名とは分ける。
- アイコンと表示名は、既存の過去メッセージにも現在のプロフィールとして反映する。

## メッセージの編集と削除

- `member`は自分のメッセージだけを編集・削除できる。`owner`と`admin`は全員のメッセージを操作できる。
- 通常チャンネルと独立スレッドの投稿が対象。権限はWebSocket API側でも検証する。
- PCではメッセージへポインターを重ね、スマホでは長押しして操作メニューを開く。
- 編集後は本文に「（編集済み）」と表示し、表示へポインターを重ねると編集日時を確認できる。
- 添付付きメッセージを編集しても添付は維持する。削除した添付ファイル本体の自動清掃は現状行わない。

## 写真・動画・ファイル添付

- メッセージ入力欄の「＋」から、スマホ・PCの写真、動画、一般ファイルを1件選択できる。
- 1ファイルの上限は100MB。アップロード進捗と失敗理由を入力欄の上に表示する。
- 写真はインライン画像、動画はブラウザ標準プレイヤー、その他はダウンロード可能なファイルカードとして表示する。
- ファイル本体は`DB_PATH`と同じディレクトリの`uploads/`へ保存し、メタデータとメッセージ参照をSQLiteへ保存する。
- 動画配信はHTTP Rangeに対応する。バックアップ・移行時はSQLiteファイルだけでなく`uploads/`も一緒にコピーする。
- 現状は添付単体の削除、複数添付、動画圧縮、サムネイル生成、容量の自動清掃を実装していない。

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
