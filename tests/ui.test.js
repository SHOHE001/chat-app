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

test('UI05 mobile safe area: iPhoneの上端を避け、主要操作を44pxで確保する', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /height: calc\(48px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(css, /\.mobile-button \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /--app-height: 100dvh/);
  assert.match(css, /env\(safe-area-inset-left, 0px\)/);
  assert.match(css, /env\(safe-area-inset-right, 0px\)/);
});

test('UI06 visual viewport: 端末・回転・キーボードに合わせて表示可能高さへ追従する', () => {
  assert.match(css, /height: var\(--app-height\)/);
  assert.match(app, /window\.visualViewport\?\.height \|\| window\.innerHeight/);
  assert.match(app, /style\.setProperty\('--app-height'/);
  assert.match(app, /window\.addEventListener\('orientationchange', syncAppViewportHeight\)/);
  assert.match(app, /window\.visualViewport\?\.addEventListener\('resize', syncAppViewportHeight\)/);
  assert.match(css, /html, body \{ background: var\(--chat\); \}/);
});

test('UI07 members overlay: チャット背景タップと画面幅変更でメンバー一覧を閉じる', () => {
  assert.match(html, /id="members-toggle"[^>]*aria-controls="members"[^>]*aria-expanded="false"/);
  assert.match(html, /id="members-scrim" class="scrim hidden"/);
  assert.match(app, /membersScrim\.addEventListener\('click', closeMembers\)/);
  assert.match(app, /membersPanel\.classList\.toggle\('open', open\)/);
  assert.match(app, /membersToggle\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(app, /mobilePanelsMedia\.addEventListener\('change'/);
});

test('UI08 mobile swipe: 横方向優先のスワイプだけで左右パネルを開閉する', () => {
  assert.match(css, /\.chat-column \{[^}]*touch-action: pan-y pinch-zoom;/);
  assert.match(app, /Math\.abs\(deltaX\) < 64/);
  assert.match(app, /Math\.abs\(deltaX\) <= Math\.abs\(deltaY\) \* 1\.25/);
  assert.match(app, /if \(deltaX > 0\) openNav\(\);\s*else setMembersOpen\(true\);/);
  assert.match(app, /surface\.addEventListener\('touchstart', handlePanelSwipeStart/);
  assert.match(app, /surface\.addEventListener\('touchend', handlePanelSwipeEnd/);
  assert.match(app, /surface\.addEventListener\('touchcancel', cancelPanelSwipe/);
  assert.match(app, /target\.closest\('input, textarea, button, select, a, video, audio, dialog/);
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
