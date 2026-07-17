(() => {
  'use strict';

  const SESSION_KEY = 'chat-app:session';
  const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀'];
  const SAFE_RASTER_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
  ]);
  const SAFE_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
  const $ = (id) => document.getElementById(id);

  const authScreen = $('auth-screen');
  const authForm = $('auth-form');
  const authTitle = $('auth-title');
  const authDescription = $('auth-description');
  const usernameInput = $('username-input');
  const passwordInput = $('password-input');
  const authError = $('auth-error');
  const authSubmit = $('auth-submit');
  const authModeToggle = $('auth-mode-toggle');
  const authSwitch = $('auth-switch');
  const authSwitchLabel = $('auth-switch-label');
  const appEl = $('app');
  const chatColumn = document.querySelector('.chat-column');
  const nav = $('nav');
  const navScrim = $('nav-scrim');
  const roomList = $('room-list');
  const threadList = $('thread-list');
  const messageList = $('message-list');
  const messageForm = $('message-form');
  const messageInput = $('message-input');
  const composerInputShell = $('composer-input-shell');
  const mentionHighlight = $('mention-highlight');
  const fileInput = $('file-input');
  const attachButton = $('attach-button');
  const uploadPanel = $('upload-panel');
  const notificationButton = $('notification-button');
  const mentionMenu = $('mention-menu');
  const replyPreview = $('reply-preview');
  const replyAuthor = $('reply-author');
  const replyBody = $('reply-body');
  const membersPanel = $('members');
  const membersScrim = $('members-scrim');
  const membersToggle = $('members-toggle');
  const memberList = $('member-list');
  const threadPanel = $('thread-panel');
  const threadScrim = $('thread-scrim');
  const threadMessages = $('thread-messages');
  const threadReplyForm = $('thread-reply-form');
  const threadReplyInput = $('thread-reply-input');
  const createThreadDialog = $('create-thread-dialog');
  const createRoomDialog = $('create-room-dialog');
  const logoutDialog = $('logout-dialog');
  const profileDialog = $('profile-dialog');
  const profileAvatarInput = $('profile-avatar-input');
  const editMessageDialog = $('edit-message-dialog');
  const editMessageInput = $('edit-message-input');
  const deleteMessageDialog = $('delete-message-dialog');
  const reportMessageDialog = $('report-message-dialog');
  const reportInboxDialog = $('report-inbox-dialog');
  const banUserDialog = $('ban-user-dialog');
  const registrationQrDialog = $('registration-qr-dialog');
  const registrationQrImage = $('registration-qr-image');
  const registrationUrlInput = $('registration-url');

  let ws;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let authMode = 'login';
  let pendingAuth = false;
  let me = null;
  let rooms = [];
  let users = [];
  let threads = [];
  let messages = [];
  let currentRoomId = null;
  let openThread = null;
  let openThreadMessages = [];
  let toastTimer;
  let pendingAttachment = null;
  let uploadRequest = null;
  let profileAvatarId = null;
  let profileUploadRequest = null;
  let editingTarget = null;
  let deletingTarget = null;
  let reportingTarget = null;
  let reports = [];
  let banningTarget = null;
  let replyingTo = null;
  let registrationQrExpiresAt = 0;
  let registrationQrTimer = null;
  let serviceWorkerRegistration = null;
  let notificationSetupPromise = null;
  let swipeStart = null;
  const mobilePanelsMedia = window.matchMedia('(max-width: 980px)');
  const launchParams = new URLSearchParams(location.search);
  let registrationInvite = launchParams.get('invite') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(registrationInvite)) registrationInvite = '';
  let registrationLaunch = launchParams.get('register') === '1' && Boolean(registrationInvite);
  const invalidRegistrationLaunch = launchParams.get('register') === '1' && !registrationInvite;
  let notificationLaunch = {
    roomId: Number(launchParams.get('room')) || null,
    threadId: Number(launchParams.get('thread')) || null,
  };
  if (!notificationLaunch.roomId && !notificationLaunch.threadId) notificationLaunch = null;

  function socketUrl() {
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/`;
  }

  let viewportSyncFrame = null;
  function syncAppViewportHeight() {
    if (viewportSyncFrame !== null) cancelAnimationFrame(viewportSyncFrame);
    viewportSyncFrame = requestAnimationFrame(() => {
      viewportSyncFrame = null;
      const viewport = window.visualViewport;
      const height = viewport?.height || window.innerHeight;
      const offsetTop = viewport?.offsetTop || 0;
      if (height > 0) document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
      document.documentElement.style.setProperty('--app-top', `${Math.max(0, Math.round(offsetTop))}px`);
      document.documentElement.classList.toggle('keyboard-open', Boolean(viewport && window.innerHeight - height > 120));
    });
  }

  function send(type, payload = {}) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  function avatarHue(name) {
    let hash = 0;
    for (const char of name || '?') hash = (hash * 31 + char.codePointAt(0)) % 360;
    return hash;
  }

  function makeAvatar(name, small = false, avatarUrl = null) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar' + (small ? ' small' : '');
    avatar.style.setProperty('--avatar-hue', avatarHue(name));
    setAvatar(avatar, name, avatarUrl);
    return avatar;
  }

  function makeProfileAvatar(user, small = false) {
    const avatar = document.createElement('button');
    avatar.type = 'button';
    avatar.className = 'avatar profile-trigger' + (small ? ' small' : '');
    avatar.style.setProperty('--avatar-hue', avatarHue(user.username));
    avatar.setAttribute('aria-label', accountName(user) + 'のプロフィールを表示');
    setAvatar(avatar, user.username, user.avatar?.url);
    avatar.addEventListener('click', (event) => {
      event.stopPropagation();
      openProfile(user, false);
    });
    return avatar;
  }

  function setAvatar(element, name, avatarUrl = null) {
    element.style.setProperty('--avatar-hue', avatarHue(name));
    element.style.backgroundImage = avatarUrl ? `url("${avatarUrl}")` : '';
    element.style.backgroundPosition = avatarUrl ? 'center' : '';
    element.style.backgroundSize = avatarUrl ? 'cover' : '';
    element.textContent = avatarUrl ? '' : Array.from(name || '?')[0].toUpperCase();
  }

  function accountName(user) {
    return user?.display_name || user?.username || '';
  }

  function userForMessage(message) {
    return users.find((user) => user.id === message.author_user_id)
      || users.find((user) => user.username === message.author);
  }

  function formatRole(role) {
    return {
      owner: 'オーナー',
      admin: '管理者',
      member: 'メンバー',
      adult: '大人',
      child: '子供',
      staff: 'スタッフ',
    }[role] || role;
  }

  const profileRoleValues = ['adult', 'child', 'staff'];

  function profileRoles(user) {
    return user?.profile_roles || [];
  }

  function makeRoleBadges(user) {
    const badges = document.createElement('span');
    badges.className = 'profile-role-badges';
    for (const value of profileRoles(user)) {
      const badge = document.createElement('span');
      badge.className = `profile-role-badge role-${value}`;
      badge.textContent = formatRole(value);
      badges.append(badge);
    }
    return badges;
  }

  function showToast(text) {
    const toast = $('toast');
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
  }

  function setConnection(online, text = online ? '' : '再接続中…') {
    const el = $('connection-status');
    el.textContent = text;
    el.classList.toggle('hidden', online);
    el.classList.toggle('online', online);
  }

  function closeCreateRoomDialog() {
    $('create-room-form').reset();
    $('room-create-error').textContent = '';
    if (createRoomDialog.open) createRoomDialog.close();
  }

  function closeLogoutDialog() {
    if (logoutDialog.open) logoutDialog.close();
  }

  async function confirmLogout() {
    const button = $('logout-confirm');
    button.disabled = true;
    button.textContent = 'ログアウト中…';
    try { await disableNotifications(true); } catch { /* ログアウト自体は続ける */ }
    const sent = send('logout');
    localStorage.removeItem(SESSION_KEY);
    closeLogoutDialog();
    button.disabled = false;
    button.textContent = 'ログアウト';
    if (!sent) showAuth();
  }

  function handleNotificationLaunch() {
    if (!notificationLaunch) return;
    const { roomId, threadId } = notificationLaunch;
    if (roomId && roomId !== currentRoomId && rooms.some((room) => room.id === roomId)) {
      send('switch_room', { roomId });
      return;
    }
    if (threadId && threads.some((thread) => thread.id === threadId)) openThreadById(threadId);
    notificationLaunch = null;
    history.replaceState(null, '', location.pathname);
  }

  function supportsPushNotifications() {
    return Boolean(
      window.isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window,
    );
  }

  function isIosDevice() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandaloneApp() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function setNotificationButton(enabled, pending = false) {
    notificationButton.classList.toggle('enabled', enabled);
    notificationButton.classList.toggle('pending', pending);
    notificationButton.disabled = pending;
    notificationButton.setAttribute('aria-pressed', String(enabled));
    notificationButton.textContent = '🔔';
    notificationButton.title = enabled ? '通知オン（押すと解除）' : '通知をオンにする';
    notificationButton.setAttribute('aria-label', notificationButton.title);
  }

  async function ensureNotificationSetup() {
    if (!supportsPushNotifications()) {
      // iOSの通常タブではPush APIが公開されないため、ベルを残して
      // 「ホーム画面に追加」の案内へ到達できるようにする。
      if (!(isIosDevice() && !isStandaloneApp())) notificationButton.classList.add('hidden');
      return null;
    }
    if (!notificationSetupPromise) {
      notificationSetupPromise = navigator.serviceWorker.register('/sw.js')
        .then(async (registration) => {
          serviceWorkerRegistration = registration;
          const subscription = await registration.pushManager.getSubscription();
          setNotificationButton(Boolean(subscription));
          return registration;
        })
        .catch(() => {
          notificationButton.classList.add('hidden');
          return null;
        });
    }
    return notificationSetupPromise;
  }

  async function pushApi(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'X-Session-Token': localStorage.getItem(SESSION_KEY) || '',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`push_api_${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  async function sessionApi(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'X-Session-Token': localStorage.getItem(SESSION_KEY) || '',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `api_${response.status}`);
    }
    return response.json();
  }

  async function loadRegistrationPolicy() {
    try {
      const response = await fetch('/api/registration-policy');
      if (!response.ok) return;
      const { inviteRequired } = await response.json();
      authSwitch.classList.toggle('hidden', Boolean(inviteRequired) && !registrationInvite);
    } catch {
      // 取得失敗時は登録導線を閉じたままにする。
    }
  }

  function renderRegistrationQrExpiry() {
    const remaining = Math.max(0, registrationQrExpiresAt - Date.now());
    const expiry = $('registration-qr-expiry');
    if (!registrationQrExpiresAt) {
      expiry.textContent = '';
      return;
    }
    if (remaining <= 0) {
      expiry.textContent = '期限切れです。QRを更新してください。';
      expiry.classList.add('expired');
      $('registration-url-copy').disabled = true;
      $('registration-qr-save').disabled = true;
      clearInterval(registrationQrTimer);
      registrationQrTimer = null;
      return;
    }
    expiry.classList.remove('expired');
    const seconds = Math.ceil(remaining / 1000);
    expiry.textContent = `有効期限まで ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function startRegistrationQrTimer() {
    clearInterval(registrationQrTimer);
    renderRegistrationQrExpiry();
    registrationQrTimer = setInterval(renderRegistrationQrExpiry, 1000);
  }

  async function generateRegistrationQr() {
    registrationQrImage.classList.add('hidden');
    registrationQrImage.removeAttribute('src');
    registrationUrlInput.value = '';
    registrationQrExpiresAt = 0;
    renderRegistrationQrExpiry();
    $('registration-qr-loading').classList.remove('hidden');
    $('registration-qr-error').textContent = '';
    $('registration-qr-refresh').disabled = true;
    $('registration-url-copy').disabled = true;
    $('registration-qr-save').disabled = true;
    try {
      const origin = encodeURIComponent(location.origin);
      const result = await sessionApi(`/api/registration-qr?origin=${origin}`, { method: 'POST' });
      registrationQrImage.src = result.image;
      registrationQrImage.classList.remove('hidden');
      registrationUrlInput.value = result.registrationUrl;
      registrationQrExpiresAt = result.expiresAt;
      $('registration-url-copy').disabled = false;
      $('registration-qr-save').disabled = false;
      startRegistrationQrTimer();
    } catch {
      $('registration-qr-error').textContent = 'QRコードを生成できませんでした。接続を確認してください。';
    } finally {
      $('registration-qr-loading').classList.add('hidden');
      $('registration-qr-refresh').disabled = false;
    }
  }

  async function openRegistrationQr() {
    registrationQrDialog.showModal();
    await generateRegistrationQr();
  }

  async function copyRegistrationUrl() {
    if (!registrationUrlInput.value) return;
    try {
      try {
        await navigator.clipboard.writeText(registrationUrlInput.value);
      } catch {
        registrationUrlInput.select();
        if (!document.execCommand('copy')) throw new Error('copy_failed');
      }
      showToast('登録URLをコピーしました。');
    } catch {
      showToast('登録URLをコピーできませんでした。');
    }
  }

  function saveRegistrationQr() {
    if (!registrationQrImage.src) return;
    const link = document.createElement('a');
    link.href = registrationQrImage.src;
    link.download = 'chat-lab-registration-qr.png';
    link.click();
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  }

  async function syncNotificationSubscription() {
    const registration = await ensureNotificationSetup();
    if (!registration || !localStorage.getItem(SESSION_KEY)) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    try {
      await pushApi('/api/push/subscription', {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      });
      setNotificationButton(true);
    } catch {
      showToast('通知設定をサーバーと同期できませんでした。');
    }
  }

  async function enableNotifications() {
    const registration = await ensureNotificationSetup();
    if (!registration) throw new Error('unsupported');
    const { publicKey } = await pushApi('/api/push/public-key');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    try {
      await pushApi('/api/push/subscription', {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      });
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }
    setNotificationButton(true);
    showToast('この端末の通知をオンにしました。');
  }

  async function disableNotifications(quiet = false) {
    const registration = await ensureNotificationSetup();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) {
      setNotificationButton(false);
      return;
    }
    await pushApi('/api/push/subscription', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
    setNotificationButton(false);
    if (!quiet) showToast('この端末の通知をオフにしました。');
  }

  async function toggleNotifications() {
    if (isIosDevice() && !isStandaloneApp()) {
      showToast('iPhoneでは共有メニューから「ホーム画面に追加」して、そのアイコンから開いてください。');
      return;
    }
    if (!supportsPushNotifications()) {
      showToast('このブラウザはWeb Push通知に対応していません。');
      return;
    }
    setNotificationButton(notificationButton.classList.contains('enabled'), true);
    try {
      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          showToast('通知が許可されませんでした。端末の設定から変更できます。');
          return;
        }
      }
      if (Notification.permission !== 'granted') {
        showToast('通知がブロックされています。端末の設定から許可してください。');
        return;
      }
      const registration = await ensureNotificationSetup();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await disableNotifications();
      else await enableNotifications();
    } catch {
      showToast('通知設定を変更できませんでした。もう一度お試しください。');
    } finally {
      const subscription = await serviceWorkerRegistration?.pushManager.getSubscription().catch(() => null);
      setNotificationButton(Boolean(subscription));
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const registering = mode === 'register';
    authTitle.textContent = registering ? 'アカウントを作成' : 'おかえりなさい';
    authDescription.textContent = registering ? 'この端末で使う名前とパスワードを決める' : 'アカウントでチャットに入る';
    authSubmit.textContent = ws?.readyState === WebSocket.OPEN
      ? (registering ? '登録して入る' : 'ログイン')
      : '接続中…';
    authSwitchLabel.textContent = registering ? 'すでにアカウントがありますか？' : 'アカウントが必要ですか？';
    authModeToggle.textContent = registering ? 'ログイン' : '登録';
    passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
    authError.textContent = '';
  }

  function showAuth(message = '') {
    me = null;
    pendingAuth = false;
    appEl.classList.add('hidden');
    authScreen.classList.remove('hidden');
    authError.textContent = message;
    passwordInput.value = '';
  }

  function showApp() {
    authScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    $('my-name').textContent = accountName(me);
    $('my-role').textContent = formatRole(me.role);
    const holder = $('my-avatar');
    setAvatar(holder, me.username, me.avatar?.url);
    $('add-room-button').classList.toggle('hidden', !['owner', 'admin'].includes(me.role));
    $('registration-qr-button').classList.toggle('hidden', !['owner', 'admin'].includes(me.role));
    $('report-inbox-button').classList.toggle('hidden', !['owner', 'admin'].includes(me.role));
    updatePostingState();
  }

  function updatePostingState() {
    const blocked = Boolean(me?.posting_blocked_at);
    const room = rooms.find((item) => item.id === currentRoomId);
    const announcementReadOnly = room?.kind === 'announcement' &&
      !['owner', 'admin'].includes(me?.role);
    const disabled = blocked || announcementReadOnly;
    const controls = [
      messageInput, attachButton, messageForm.querySelector('.send-button'),
      threadReplyInput, threadReplyForm.querySelector('.send-button'), $('add-thread-button'),
    ];
    for (const control of controls) if (control) control.disabled = disabled;
    if (blocked) {
      messageInput.placeholder = '投稿が停止されています（管理者が解除できます）';
      threadReplyInput.placeholder = '投稿が停止されています';
    } else if (announcementReadOnly) {
      messageInput.placeholder = 'お知らせは管理者のみ投稿できます';
      threadReplyInput.placeholder = 'お知らせは管理者のみ投稿できます';
    } else {
      messageInput.placeholder = `#${room?.name || ''} へメッセージ`;
      threadReplyInput.placeholder = '返信する';
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    authSubmit.disabled = true;
    authSubmit.textContent = '接続中…';
    setConnection(false, '接続中…');
    ws = new WebSocket(socketUrl());
    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      authSubmit.disabled = false;
      authSubmit.textContent = authMode === 'register' ? '登録して入る' : 'ログイン';
      setConnection(false, '認証中…');
      const token = localStorage.getItem(SESSION_KEY);
      if (registrationLaunch) {
        showAuth();
        setAuthMode('register');
      } else if (token) {
        pendingAuth = true;
        send('resume_session', { token });
      } else if (!me) {
        showAuth(invalidRegistrationLaunch ? '新規登録には有効な招待QRコードが必要です。' : '');
      }
    });
    ws.addEventListener('message', handleSocketMessage);
    ws.addEventListener('close', () => {
      authSubmit.disabled = true;
      authSubmit.textContent = '再接続中…';
      if (pendingAuth) {
        pendingAuth = false;
        authError.textContent = '接続が切れたためログインできませんでした。再接続後にもう一度お試しください。';
      }
      setConnection(false);
      if (!me && !localStorage.getItem(SESSION_KEY)) return;
      const delay = Math.min(1000 * (2 ** reconnectAttempt), 15000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
    ws.addEventListener('error', () => setConnection(false, '接続エラー'));
  }

  function handleSocketMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'auth_ok') {
      pendingAuth = false;
      me = data.user;
      if (data.sessionToken) localStorage.setItem(SESSION_KEY, data.sessionToken);
      if (authMode === 'register') {
        registrationInvite = '';
        authSwitch.classList.add('hidden');
      }
      if (registrationLaunch) {
        registrationLaunch = false;
        history.replaceState(null, '', location.pathname);
      }
      authForm.reset();
      showApp();
      setConnection(true);
      send('get_state');
      void syncNotificationSubscription();
      return;
    }
    if (data.type === 'state') {
      clearReply();
      currentRoomId = data.roomId;
      rooms = data.rooms || [];
      users = data.users || [];
      threads = data.threads || [];
      messages = (data.messages || []).filter((message) => message.thread_root_id == null);
      renderAll();
      handleNotificationLaunch();
      return;
    }
    if (data.type === 'rooms') {
      rooms = data.rooms || [];
      renderRooms();
      return;
    }
    if (data.type === 'users' || data.type === 'users_snapshot') {
      users = data.users || [];
      const updatedMe = users.find((user) => user.id === me?.id);
      if (updatedMe) {
        me = updatedMe;
        showApp();
      }
      renderMembers();
      if (messages.length) renderMessages(false);
      renderComposerHighlight();
      return;
    }
    if (data.type === 'profile_updated') {
      me = data.user;
      showApp();
      profileDialog.close();
      showToast('プロフィールを更新しました。');
      return;
    }
    if (data.type === 'threads') {
      if (data.roomId === currentRoomId) {
        threads = data.threads || [];
        renderThreads();
      }
      return;
    }
    if (data.type === 'room_switched') {
      currentRoomId = data.roomId;
      clearAttachment();
      clearReply();
      messages = (data.messages || []).filter((message) => message.thread_root_id == null);
      threads = data.threads || [];
      closeThread();
      renderRooms();
      renderThreads();
      renderMessages(true);
      updateRoomHeader();
      closeNav();
      handleNotificationLaunch();
      return;
    }
    if (data.type === 'message') {
      if (data.message.thread_root_id == null) {
        messages.push(data.message);
        renderMessages(true);
      }
      return;
    }
    if (data.type === 'message_updated') {
      let needsRender = false;
      const message = messages.find((item) => item.id === data.messageId);
      if (message) {
        message.body = data.body;
        message.edited_at = data.editedAt;
        needsRender = true;
      }
      for (const item of messages) {
        if (item.reply_to_id === data.messageId && item.reply) {
          item.reply.body = data.body;
          needsRender = true;
        }
      }
      if (replyingTo?.id === data.messageId) {
        replyingTo.body = data.body;
        renderReplyPreview();
      }
      if (needsRender) renderMessages(false);
      return;
    }
    if (data.type === 'message_deleted' || data.type === 'message_hidden') {
      for (const item of messages) {
        if (item.reply_to_id === data.messageId) item.reply = null;
      }
      if (replyingTo?.id === data.messageId) clearReply();
      messages = messages.filter((item) => item.id !== data.messageId);
      renderMessages(false);
      if (data.type === 'message_hidden') showToast('AI審査によりメッセージが非表示になりました。');
      return;
    }
    if (data.type === 'reaction_update') {
      const message = messages.find((item) => item.id === data.messageId);
      if (message) {
        message.reactions = data.reactions || [];
        renderMessages(false);
      }
      return;
    }
    if (data.type === 'thread_created') {
      createThreadDialog.close();
      openThreadById(data.thread.id);
      return;
    }
    if (data.type === 'thread_history' && data.thread) {
      openThread = data.thread;
      openThreadMessages = data.messages || [];
      renderThreadPanel();
      threadPanel.classList.add('open');
      threadScrim.classList.remove('hidden');
      return;
    }
    if (data.type === 'thread_message' && data.threadId === openThread?.id) {
      openThreadMessages.push(data.message);
      renderThreadPanel();
      return;
    }
    if (data.type === 'thread_message_updated' && data.threadId === openThread?.id) {
      const message = openThreadMessages.find((item) => item.id === data.messageId);
      if (message) {
        message.body = data.body;
        message.edited_at = data.editedAt;
        renderThreadPanel(false);
      }
      return;
    }
    if (
      (data.type === 'thread_message_deleted' || data.type === 'thread_message_hidden') &&
      data.threadId === openThread?.id
    ) {
      openThreadMessages = openThreadMessages.filter((item) => item.id !== data.messageId);
      renderThreadPanel(false);
      if (data.type === 'thread_message_hidden') showToast('AI審査により返信が非表示になりました。');
      return;
    }
    if (data.type === 'logged_out') {
      localStorage.removeItem(SESSION_KEY);
      closeLogoutDialog();
      showAuth();
      return;
    }
    if (data.type === 'report_submitted') {
      reportingTarget = null;
      reportMessageDialog.close();
      $('report-message-form').reset();
      showToast('通報をスタッフへ送りました。');
      return;
    }
    if (data.type === 'reports') {
      reports = data.reports || [];
      renderReportInbox();
      return;
    }
    if (data.type === 'report_created' && data.report) {
      reports = [data.report, ...reports.filter((report) => report.id !== data.report.id)];
      renderReportInbox();
      if (data.report.reporter_user_id !== me?.id) showToast('新しい通報が届きました。');
      return;
    }
    if (data.type === 'error') handleError(data.reason, data);
  }

  const errorMessages = {
    bad_credentials: 'ユーザー名かパスワードが違います。',
    account_exists: 'そのユーザー名はすでに使われています。',
    bad_username: 'ユーザー名を1〜32文字で入力してください。',
    bad_password: 'パスワードは8〜128文字で入力してください。',
    invalid_session: 'セッションが切れました。もう一度ログインしてください。',
    forbidden: 'この操作を行う権限がありません。',
    room_exists: '同じ名前のチャンネルがあります。',
    bad_room_name: 'チャンネル名を確認してください。',
    bad_room_access: '入室できるロールの指定を確認してください。',
    bad_room_notification: 'チャンネル通知の設定を変更できませんでした。',
    bad_thread_title: 'スレッドタイトルを1〜80文字で入力してください。',
    too_large: '送信内容が大きすぎます。',
    bad_attachment: '添付ファイルを利用できません。もう一度選択してください。',
    bad_profile: '表示名または自己紹介を確認してください。',
    bad_profile_roles: '属性ロールの指定を確認してください。',
    bad_avatar: 'その画像はアイコンに設定できません。',
    empty_message: '本文を空にはできません。',
    message_not_found: 'メッセージが見つかりません。',
    reply_not_found: '返信先のメッセージが見つからないか、表示できません。',
    cannot_delete_announcement: 'お知らせチャンネルは削除できません。',
    announcement_read_only: 'お知らせチャンネルへ投稿できるのは管理者とオーナーだけです。',
    bad_ban_duration: 'BANする期間を選び直してください。',
    user_not_found: '対象のアカウントが見つかりません。',
    invite_required: '新規登録には管理者が表示した招待QRコードが必要です。',
    invite_invalid: 'この招待QRコードは更新され、無効になりました。新しいQRコードを読み取ってください。',
    invite_expired: 'この招待QRコードは期限切れです。新しいQRコードを読み取ってください。',
    bad_report: '通報理由を選び、自由記述の場合は内容を入力してください。',
    already_reported: 'このメッセージはすでに通報済みです。',
    posting_blocked: 'AI審査により新規投稿が停止されています。管理者またはオーナーへ解除を依頼してください。',
  };

  function formatBanMessage(bannedUntil) {
    if (Number(bannedUntil) === -1) return 'このアカウントは永久BANされています。';
    if (Number(bannedUntil) > Date.now()) {
      return `このアカウントは ${formatExact(Number(bannedUntil))} までBANされています。`;
    }
    return 'このアカウントはBANされています。';
  }

  function handleError(reason, details = {}) {
    if (reason === 'account_banned') {
      localStorage.removeItem(SESSION_KEY);
      showAuth(formatBanMessage(details.bannedUntil));
      return;
    }
    const message = reason === 'rate_limited'
      ? `試行回数が多すぎます。${Math.max(1, Math.ceil(Number(details.retry_after_ms) / 1000))}秒待ってからお試しください。`
      : (errorMessages[reason] || `操作できませんでした (${reason})`);
    if (reason === 'invalid_session') {
      localStorage.removeItem(SESSION_KEY);
      showAuth(message);
    } else if (!me || pendingAuth) {
      pendingAuth = false;
      authError.textContent = message;
    } else if (reportMessageDialog.open && ['bad_report', 'already_reported'].includes(reason)) {
      $('report-error').textContent = message;
    } else {
      showToast(message);
    }
  }

  function renderAll() {
    showApp();
    renderRooms();
    renderThreads();
    renderMembers();
    renderMessages(true);
    renderComposerHighlight();
    updateRoomHeader();
  }

  function updateRoomHeader() {
    const room = rooms.find((item) => item.id === currentRoomId);
    const name = room?.name || '';
    document.querySelector('.topbar .hash').textContent = room?.kind === 'announcement' ? '📢' : '#';
    $('room-name').textContent = name;
    messageInput.placeholder = `#${name} へメッセージ`;
    updatePostingState();
  }

  function renderRooms() {
    roomList.replaceChildren();
    const canManage = ['owner', 'admin'].includes(me?.role);
    for (const room of rooms) {
      const item = document.createElement('li');
      item.className = `nav-item${room.id === currentRoomId ? ' active' : ''}`;
      const button = document.createElement('button');
      button.className = 'nav-select';
      button.innerHTML = `<span class="channel-icon">${room.kind === 'announcement' ? '📢' : '#'}</span>`;
      button.append(document.createTextNode(room.name));
      if (room.allowedRoles?.length) {
        const lock = document.createElement('span');
        lock.className = 'channel-lock';
        lock.textContent = '🔒';
        lock.title = '入室可能: ' + room.allowedRoles.map(formatRole).join('、');
        button.append(lock);
      }
      button.addEventListener('click', () => send('switch_room', { roomId: room.id }));
      item.append(button);
      const notificationToggle = document.createElement('button');
      notificationToggle.className = `room-notification-toggle${room.notificationsEnabled === false ? ' muted' : ''}`;
      notificationToggle.type = 'button';
      notificationToggle.textContent = room.notificationsEnabled === false ? '🔕' : '🔔';
      notificationToggle.title = room.notificationsEnabled === false
        ? 'このチャンネルの通知をオンにする'
        : 'このチャンネルの通知をオフにする';
      notificationToggle.setAttribute('aria-label', notificationToggle.title);
      notificationToggle.setAttribute('aria-pressed', String(room.notificationsEnabled !== false));
      notificationToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        send('set_room_notification', {
          roomId: room.id,
          enabled: room.notificationsEnabled === false,
        });
      });
      item.append(notificationToggle);
      if (canManage && room.id !== rooms[0]?.id && room.kind !== 'announcement') {
        const remove = document.createElement('button');
        remove.className = 'nav-delete';
        remove.textContent = '×';
        remove.title = 'チャンネルを削除';
        remove.addEventListener('click', () => {
          if (confirm(`「${room.name}」を削除しますか？`)) send('delete_room', { roomId: room.id });
        });
        item.append(remove);
      }
      roomList.append(item);
    }
    updateRoomHeader();
  }

  function renderThreads() {
    threadList.replaceChildren();
    if (!threads.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-nav';
      empty.textContent = 'まだスレッドはありません';
      threadList.append(empty);
      return;
    }
    for (const thread of threads) {
      const item = document.createElement('li');
      item.className = `nav-item${thread.id === openThread?.id ? ' active' : ''}`;
      const button = document.createElement('button');
      button.className = 'nav-select';
      const icon = document.createElement('span');
      icon.textContent = '⌁';
      const copy = document.createElement('span');
      copy.className = 'thread-copy';
      const title = document.createElement('strong');
      title.textContent = thread.title;
      const meta = document.createElement('small');
      meta.textContent = `${thread.reply_count}件 · ${formatRelative(thread.last_activity_at)}`;
      copy.append(title, meta);
      button.append(icon, copy);
      button.addEventListener('click', () => openThreadById(thread.id));
      item.append(button);
      threadList.append(item);
    }
  }

  function renderMembers() {
    $('member-count').textContent = users.length;
    memberList.replaceChildren();
    const sorted = [...users].sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.username.localeCompare(b.username, 'ja'));
    for (const user of sorted) {
      const item = document.createElement('div');
      item.className = 'member';
      item.append(makeProfileAvatar(user, true));
      const copy = document.createElement('div');
      copy.className = 'member-copy';
      const name = document.createElement('strong');
      name.textContent = accountName(user) + (user.id === me?.id ? '（あなた）' : '');
      const role = document.createElement('span');
      role.className = 'role-badge';
      role.textContent = formatRole(user.role);
      copy.append(name, role, makeRoleBadges(user));
      if (isUserBanned(user)) {
        const status = document.createElement('span');
        status.className = 'ban-status';
        status.textContent = user.banned_until === -1
          ? '永久BAN'
          : `${new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(user.banned_until))}までBAN`;
        copy.append(status);
      }
      if (user.posting_blocked_at) {
        const status = document.createElement('span');
        status.className = 'ban-status';
        status.textContent = '投稿停止中';
        copy.append(status);
      }
      item.append(copy);
      const actions = document.createElement('div');
      actions.className = 'member-moderation';
      if (me?.role === 'owner' && user.role !== 'owner') {
        const select = document.createElement('select');
        select.className = 'role-select';
        for (const value of ['member', 'admin']) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = formatRole(value);
          option.selected = user.role === value;
          select.append(option);
        }
        select.addEventListener('click', (event) => event.stopPropagation());
        select.addEventListener('change', () => send('set_role', { userId: user.id, role: select.value }));
        actions.append(select);

        const roleControls = document.createElement('fieldset');
        roleControls.className = 'profile-role-controls';
        roleControls.title = '属性ロール';
        roleControls.addEventListener('click', (event) => event.stopPropagation());
        const selectedRoles = new Set(profileRoles(user));
        for (const value of profileRoleValues) {
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = value;
          checkbox.checked = selectedRoles.has(value);
          checkbox.setAttribute('aria-label', formatRole(value));
          checkbox.addEventListener('change', () => {
            const roles = [...roleControls.querySelectorAll('input:checked')]
              .map((input) => input.value);
            send('set_profile_roles', { userId: user.id, roles });
          });
          const shortLabel = { adult: '大', child: '子', staff: '職' }[value];
          label.append(checkbox, shortLabel);
          roleControls.append(label);
        }
        actions.append(roleControls);
      }
      if (canModerateUser(user)) {
        const banButton = document.createElement('button');
        banButton.type = 'button';
        banButton.className = `member-ban-button${isUserBanned(user) ? ' unban' : ''}`;
        banButton.textContent = isUserBanned(user) ? '解除' : 'BAN';
        banButton.addEventListener('click', (event) => {
          event.stopPropagation();
          if (isUserBanned(user)) {
            if (confirm(`${accountName(user)} のBANを解除しますか？`)) {
              send('unban_user', { userId: user.id });
            }
            return;
          }
          banningTarget = user;
          $('ban-user-target').textContent = `${accountName(user)}（@${user.username}）`;
          $('ban-duration-select').value = '1h';
          banUserDialog.showModal();
        });
        actions.append(banButton);
      }
      if (['owner', 'admin'].includes(me?.role) && user.posting_blocked_at) {
        const unblock = document.createElement('button');
        unblock.type = 'button';
        unblock.className = 'member-ban-button unban';
        unblock.textContent = '投稿停止を解除';
        unblock.addEventListener('click', (event) => {
          event.stopPropagation();
          if (confirm(`${accountName(user)} の投稿停止を解除しますか？`)) {
            send('unblock_posting', { userId: user.id });
          }
        });
        actions.append(unblock);
      }
      if (actions.childElementCount) item.append(actions);
      item.addEventListener('click', () => openProfile(user, false));
      memberList.append(item);
    }
  }

  function isUserBanned(user) {
    return user?.banned_until === -1 || Number(user?.banned_until) > Date.now();
  }

  function canModerateUser(user) {
    if (!me || !user || me.id === user.id || user.role === 'owner') return false;
    return me.role === 'owner' || (
      me.role === 'admin' && user.role === 'member'
    );
  }

  function roleOrder(role) {
    return { owner: 0, admin: 1, member: 2 }[role] ?? 3;
  }
  function dateKey(timestamp) { return new Date(timestamp).toLocaleDateString('en-CA'); }
  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dateKey(timestamp) === dateKey(today.getTime())) return '今日';
    if (dateKey(timestamp) === dateKey(yesterday.getTime())) return '昨日';
    return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(date);
  }
  function formatTime(timestamp) { return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)); }
  function formatExact(timestamp) { return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'full', timeStyle: 'medium' }).format(new Date(timestamp)); }
  function formatRelative(timestamp) {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'たった今';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
    if (dateKey(timestamp) === dateKey(Date.now())) return formatTime(timestamp);
    return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
  }

  function appendRichText(container, text) {
    const names = new Set(users.map((user) => user.username));
    const parts = String(text).split(/(@[^\s@]+)/g);
    for (const part of parts) {
      const username = part.startsWith('@') ? part.slice(1) : '';
      if (username && names.has(username)) {
        const mention = document.createElement('span');
        mention.className = `mention${username === me?.username ? ' self' : ''}`;
        mention.textContent = part;
        container.append(mention);
      } else {
        container.append(document.createTextNode(part));
      }
    }
  }

  function canModifyMessage(message) {
    return Boolean(
      me && (message.author_user_id === me.id || ['owner', 'admin'].includes(me.role)),
    );
  }

  function makeEditedLabel(message) {
    if (!message.edited_at) return null;
    const edited = document.createElement('span');
    edited.className = 'message-edited';
    edited.textContent = '（編集済み）';
    edited.title = `編集: ${formatExact(message.edited_at)}`;
    return edited;
  }

  function makeManageActions(message, kind, row) {
    const fragment = document.createDocumentFragment();
    if (kind === 'message') {
      const reply = document.createElement('button');
      reply.className = 'message-manage-action reply';
      reply.type = 'button';
      reply.textContent = '返信';
      reply.title = 'このメッセージに返信';
      reply.addEventListener('click', () => {
        row.classList.remove('reaction-open', 'message-menu-open');
        setReply(message);
      });
      fragment.append(reply);
    }
    const copy = document.createElement('button');
    copy.className = 'message-manage-action';
    copy.type = 'button';
    copy.textContent = 'コピー';
    copy.title = 'メッセージ本文をコピー';
    copy.addEventListener('click', async () => {
      row.classList.remove('reaction-open', 'message-menu-open');
      const text = message.body?.trim() || message.attachment?.name || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showToast('コピーしました。');
      } catch {
        const fallback = document.createElement('textarea');
        fallback.value = text;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.append(fallback);
        fallback.select();
        const copied = document.execCommand('copy');
        fallback.remove();
        showToast(copied ? 'コピーしました。' : 'コピーできませんでした。');
      }
    });
    const report = document.createElement('button');
    report.className = 'message-manage-action report';
    report.type = 'button';
    report.textContent = '通報';
    report.title = 'このメッセージを通報';
    report.addEventListener('click', () => {
      row.classList.remove('reaction-open', 'message-menu-open');
      openReportMessage(message, kind);
    });
    fragment.append(copy, report);
    if (!canModifyMessage(message)) return fragment;
    const divider = document.createElement('span');
    divider.className = 'message-action-divider';
    const edit = document.createElement('button');
    edit.className = 'message-manage-action';
    edit.type = 'button';
    edit.textContent = '編集';
    edit.title = 'メッセージを編集';
    edit.addEventListener('click', () => {
      row.classList.remove('reaction-open', 'message-menu-open');
      openEditMessage(message, kind);
    });
    const hide = document.createElement('button');
    hide.className = 'message-manage-action';
    hide.type = 'button';
    hide.textContent = '非表示';
    hide.title = 'メッセージを非表示';
    hide.addEventListener('click', () => {
      row.classList.remove('reaction-open', 'message-menu-open');
      openHideMessage(message, kind);
    });
    const remove = document.createElement('button');
    remove.className = 'message-manage-action danger';
    remove.type = 'button';
    remove.textContent = '削除';
    remove.title = 'メッセージを削除';
    remove.addEventListener('click', () => {
      row.classList.remove('reaction-open', 'message-menu-open');
      openDeleteMessage(message, kind);
    });
    fragment.append(divider);
    if (['owner', 'admin'].includes(me?.role)) fragment.append(hide);
    fragment.append(edit, remove);
    return fragment;
  }

  function openEditMessage(message, kind) {
    editingTarget = {
      kind,
      messageId: message.id,
      threadId: kind === 'thread' ? openThread?.id : null,
      hasAttachment: Boolean(message.attachment),
    };
    editMessageInput.value = message.body || '';
    $('edit-message-error').textContent = '';
    editMessageDialog.showModal();
    requestAnimationFrame(() => {
      editMessageInput.focus();
      editMessageInput.setSelectionRange(editMessageInput.value.length, editMessageInput.value.length);
    });
  }

  function openDeleteMessage(message, kind) {
    deletingTarget = {
      action: 'delete',
      kind,
      messageId: message.id,
      threadId: kind === 'thread' ? openThread?.id : null,
    };
    const preview = message.body?.trim() || (message.attachment ? `添付: ${message.attachment.name}` : '本文なし');
    $('delete-message-preview').textContent = preview;
    $('delete-message-title').textContent = 'メッセージを削除';
    $('delete-message-description').textContent = 'この操作は取り消せません。';
    $('delete-message-submit').textContent = '削除する';
    deleteMessageDialog.showModal();
  }

  function openHideMessage(message, kind) {
    deletingTarget = {
      action: 'hide',
      kind,
      messageId: message.id,
      threadId: kind === 'thread' ? openThread?.id : null,
    };
    const preview = message.body?.trim() || (message.attachment ? `添付: ${message.attachment.name}` : '本文なし');
    $('delete-message-preview').textContent = preview;
    $('delete-message-title').textContent = 'メッセージを非表示';
    $('delete-message-description').textContent = '投稿はDBに保持されますが、通常の画面には表示されなくなります。';
    $('delete-message-submit').textContent = '非表示にする';
    deleteMessageDialog.showModal();
  }

  function openReportMessage(message, kind) {
    reportingTarget = {
      kind,
      messageId: message.id,
      threadId: kind === 'thread' ? openThread?.id : null,
    };
    const preview = message.body?.trim() || (message.attachment ? `添付: ${message.attachment.name}` : '本文なし');
    $('report-message-preview').textContent = preview;
    $('report-message-form').reset();
    $('report-error').textContent = '';
    $('report-details').required = false;
    $('report-details-label').firstChild.textContent = '詳しい内容（任意）';
    reportMessageDialog.showModal();
  }

  function closeReportMessage() {
    reportingTarget = null;
    $('report-message-form').reset();
    $('report-error').textContent = '';
    if (reportMessageDialog.open) reportMessageDialog.close();
  }

  function reportCategoryLabel(category) {
    return {
      harassment: 'いやなことを言われた',
      personal_info: '個人情報が書かれている',
      scary_media: 'こわい画像・動画がある',
      spam: '迷惑な連続投稿',
      other: '自由記述',
    }[category] || category;
  }

  function renderReportInbox() {
    const list = $('report-list');
    list.replaceChildren();
    if (!reports.length) {
      const empty = document.createElement('p');
      empty.className = 'report-empty';
      empty.textContent = '通報はありません。';
      list.append(empty);
      return;
    }
    for (const report of reports) {
      const card = document.createElement('article');
      card.className = 'report-card';
      const meta = document.createElement('div');
      meta.className = 'report-meta';
      const reason = document.createElement('strong');
      reason.textContent = reportCategoryLabel(report.category);
      const time = document.createElement('time');
      time.textContent = formatExact(report.created_at);
      meta.append(reason, time);
      const byline = document.createElement('p');
      byline.className = 'report-byline';
      byline.textContent = `通報者: @${report.reporter_username} · 投稿者: @${report.message.author}`;
      const body = document.createElement('blockquote');
      body.textContent = report.message.body || '本文なし';
      card.append(meta, byline, body);
      if (report.details) {
        const details = document.createElement('p');
        details.className = 'report-details';
        details.textContent = report.details;
        card.append(details);
      }
      const context = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `前後の会話 ${report.context.length}件`;
      context.append(summary);
      for (const item of report.context) {
        const line = document.createElement('p');
        line.textContent = `${item.id === report.target_message_id ? '▶ ' : ''}@${item.author}: ${item.body || '本文なし'}`;
        context.append(line);
      }
      const ai = document.createElement('small');
      ai.className = 'report-ai-status';
      ai.textContent = report.ai_status === 'pending' ? 'AI確認: 未接続・審査待ち' : `AI確認: ${report.ai_status}`;
      card.append(context, ai);
      list.append(card);
    }
  }

  function renderMessages(scrollToBottom) {
    const previousBottomDistance = messageList.scrollHeight - messageList.scrollTop;
    messageList.replaceChildren();
    const room = rooms.find((item) => item.id === currentRoomId);
    const welcome = document.createElement('section');
    welcome.className = 'welcome';
    const announcement = room?.kind === 'announcement';
    const symbol = announcement ? '📢' : '#';
    const description = announcement
      ? 'アプリの更新内容や運営からのお知らせを掲載します。'
      : `ここが #${escapeHtml(room?.name || '')} の始まりです。`;
    welcome.innerHTML = `<div class="welcome-hash">${symbol}</div><h2>${symbol}${escapeHtml(room?.name || '')}</h2><p>${description}</p>`;
    messageList.append(welcome);
    let prior = null;
    for (const message of messages) {
      if (!prior || dateKey(prior.created_at) !== dateKey(message.created_at)) {
        const separator = document.createElement('div');
        separator.className = 'date-separator';
        separator.textContent = formatDate(message.created_at);
        messageList.append(separator);
      }
      const grouped = Boolean(!message.reply_to_id && prior && prior.author === message.author && dateKey(prior.created_at) === dateKey(message.created_at) && message.created_at - prior.created_at < 5 * 60 * 1000);
      messageList.append(makeMessage(message, grouped));
      prior = message;
    }
    if (scrollToBottom) messageList.scrollTop = messageList.scrollHeight;
    else messageList.scrollTop = Math.max(0, messageList.scrollHeight - previousBottomDistance);
  }

  function makeMessage(message, grouped) {
    const row = document.createElement('article');
    row.className = `message${grouped ? ' grouped' : ''}`;
    row.dataset.messageId = message.id;
    row.dataset.shortTime = formatTime(message.created_at);
    row.title = grouped ? formatExact(message.created_at) : '';
    const messageUser = userForMessage(message);
    const avatar = messageUser ? makeProfileAvatar(messageUser) : makeAvatar(message.author);
    avatar.classList.add('message-avatar');
    const content = document.createElement('div');
    content.className = 'message-content';
    if (message.reply_to_id) content.append(makeReplyReference(message));
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = accountName(messageUser) || message.author;
    const time = document.createElement('time');
    time.className = 'message-time';
    time.dateTime = new Date(message.created_at).toISOString();
    time.title = formatExact(message.created_at);
    time.textContent = `${formatDate(message.created_at)} ${formatTime(message.created_at)}`;
    meta.append(author, time);
    const body = document.createElement('div');
    body.className = 'message-body';
    appendRichText(body, message.body);
    const edited = makeEditedLabel(message);
    if (edited) body.append(document.createTextNode(' '), edited);
    content.append(meta, body);
    if (message.attachment) content.append(makeAttachment(message.attachment));
    const reactions = document.createElement('div');
    reactions.className = 'reactions';
    for (const reaction of message.reactions || []) reactions.append(makeReactionChip(message.id, reaction));
    content.append(reactions);
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    for (const emoji of REACTIONS) {
      const button = document.createElement('button');
      button.className = 'reaction-action';
      button.type = 'button';
      button.textContent = emoji;
      button.title = `${emoji} でリアクション`;
      button.addEventListener('click', () => {
        send('toggle_reaction', { messageId: message.id, emoji });
        row.classList.remove('reaction-open');
      });
      actions.append(button);
    }
    actions.append(makeManageActions(message, 'message', row));
    row.append(avatar, content, actions);
    installLongPress(row);
    return row;
  }

  function makeReplyReference(message) {
    const reference = document.createElement('button');
    reference.className = 'message-reply-reference';
    reference.type = 'button';
    if (message.reply) {
      const targetUser = userForMessage(message.reply);
      const author = document.createElement('strong');
      author.textContent = accountName(targetUser) || message.reply.author;
      const excerpt = document.createElement('span');
      excerpt.textContent = message.reply.body?.trim() || '添付ファイル';
      reference.append(author, excerpt);
      reference.addEventListener('click', () => {
        const target = messageList.querySelector(`[data-message-id="${message.reply.id}"]`);
        if (!target) return;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('reply-target-flash');
        requestAnimationFrame(() => target.classList.add('reply-target-flash'));
        setTimeout(() => target.classList.remove('reply-target-flash'), 1400);
      });
    } else {
      reference.classList.add('unavailable');
      reference.textContent = '返信先のメッセージは表示できません';
      reference.disabled = true;
    }
    return reference;
  }

  function setReply(message) {
    replyingTo = { id: message.id, author: message.author, author_user_id: message.author_user_id, body: message.body };
    renderReplyPreview();
    keepKeyboardOpen(messageInput);
  }

  function renderReplyPreview() {
    replyPreview.classList.toggle('hidden', !replyingTo);
    if (!replyingTo) return;
    replyAuthor.textContent = accountName(userForMessage(replyingTo)) || replyingTo.author;
    replyBody.textContent = replyingTo.body?.trim() || '添付ファイル';
  }

  function clearReply() {
    replyingTo = null;
    renderReplyPreview();
  }

  function installLongPress(row, container = messageList, openClass = 'reaction-open') {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    let timer;
    let startX = 0;
    let startY = 0;

    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    row.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      startX = event.clientX;
      startY = event.clientY;
      cancel();
      timer = setTimeout(() => {
        for (const open of container.querySelectorAll(`.${openClass}`)) {
          open.classList.remove(openClass);
        }
        row.classList.add(openClass);
        navigator.vibrate?.(12);
      }, 450);
    });
    row.addEventListener('pointermove', (event) => {
      if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) cancel();
    });
    row.addEventListener('pointerup', cancel);
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('contextmenu', cancel);
  }

  function makeReactionChip(messageId, reaction) {
    const chip = document.createElement('button');
    const mine = reaction.userIds?.includes(me?.id);
    chip.className = `reaction-chip${mine ? ' mine' : ''}`;
    chip.textContent = `${reaction.emoji} ${reaction.count}`;
    chip.title = mine ? 'リアクションを取り消す' : 'リアクションする';
    chip.addEventListener('click', () => send('toggle_reaction', { messageId, emoji: reaction.emoji }));
    return chip;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function makeAttachment(attachment) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message-attachment';
    if (SAFE_RASTER_MIME_TYPES.has(attachment.mime_type)) {
      const link = document.createElement('a');
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener';
      const image = document.createElement('img');
      image.className = 'attachment-image';
      image.src = attachment.url;
      image.alt = attachment.name;
      image.loading = 'lazy';
      link.append(image);
      const caption = document.createElement('span');
      caption.className = 'attachment-caption';
      caption.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
      wrapper.append(link, caption);
      return wrapper;
    }
    if (SAFE_VIDEO_MIME_TYPES.has(attachment.mime_type)) {
      const video = document.createElement('video');
      video.className = 'attachment-video';
      video.src = attachment.url;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      const caption = document.createElement('span');
      caption.className = 'attachment-caption';
      caption.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
      wrapper.append(video, caption);
      return wrapper;
    }
    const link = document.createElement('a');
    link.className = 'file-card';
    link.href = attachment.url;
    link.download = attachment.name;
    const icon = document.createElement('span');
    icon.className = 'file-card-icon';
    icon.textContent = '📄';
    const copy = document.createElement('span');
    copy.className = 'file-card-copy';
    const name = document.createElement('strong');
    name.textContent = attachment.name;
    const size = document.createElement('span');
    size.textContent = formatBytes(attachment.size);
    copy.append(name, size);
    link.append(icon, copy);
    wrapper.append(link);
    return wrapper;
  }

  function clearAttachment(abort = true) {
    if (abort && uploadRequest) uploadRequest.abort();
    uploadRequest = null;
    pendingAttachment = null;
    fileInput.value = '';
    uploadPanel.classList.add('hidden');
    $('upload-progress-bar').style.width = '0%';
    attachButton.disabled = false;
  }

  function setUploadError(message) {
    uploadRequest = null;
    pendingAttachment = null;
    attachButton.disabled = false;
    $('upload-status').textContent = message;
    $('upload-progress-bar').style.width = '0%';
    uploadPanel.classList.remove('hidden');
    showToast(message);
  }

  function uploadFile(file) {
    clearAttachment();
    if (!file || file.size === 0) {
      setUploadError('空のファイルは送信できません。');
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setUploadError('ファイルは100MB以下にしてください。');
      return;
    }
    $('upload-icon').textContent = file.type.startsWith('image/') ? '🖼️' : (file.type.startsWith('video/') ? '🎬' : '📎');
    $('upload-name').textContent = file.name;
    $('upload-status').textContent = `${formatBytes(file.size)} · アップロード準備中`;
    $('upload-progress-bar').style.width = '0%';
    uploadPanel.classList.remove('hidden');
    attachButton.disabled = true;

    const xhr = new XMLHttpRequest();
    uploadRequest = xhr;
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-Session-Token', localStorage.getItem(SESSION_KEY) || '');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      $('upload-progress-bar').style.width = `${percent}%`;
      $('upload-status').textContent = `${formatBytes(file.size)} · ${percent}%`;
    });
    xhr.addEventListener('load', () => {
      if (uploadRequest !== xhr) return;
      uploadRequest = null;
      let response;
      try { response = JSON.parse(xhr.responseText); } catch { response = {}; }
      if (xhr.status !== 201 || !response.attachment) {
        setUploadError(xhr.status === 413 ? 'ファイルは100MB以下にしてください。' : 'アップロードに失敗しました。');
        return;
      }
      pendingAttachment = response.attachment;
      attachButton.disabled = false;
      $('upload-progress-bar').style.width = '100%';
      $('upload-status').textContent = `${formatBytes(file.size)} · 送信できます`;
      keepKeyboardOpen(messageInput);
    });
    xhr.addEventListener('error', () => {
      if (uploadRequest === xhr) setUploadError('通信エラーでアップロードできませんでした。');
    });
    xhr.send(file);
  }

  function openProfile(user, editing) {
    if (!user) return;
    profileAvatarId = user.avatar?.id || null;
    setAvatar($('profile-avatar'), user.username, user.avatar?.url);
    $('profile-name').textContent = accountName(user);
    $('profile-handle').textContent = `@${user.username}`;
    $('profile-role').textContent = formatRole(user.role);
    $('profile-roles').replaceChildren(makeRoleBadges(user));
    $('profile-bio-view').textContent = user.bio || '自己紹介はまだありません。';
    $('profile-display-name-input').value = user.display_name || '';
    $('profile-bio-input').value = user.bio || '';
    $('profile-avatar-status').textContent = '5MB以下の画像';
    $('profile-edit-fields').classList.toggle('hidden', !editing);
    $('profile-footer').classList.toggle('hidden', !editing);
    $('profile-bio-view').classList.toggle('hidden', editing);
    $('profile-save').disabled = false;
    profileDialog.showModal();
  }

  function uploadProfileAvatar(file) {
    if (!file) return;
    if (!SAFE_RASTER_MIME_TYPES.has(file.type.toLowerCase())) {
      $('profile-avatar-status').textContent = '画像ファイルを選んでください。';
      return;
    }
    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      $('profile-avatar-status').textContent = '画像は5MB以下にしてください。';
      return;
    }
    if (profileUploadRequest) profileUploadRequest.abort();
    const xhr = new XMLHttpRequest();
    profileUploadRequest = xhr;
    $('profile-avatar-button').disabled = true;
    $('profile-save').disabled = true;
    $('profile-avatar-status').textContent = 'アップロード中…';
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-Session-Token', localStorage.getItem(SESSION_KEY) || '');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        $('profile-avatar-status').textContent = `アップロード中 ${Math.round((event.loaded / event.total) * 100)}%`;
      }
    });
    xhr.addEventListener('load', () => {
      if (profileUploadRequest !== xhr) return;
      profileUploadRequest = null;
      $('profile-avatar-button').disabled = false;
      $('profile-save').disabled = false;
      let response;
      try { response = JSON.parse(xhr.responseText); } catch { response = {}; }
      if (xhr.status !== 201 || !response.attachment) {
        $('profile-avatar-status').textContent = '画像をアップロードできませんでした。';
        return;
      }
      profileAvatarId = response.attachment.id;
      setAvatar($('profile-avatar'), me.username, response.attachment.url);
      $('profile-avatar-status').textContent = `${file.name} · 保存できます`;
    });
    xhr.addEventListener('error', () => {
      if (profileUploadRequest !== xhr) return;
      profileUploadRequest = null;
      $('profile-avatar-button').disabled = false;
      $('profile-save').disabled = false;
      $('profile-avatar-status').textContent = '通信エラーでアップロードできませんでした。';
    });
    xhr.send(file);
  }

  function openThreadById(threadId) { send('open_standalone_thread', { threadId }); closeNav(); }
  function closeThread() {
    threadPanel.classList.remove('open');
    threadScrim.classList.add('hidden');
    openThread = null;
    openThreadMessages = [];
    renderThreads();
  }
  function renderThreadPanel(scrollToBottom = true) {
    if (!openThread) return;
    $('thread-title').textContent = openThread.title;
    threadMessages.replaceChildren();
    for (const message of openThreadMessages) {
      const row = document.createElement('article');
      row.className = 'thread-message';
      const messageUser = userForMessage(message);
      row.append(messageUser ? makeProfileAvatar(messageUser) : makeAvatar(message.author));
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const author = document.createElement('strong');
      author.textContent = accountName(messageUser) || message.author;
      const time = document.createElement('time');
      time.className = 'message-time';
      time.textContent = `${formatDate(message.created_at)} ${formatTime(message.created_at)}`;
      time.title = formatExact(message.created_at);
      meta.append(author, time);
      const edited = makeEditedLabel(message);
      if (edited) meta.append(edited);
      const body = document.createElement('p');
      appendRichText(body, message.body);
      row.append(meta, body);
      const actions = document.createElement('div');
      actions.className = 'thread-message-actions';
      actions.append(makeManageActions(message, 'thread', row));
      row.append(actions);
      installLongPress(row, threadMessages, 'message-menu-open');
      threadMessages.append(row);
    }
    renderThreads();
    if (scrollToBottom) {
      requestAnimationFrame(() => { threadMessages.scrollTop = threadMessages.scrollHeight; });
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function resizeTextarea(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 190)}px`;
  }

  function renderComposerHighlight() {
    const names = new Set(users.map((user) => user.username));
    const value = messageInput.value;
    const fragment = document.createDocumentFragment();
    for (const part of value.split(/(@[^\s@]+)/g)) {
      const username = part.startsWith('@') ? part.slice(1) : '';
      if (username && names.has(username)) {
        const mention = document.createElement('span');
        mention.className = 'composer-highlight-mention';
        mention.textContent = part;
        fragment.append(mention);
      } else {
        fragment.append(document.createTextNode(part));
      }
    }
    if (value.endsWith('\n')) fragment.append(document.createTextNode('\u200b'));
    mentionHighlight.replaceChildren(fragment);
    mentionHighlight.scrollTop = messageInput.scrollTop;
  }

  function keepKeyboardOpen(input) {
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function renderMentionMenu() {
    const beforeCursor = messageInput.value.slice(0, messageInput.selectionStart);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) {
      mentionMenu.classList.add('hidden');
      return;
    }
    const query = match[1].toLocaleLowerCase();
    const options = users.filter((user) => user.username.toLocaleLowerCase().includes(query)).slice(0, 6);
    mentionMenu.replaceChildren();
    if (!options.length) {
      mentionMenu.classList.add('hidden');
      return;
    }
    for (const user of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mention-option';
      button.append(makeAvatar(user.username, true), document.createTextNode(user.username));
      button.addEventListener('click', () => {
        const cursor = messageInput.selectionStart;
        const start = cursor - match[1].length - 1;
        messageInput.setRangeText(`@${user.username} `, start, cursor, 'end');
        mentionMenu.classList.add('hidden');
        resizeTextarea(messageInput);
        renderComposerHighlight();
        messageInput.focus();
      });
      mentionMenu.append(button);
    }
    mentionMenu.classList.remove('hidden');
  }

  function setMembersOpen(open) {
    membersPanel.classList.toggle('open', open);
    membersScrim.classList.toggle('hidden', !open);
    membersToggle.setAttribute('aria-expanded', String(open));
  }
  function closeMembers() { setMembersOpen(false); }
  function openNav() {
    closeMembers();
    nav.classList.add('open');
    navScrim.classList.remove('hidden');
  }
  function closeNav() { nav.classList.remove('open'); navScrim.classList.add('hidden'); }

  function shouldIgnorePanelSwipe(target) {
    return target instanceof Element && Boolean(
      target.closest('input, textarea, button, select, a, video, audio, dialog, [contenteditable="true"]'),
    );
  }

  function handlePanelSwipeStart(event) {
    if (!mobilePanelsMedia.matches || event.touches.length !== 1 || shouldIgnorePanelSwipe(event.target)) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }

  function handlePanelSwipeEnd(event) {
    if (!swipeStart || event.changedTouches.length !== 1) {
      swipeStart = null;
      return;
    }
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - swipeStart.x;
    const deltaY = touch.clientY - swipeStart.y;
    const duration = Date.now() - swipeStart.at;
    swipeStart = null;
    if (duration > 700 || Math.abs(deltaX) < 64 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) {
      return;
    }
    if (nav.classList.contains('open')) {
      if (deltaX < 0) closeNav();
      return;
    }
    if (membersPanel.classList.contains('open')) {
      if (deltaX > 0) closeMembers();
      return;
    }
    if (deltaX > 0) openNav();
    else setMembersOpen(true);
  }

  function cancelPanelSwipe() { swipeStart = null; }

  authModeToggle.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    authError.textContent = '';
    const sent = send(authMode, {
      username: usernameInput.value.trim(),
      password: passwordInput.value,
      ...(authMode === 'register' ? { invite: registrationInvite } : {}),
    });
    if (!sent) {
      pendingAuth = false;
      authError.textContent = 'まだサーバーへ接続できていません。数秒待ってからもう一度お試しください。';
      return;
    }
    pendingAuth = true;
  });
  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (me?.posting_blocked_at) {
      showToast(errorMessages.posting_blocked);
      return;
    }
    const body = messageInput.value.trim();
    if (uploadRequest) {
      showToast('アップロード完了までお待ちください。');
      return;
    }
    if (!body && !pendingAttachment) return;
    const sent = send('message', {
      body,
      attachmentId: pendingAttachment?.id,
      replyToId: replyingTo?.id,
    });
    if (!sent) return;
    messageInput.value = '';
    clearAttachment(false);
    clearReply();
    resizeTextarea(messageInput);
    renderComposerHighlight();
    mentionMenu.classList.add('hidden');
    keepKeyboardOpen(messageInput);
  });
  messageInput.addEventListener('input', () => {
    resizeTextarea(messageInput);
    renderComposerHighlight();
    renderMentionMenu();
  });
  messageInput.addEventListener('scroll', () => {
    mentionHighlight.scrollTop = messageInput.scrollTop;
  });
  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => uploadFile(fileInput.files?.[0]));
  $('upload-remove').addEventListener('click', () => clearAttachment());
  $('reply-cancel').addEventListener('click', () => {
    clearReply();
    keepKeyboardOpen(messageInput);
  });
  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
    if (event.key === 'Escape') mentionMenu.classList.add('hidden');
  });
  threadReplyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (me?.posting_blocked_at) {
      showToast(errorMessages.posting_blocked);
      return;
    }
    const body = threadReplyInput.value.trim();
    if (!body || !openThread) return;
    send('thread_message', { threadId: openThread.id, body });
    threadReplyInput.value = '';
    resizeTextarea(threadReplyInput);
    keepKeyboardOpen(threadReplyInput);
  });
  threadReplyInput.addEventListener('input', () => resizeTextarea(threadReplyInput));
  threadReplyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      threadReplyForm.requestSubmit();
    }
  });
  notificationButton.addEventListener('click', () => { void toggleNotifications(); });
  $('registration-qr-button').addEventListener('click', () => { void openRegistrationQr(); });
  $('registration-qr-refresh').addEventListener('click', () => { void generateRegistrationQr(); });
  $('registration-url-copy').addEventListener('click', () => { void copyRegistrationUrl(); });
  $('registration-qr-save').addEventListener('click', saveRegistrationQr);
  registrationQrDialog.addEventListener('close', () => {
    clearInterval(registrationQrTimer);
    registrationQrTimer = null;
  });
  $('logout-button').addEventListener('click', () => logoutDialog.showModal());
  $('logout-close').addEventListener('click', closeLogoutDialog);
  $('logout-cancel').addEventListener('click', closeLogoutDialog);
  $('logout-confirm').addEventListener('click', () => { void confirmLogout(); });
  $('report-message-close').addEventListener('click', closeReportMessage);
  $('report-message-cancel').addEventListener('click', closeReportMessage);
  $('report-category').addEventListener('change', () => {
    const freeform = $('report-category').value === 'other';
    $('report-details').required = freeform;
    $('report-details-label').firstChild.textContent = freeform ? '詳しい内容（必須）' : '詳しい内容（任意）';
  });
  $('report-message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!reportingTarget) return;
    const category = $('report-category').value;
    const details = $('report-details').value.trim();
    if (!category || (category === 'other' && !details)) {
      $('report-error').textContent = '通報理由を選び、自由記述の場合は内容を入力してください。';
      return;
    }
    $('report-error').textContent = '';
    send('report_message', {
      targetKind: reportingTarget.kind,
      messageId: reportingTarget.messageId,
      threadId: reportingTarget.threadId,
      category,
      details,
    });
  });
  $('report-inbox-button').addEventListener('click', () => {
    reports = [];
    $('report-list').innerHTML = '<p class="report-empty">読み込み中…</p>';
    reportInboxDialog.showModal();
    send('get_reports');
  });
  $('report-inbox-close').addEventListener('click', () => reportInboxDialog.close());
  $('report-inbox-done').addEventListener('click', () => reportInboxDialog.close());
  $('my-avatar').addEventListener('click', () => openProfile(me, false));
  $('profile-button').addEventListener('click', () => openProfile(me, true));
  $('profile-avatar-button').addEventListener('click', () => profileAvatarInput.click());
  profileAvatarInput.addEventListener('change', () => uploadProfileAvatar(profileAvatarInput.files?.[0]));
  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
      if (profileUploadRequest) profileUploadRequest.abort();
      profileUploadRequest = null;
      profileDialog.close();
      return;
    }
    if (profileUploadRequest) {
      showToast('アイコンのアップロード完了までお待ちください。');
      return;
    }
    send('update_profile', {
      displayName: $('profile-display-name-input').value,
      bio: $('profile-bio-input').value,
      avatarId: profileAvatarId,
    });
  });
  profileDialog.addEventListener('close', () => {
    if (profileUploadRequest) profileUploadRequest.abort();
    profileUploadRequest = null;
    profileAvatarInput.value = '';
  });
  $('nav-open').addEventListener('click', openNav);
  navScrim.addEventListener('click', closeNav);
  membersToggle.addEventListener('click', () => setMembersOpen(!membersPanel.classList.contains('open')));
  membersScrim.addEventListener('click', closeMembers);
  mobilePanelsMedia.addEventListener('change', (event) => {
    if (!event.matches) {
      closeMembers();
      closeNav();
    }
  });
  for (const surface of [chatColumn, navScrim, membersScrim]) {
    surface.addEventListener('touchstart', handlePanelSwipeStart, { passive: true });
    surface.addEventListener('touchend', handlePanelSwipeEnd, { passive: true });
    surface.addEventListener('touchcancel', cancelPanelSwipe, { passive: true });
  }
  $('thread-close').addEventListener('click', closeThread);
  threadScrim.addEventListener('click', closeThread);
  $('add-thread-button').addEventListener('click', () => {
    if (me?.posting_blocked_at) {
      showToast(errorMessages.posting_blocked);
      return;
    }
    $('thread-create-error').textContent = '';
    createThreadDialog.showModal();
  });
  $('create-thread-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
      createThreadDialog.close();
      return;
    }
    const title = $('thread-title-input').value.trim();
    if (!title) return;
    send('create_thread', { title, body: $('thread-body-input').value.trim() });
    $('create-thread-form').reset();
  });
  $('add-room-button').addEventListener('click', () => { $('room-create-error').textContent = ''; createRoomDialog.showModal(); });
  $('room-create-close').addEventListener('click', closeCreateRoomDialog);
  $('room-create-cancel').addEventListener('click', closeCreateRoomDialog);
  createRoomDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCreateRoomDialog();
  });
  $('create-room-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('room-name-input').value.trim();
    if (!name) return;
    const allowedRoles = [...document.querySelectorAll('input[name="room-access-role"]:checked')]
      .map((input) => input.value);
    if (send('create_room', { name, allowedRoles })) closeCreateRoomDialog();
  });
  $('edit-message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
      editingTarget = null;
      editMessageDialog.close();
      return;
    }
    if (!editingTarget) return;
    const body = editMessageInput.value.trim();
    if (!body && !editingTarget.hasAttachment) {
      $('edit-message-error').textContent = '本文を空にはできません。';
      return;
    }
    if (editingTarget.kind === 'thread') {
      send('edit_thread_message', {
        threadId: editingTarget.threadId,
        messageId: editingTarget.messageId,
        body,
      });
    } else {
      send('edit_message', { messageId: editingTarget.messageId, body });
    }
    editingTarget = null;
    editMessageDialog.close();
  });
  editMessageDialog.addEventListener('close', () => { editingTarget = null; });
  $('delete-message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
      deletingTarget = null;
      deleteMessageDialog.close();
      return;
    }
    if (!deletingTarget) return;
    if (deletingTarget.kind === 'thread') {
      send(deletingTarget.action === 'hide' ? 'hide_thread_message' : 'delete_thread_message', {
        threadId: deletingTarget.threadId,
        messageId: deletingTarget.messageId,
      });
    } else {
      send(deletingTarget.action === 'hide' ? 'hide_message' : 'delete_message', {
        messageId: deletingTarget.messageId,
      });
    }
    deletingTarget = null;
    deleteMessageDialog.close();
  });
  deleteMessageDialog.addEventListener('close', () => { deletingTarget = null; });
  $('ban-user-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
      banningTarget = null;
      banUserDialog.close();
      return;
    }
    if (!banningTarget) return;
    send('ban_user', {
      userId: banningTarget.id,
      duration: $('ban-duration-select').value,
    });
    banningTarget = null;
    banUserDialog.close();
  });
  banUserDialog.addEventListener('close', () => { banningTarget = null; });

  composerInputShell.classList.add('highlight-enabled');
  renderComposerHighlight();
  syncAppViewportHeight();
  window.addEventListener('resize', syncAppViewportHeight);
  window.addEventListener('orientationchange', syncAppViewportHeight);
  window.visualViewport?.addEventListener('resize', syncAppViewportHeight);
  void ensureNotificationSetup();
  window.visualViewport?.addEventListener('scroll', syncAppViewportHeight);
  authSwitch.classList.toggle('hidden', !registrationInvite);
  void loadRegistrationPolicy();
  setAuthMode(registrationLaunch ? 'register' : 'login');
  connect();
})();
