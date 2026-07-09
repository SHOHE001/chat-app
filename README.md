# chat-app

チャットアプリのプロジェクト。

## 概要

ニックネーム参加＋複数ルーム＋ルーム内スレッド返信に対応した、依存ゼロ・ビルドレスのリアルタイムチャット MVP。
HTTP 静的配信と WebSocket を同一ポートで相乗りさせ、SQLite（`node:sqlite`）に永続化する。gen8（Ubuntu Server）で
systemd 常駐運用し、将来的に綾瀬サーバーへ移行することを見据えて、環境依存の値（ポート・DB パス・管理者合言葉等）は
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
| `ADMIN_PASSWORD` | 未設定 | 管理者昇格の合言葉。未設定または空文字は「管理者機能が無効」として扱う（既存の `admin_auth` → `admin_disabled` 挙動と一致）。 |

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

## 綾瀬サーバーへの移行手順

将来 gen8 から綾瀬サーバーへ移行する際は、以下の手順を想定している（コード側の変更は不要な設計にしてある）。

1. 綾瀬サーバーにリポジトリを配置し、`npm install` する（Node >= 22.22.3 が入っていることを確認）。
2. `.env` を綾瀬サーバー用の値（`PORT` / `HOST` / `DB_PATH` / `ADMIN_PASSWORD`）で作成する。
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
