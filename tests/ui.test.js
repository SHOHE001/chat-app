import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, app, serviceWorker, manifest] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
]);

test('UI01 message delete: ブラウザconfirmではなくアプリ内dialogを使う', () => {
  assert.match(html, /<dialog id="delete-message-dialog"/);
  assert.match(html, /id="delete-message-preview"/);
  assert.match(app, /openDeleteMessage\(message, kind\)/);
  assert.doesNotMatch(app, /confirm\('このメッセージを削除しますか？'\)/);
  assert.match(app, /send\('delete_message', \{ messageId: deletingTarget\.messageId \}\)/);
  assert.match(app, /send\('delete_thread_message'/);
});

test('UI03 Web Push: PWA導線、通知購読、受信クリックを備える', () => {
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /id="notification-button"/);
  assert.match(app, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(app, /Notification\.requestPermission\(\)/);
  assert.match(app, /pushManager\.subscribe/);
  assert.ok(app.indexOf('isIosDevice() && !isStandaloneApp()') < app.indexOf("showToast('このブラウザはWeb Push通知に対応していません。')"));
  assert.match(app, /\/api\/push\/subscription/);
  assert.match(serviceWorker, /addEventListener\('push'/);
  assert.match(serviceWorker, /addEventListener\('notificationclick'/);
  assert.equal(JSON.parse(manifest).display, 'standalone');
});

test('UI04 auth: オーナー決定ルールをログイン画面へ表示しない', () => {
  assert.doesNotMatch(html, /最初に登録したアカウントがオーナーになります/);
  assert.doesNotMatch(html, /class="auth-note"/);
});

test('UI02 composer mention: textareaを維持して既存ユーザーのmentionを水色表示する', () => {
  assert.match(html, /id="mention-highlight" class="composer-highlight"/);
  assert.match(html, /id="message-input"/);
  assert.match(css, /\.composer-highlight-mention \{ color: #62c9ff;/);
  assert.match(css, /\.highlight-enabled textarea[^}]+caret-color/);
  assert.match(app, /names\.has\(username\)/);
  assert.match(app, /mention\.className = 'composer-highlight-mention'/);
  assert.match(app, /messageInput\.addEventListener\('scroll'/);
});
