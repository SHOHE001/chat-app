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
  assert.match(app, /'hide_message' : 'delete_message'/);
  assert.match(app, /'hide_thread_message' : 'delete_thread_message'/);
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
  assert.match(app, /const viewport = window\.visualViewport/);
  assert.match(app, /viewport\?\.height \|\| window\.innerHeight/);
  assert.match(app, /style\.setProperty\('--app-height'/);
  assert.match(app, /style\.setProperty\('--app-top'/);
  assert.match(app, /viewport\?\.offsetTop \|\| 0/);
  assert.match(app, /classList\.toggle\('keyboard-open'/);
  assert.match(app, /window\.addEventListener\('orientationchange', syncAppViewportHeight\)/);
  assert.match(app, /window\.visualViewport\?\.addEventListener\('resize', syncAppViewportHeight\)/);
  assert.match(css, /html, body \{ background: var\(--chat\); \}/);
  assert.match(app, /window\.visualViewport\?\.addEventListener\('scroll', syncAppViewportHeight\)/);
  assert.match(css, /top: var\(--app-top\)/);
  assert.match(css, /\.keyboard-open \.composer-wrap \{ padding-bottom: 6px; \}/);
});

test('UI20 desktop responsive: PC幅に応じてカラム・余白・本文幅・メディアを可変にする', () => {
  assert.match(css, /--nav-width: clamp\(220px, 15vw, 280px\)/);
  assert.match(css, /--members-width: clamp\(220px, 16vw, 300px\)/);
  assert.match(css, /--content-gutter: clamp\(12px, 1\.25vw, 24px\)/);
  assert.match(css, /grid-template-columns: var\(--nav-width\) minmax\(0, 1fr\) var\(--members-width\)/);
  assert.doesNotMatch(css, /grid-template-columns: 240px minmax\(0, 1fr\) 240px/);
  assert.match(css, /\.message \{[^}]*width: min\(100%, var\(--chat-content-max\)\)/);
  assert.match(css, /\.composer-wrap \{[^}]*width: min\(100%, var\(--chat-content-max\)\)/);
  assert.match(css, /\.message-attachment \{ max-width: min\(42vw, 720px, 100%\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.message-attachment \{ max-width: 100%; \}/);
  assert.match(css, /dialog \{[^}]*max-height: calc\(var\(--app-height\) - 32px\)/);
});

test('UI17 mobile ergonomics: コピー・送信操作と各パネルの縦スクロールを維持する', () => {
  assert.match(app, /copy\.textContent = 'コピー'/);
  assert.match(css, /\.chat-column \{[^}]*min-height: 0;/);
  assert.match(css, /\.message-list \{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(css, /\.nav-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\.members-panel \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\.thread-messages \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(app, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /row\.addEventListener\('contextmenu', cancel\)/);
  assert.match(css, /\.message-body \{[^}]*-webkit-user-select: text;/);
  assert.match(css, /\.send-button \{[^}]*width: 42px;[^}]*margin-right: 4px;[^}]*font-size: 24px;[^}]*translateX\(-2px\)/);
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

test('UI09 account ban: 権限に応じたBAN操作と期間選択、解除表示を備える', () => {
  assert.match(html, /<dialog id="ban-user-dialog"/);
  for (const duration of ['10m', '1h', '24h', '7d', '30d', 'permanent']) {
    assert.match(html, new RegExp(`option value="${duration}"`));
  }
  assert.match(app, /me\.role === 'admin' && user\.role === 'member'/);
  assert.match(app, /send\('ban_user'/);
  assert.match(app, /send\('unban_user'/);
  assert.match(app, /reason === 'account_banned'/);
  assert.match(css, /\.member-ban-button/);
});

test('UI10 registration QR: 管理者用生成ダイアログと登録画面直リンクを備える', () => {
  assert.match(html, /id="registration-qr-button"[^>]*class="icon-button hidden"/);
  assert.match(html, /<dialog id="registration-qr-dialog"/);
  assert.match(html, /id="registration-qr-refresh"/);
  assert.match(html, /id="registration-qr-expiry"/);
  assert.match(html, /id="registration-url-copy"/);
  assert.match(html, /id="registration-qr-save"/);
  assert.match(app, /launchParams\.get\('register'\) === '1' && Boolean\(registrationInvite\)/);
  assert.match(app, /setAuthMode\('register'\)/);
  assert.match(app, /\/api\/registration-qr\?origin=/);
  assert.match(app, /method: 'POST'/);
  assert.match(app, /fetch\('\/api\/registration-policy'\)/);
  assert.match(app, /invite: registrationInvite/);
  assert.match(app, /setInterval\(renderRegistrationQrExpiry, 1000\)/);
  assert.match(app, /registrationUrlInput\.value = result\.registrationUrl/);
  assert.match(app, /link\.download = 'chat-lab-registration-qr\.png'/);
  assert.match(app, /registration-qr-button'\)\.classList\.toggle\('hidden', !\['owner', 'admin'\]/);
  assert.match(css, /\.registration-qr-image/);
  assert.match(css, /\.registration-qr-expiry\.expired/);
});

test('UI11 navigation polish: ログアウト確認、明確なメンバーアイコン、復帰可能なチャンネル作成を備える', () => {
  assert.match(html, /<div class="workspace-title">Chat Lab<\/div>/);
  assert.doesNotMatch(html, /<div class="workspace-title">[^<]*<span>⌄<\/span>/);
  assert.match(html, /id="members-toggle"[^>]*aria-label="メンバー一覧を表示"[^>]*><svg/);
  assert.doesNotMatch(html, /id="members-toggle"[^>]*>♟<\/button>/);
  assert.match(html, /id="connection-status" class="connection-status hidden"[^>]*role="status"/);
  assert.match(app, /el\.classList\.toggle\('hidden', online\)/);

  assert.match(html, /<dialog id="logout-dialog"/);
  assert.match(app, /logoutDialog\.showModal\(\)/);
  assert.match(app, /'logout-confirm'\)\.addEventListener\('click'/);
  assert.match(app, /send\('logout'\)/);

  assert.match(html, /id="room-create-close" type="button"/);
  assert.match(html, /id="room-create-cancel" type="button"/);
  assert.match(app, /'room-create-close'\)\.addEventListener\('click', closeCreateRoomDialog\)/);
  assert.match(app, /'room-create-cancel'\)\.addEventListener\('click', closeCreateRoomDialog\)/);
  assert.match(app, /createRoomDialog\.addEventListener\('cancel'/);
  assert.doesNotMatch(app, /event\.submitter\?\.value === 'cancel'[\s\S]{0,160}createRoomDialog\.close\(\)/);
  assert.match(css, /\.members-button svg \{[^}]*width: 24px;[^}]*height: 24px;/);
});

test('UI12 reports: 理由選択・自由記述・全投稿の通報・管理者一覧を備える', () => {
  assert.match(html, /<dialog id="report-message-dialog"/);
  assert.match(html, /id="report-category"/);
  for (const category of ['harassment', 'personal_info', 'scary_media', 'spam', 'other']) {
    assert.match(html, new RegExp(`option value="${category}"`));
  }
  assert.match(html, /id="report-details"[^>]*maxlength="2000"/);
  assert.match(html, /id="report-inbox-button" class="icon-button hidden"/);
  assert.match(html, /<dialog id="report-inbox-dialog"/);
  assert.match(app, /openReportMessage\(message, kind\)/);
  assert.match(app, /send\('report_message'/);
  assert.match(app, /send\('get_reports'\)/);
  assert.match(app, /report\.ai_status === 'pending'/);
  assert.match(app, /'report-inbox-button'\)\.classList\.toggle\('hidden', !\['owner', 'admin'\]/);
  assert.match(css, /\.message-manage-action\.report/);
  assert.match(css, /\.report-card/);
});

test('UI13 moderator hide: owner/adminにDB保持の非表示操作を表示する', () => {
  assert.match(app, /hide\.textContent = '非表示'/);
  assert.match(app, /openHideMessage\(message, kind\)/);
  assert.match(app, /hide_thread_message/);
  assert.match(app, /hide_message/);
  assert.match(html, /id="delete-message-description"/);
});

test('UI15 restricted rooms: 作成時に属性ロールを選択し限定チャンネルを識別できる', () => {
  assert.doesNotMatch(html, /name="room-access-role" value="member"/);
  for (const role of ['adult', 'child', 'staff']) {
    assert.match(html, new RegExp(`name="room-access-role" value="${role}"`));
  }
  assert.match(app, /querySelectorAll\('input\[name="room-access-role"\]:checked'\)/);
  assert.match(app, /send\('create_room', \{ name, allowedRoles \}\)/);
  assert.match(app, /room\.allowedRoles\?\.length/);
  assert.match(css, /\.channel-lock/);
  assert.match(css, /\.room-access-grid/);
});

test('UI16 room notifications: チャンネルごとのベルで通知をオンオフできる', () => {
  assert.match(app, /room-notification-toggle/);
  assert.match(app, /room\.notificationsEnabled === false \? '🔕' : '🔔'/);
  assert.match(app, /send\('set_room_notification'/);
  assert.ok(app.includes('enabled: room.notificationsEnabled === false'));
  assert.ok(css.includes('.room-notification-toggle.muted {'));
  assert.ok(css.includes('@media (max-width: 700px)'));
});

test('UI14 profile roles: 属性ロールをプロフィール内でオーナーだけが変更する', () => {
  for (const [role, label] of [['adult', '大人'], ['child', '子供'], ['staff', 'スタッフ']]) {
    assert.match(app, new RegExp(`${role}: '${label}'`));
  }
  assert.match(html, /id="profile-role-editor" class="profile-role-editor hidden"/);
  assert.match(html, /name="profile-role-edit" value="adult"/);
  assert.ok(app.includes("const canEdit = me?.role === 'owner' && user?.role !== 'owner'"));
  assert.ok(app.includes("send('set_profile_roles', { userId: user.id, roles })"));
  assert.doesNotMatch(app, /roleControls/);
  assert.ok(css.includes('.profile-role-editor {'));
  assert.ok(css.includes('.profile-role-badge {'));
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

test('UI18 message reply: 長押しメニューから返信し、参照表示と取り消しができる', () => {
  assert.match(html, /id="reply-preview" class="composer-reply hidden"/);
  assert.match(html, /id="reply-cancel"/);
  assert.match(app, /reply\.textContent = '返信'/);
  assert.match(app, /replyToId: replyingTo\?\.id/);
  assert.match(app, /function makeReplyReference\(message\)/);
  assert.match(app, /返信先のメッセージは表示できません/);
  assert.match(css, /\.message-reply-reference/);
  assert.match(css, /\.composer-reply/);
});

test('UI19 announcements: 専用アイコンと一般ユーザー向け読み取り専用表示を備える', () => {
  assert.match(app, /room\.kind === 'announcement' \? '📢' : '#'/);
  assert.match(app, /お知らせは管理者のみ投稿できます/);
  assert.match(app, /room\.kind !== 'announcement'/);
  assert.match(app, /アプリの更新内容や運営からのお知らせを掲載します/);
  assert.match(app, /announcement_read_only/);
});
test('UI21 profile avatars: 自分・メンバー・投稿・スレッドのアイコンからプロフィールを表示する', () => {
  assert.ok(html.includes('id="my-avatar" class="avatar small profile-trigger" type="button"'));
  assert.ok(app.includes('function makeProfileAvatar(user, small = false)'));
  assert.ok(app.includes('item.append(makeProfileAvatar(user, true))'));
  assert.ok(app.includes('messageUser ? makeProfileAvatar(messageUser) : makeAvatar(message.author)'));
  assert.ok(app.includes("$('my-avatar').addEventListener('click', () => openProfile(me, false))"));
  assert.ok(css.includes(".profile-trigger { padding: 0; border: 0; cursor: pointer; }"));
});
test('UI22 reaction members: リアクション長押しで付与したメンバー一覧を表示する', () => {
  assert.match(html, /id="reaction-users-dialog"/);
  assert.ok(app.includes('function installReactionLongPress(chip, reaction)'));
  assert.ok(app.includes('openReactionUsers(reaction)'));
  assert.ok(app.includes('for (const userId of reaction.userIds || [])'));
  assert.ok(app.includes("send('toggle_reaction', { messageId, emoji: reaction.emoji })"));
  assert.ok(css.includes('.reaction-users-list {'));
});
