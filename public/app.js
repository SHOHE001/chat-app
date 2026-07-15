(() => {
  'use strict';

  const SESSION_KEY = 'chat-app:session';
  const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀'];
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
  const profileDialog = $('profile-dialog');
  const profileAvatarInput = $('profile-avatar-input');
  const editMessageDialog = $('edit-message-dialog');
  const editMessageInput = $('edit-message-input');
  const deleteMessageDialog = $('delete-message-dialog');

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
  let serviceWorkerRegistration = null;
  let notificationSetupPromise = null;
  let swipeStart = null;
  const mobilePanelsMedia = window.matchMedia('(max-width: 980px)');
  const launchParams = new URLSearchParams(location.search);
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
      const height = window.visualViewport?.height || window.innerHeight;
      if (height > 0) document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
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
    avatar.className = `avatar${small ? ' small' : ''}`;
    avatar.style.setProperty('--avatar-hue', avatarHue(name));
    setAvatar(avatar, name, avatarUrl);
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
    return { owner: 'オーナー', admin: '管理者', member: 'メンバー' }[role] || role;
  }

  function showToast(text) {
    const toast = $('toast');
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
  }

  function setConnection(online, text = online ? '接続済み' : '再接続中…') {
    const el = $('connection-status');
    el.textContent = text;
    el.classList.toggle('online', online);
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
      if (token) {
        pendingAuth = true;
        send('resume_session', { token });
      } else if (!me) {
        showAuth();
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
      authForm.reset();
      showApp();
      setConnection(true);
      send('get_state');
      void syncNotificationSubscription();
      return;
    }
    if (data.type === 'state') {
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
      const message = messages.find((item) => item.id === data.messageId);
      if (message) {
        message.body = data.body;
        message.edited_at = data.editedAt;
        renderMessages(false);
      }
      return;
    }
    if (data.type === 'message_deleted') {
      messages = messages.filter((item) => item.id !== data.messageId);
      renderMessages(false);
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
    if (data.type === 'thread_message_deleted' && data.threadId === openThread?.id) {
      openThreadMessages = openThreadMessages.filter((item) => item.id !== data.messageId);
      renderThreadPanel(false);
      return;
    }
    if (data.type === 'logged_out') {
      localStorage.removeItem(SESSION_KEY);
      showAuth();
      return;
    }
    if (data.type === 'error') handleError(data.reason);
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
    bad_thread_title: 'スレッドタイトルを1〜80文字で入力してください。',
    too_large: '送信内容が大きすぎます。',
    bad_attachment: '添付ファイルを利用できません。もう一度選択してください。',
    bad_profile: '表示名または自己紹介を確認してください。',
    bad_avatar: 'その画像はアイコンに設定できません。',
    empty_message: '本文を空にはできません。',
    message_not_found: 'メッセージが見つかりません。',
  };

  function handleError(reason) {
    const message = errorMessages[reason] || `操作できませんでした (${reason})`;
    if (reason === 'invalid_session') {
      localStorage.removeItem(SESSION_KEY);
      showAuth(message);
    } else if (!me || pendingAuth) {
      pendingAuth = false;
      authError.textContent = message;
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
    $('room-name').textContent = name;
    messageInput.placeholder = `#${name} へメッセージ`;
  }

  function renderRooms() {
    roomList.replaceChildren();
    const canManage = ['owner', 'admin'].includes(me?.role);
    for (const room of rooms) {
      const item = document.createElement('li');
      item.className = `nav-item${room.id === currentRoomId ? ' active' : ''}`;
      const button = document.createElement('button');
      button.className = 'nav-select';
      button.innerHTML = '<span class="channel-icon">#</span>';
      button.append(document.createTextNode(room.name));
      button.addEventListener('click', () => send('switch_room', { roomId: room.id }));
      item.append(button);
      if (canManage && room.id !== rooms[0]?.id) {
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
      item.append(makeAvatar(user.username, true, user.avatar?.url));
      const copy = document.createElement('div');
      copy.className = 'member-copy';
      const name = document.createElement('strong');
      name.textContent = accountName(user) + (user.id === me?.id ? '（あなた）' : '');
      const role = document.createElement('span');
      role.className = 'role-badge';
      role.textContent = formatRole(user.role);
      copy.append(name, role);
      item.append(copy);
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
        item.append(select);
      }
      item.addEventListener('click', () => openProfile(user, false));
      memberList.append(item);
    }
  }

  function roleOrder(role) { return { owner: 0, admin: 1, member: 2 }[role] ?? 3; }
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
    const remove = document.createElement('button');
    remove.className = 'message-manage-action danger';
    remove.type = 'button';
    remove.textContent = '削除';
    remove.title = 'メッセージを削除';
    remove.addEventListener('click', () => {
      row.classList.remove('reaction-open', 'message-menu-open');
      openDeleteMessage(message, kind);
    });
    fragment.append(divider, edit, remove);
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
      kind,
      messageId: message.id,
      threadId: kind === 'thread' ? openThread?.id : null,
    };
    const preview = message.body?.trim() || (message.attachment ? `添付: ${message.attachment.name}` : '本文なし');
    $('delete-message-preview').textContent = preview;
    deleteMessageDialog.showModal();
  }

  function renderMessages(scrollToBottom) {
    const previousBottomDistance = messageList.scrollHeight - messageList.scrollTop;
    messageList.replaceChildren();
    const room = rooms.find((item) => item.id === currentRoomId);
    const welcome = document.createElement('section');
    welcome.className = 'welcome';
    welcome.innerHTML = `<div class="welcome-hash">#</div><h2>#${escapeHtml(room?.name || '')  }</h2><p>ここが #${escapeHtml(room?.name || '')} の始まりです。</p>`;
    messageList.append(welcome);
    let prior = null;
    for (const message of messages) {
      if (!prior || dateKey(prior.created_at) !== dateKey(message.created_at)) {
        const separator = document.createElement('div');
        separator.className = 'date-separator';
        separator.textContent = formatDate(message.created_at);
        messageList.append(separator);
      }
      const grouped = Boolean(prior && prior.author === message.author && dateKey(prior.created_at) === dateKey(message.created_at) && message.created_at - prior.created_at < 5 * 60 * 1000);
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
    const avatar = makeAvatar(message.author, false, messageUser?.avatar?.url);
    avatar.classList.add('message-avatar');
    const content = document.createElement('div');
    content.className = 'message-content';
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
    row.addEventListener('contextmenu', (event) => event.preventDefault());
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
    if (attachment.mime_type.startsWith('image/')) {
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
    if (attachment.mime_type.startsWith('video/')) {
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
    if (!file.type.startsWith('image/')) {
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
      row.append(makeAvatar(message.author, false, messageUser?.avatar?.url));
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
      if (canModifyMessage(message)) {
        const actions = document.createElement('div');
        actions.className = 'thread-message-actions';
        actions.append(makeManageActions(message, 'thread', row));
        row.append(actions);
        installLongPress(row, threadMessages, 'message-menu-open');
      }
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
    const sent = send(authMode, { username: usernameInput.value.trim(), password: passwordInput.value });
    if (!sent) {
      pendingAuth = false;
      authError.textContent = 'まだサーバーへ接続できていません。数秒待ってからもう一度お試しください。';
      return;
    }
    pendingAuth = true;
  });
  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = messageInput.value.trim();
    if (uploadRequest) {
      showToast('アップロード完了までお待ちください。');
      return;
    }
    if (!body && !pendingAttachment) return;
    const sent = send('message', { body, attachmentId: pendingAttachment?.id });
    if (!sent) return;
    messageInput.value = '';
    clearAttachment(false);
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
  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
    if (event.key === 'Escape') mentionMenu.classList.add('hidden');
  });
  threadReplyForm.addEventListener('submit', (event) => {
    event.preventDefault();
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
  $('logout-button').addEventListener('click', async () => {
    try { await disableNotifications(true); } catch { /* ログアウト自体は続ける */ }
    send('logout');
    localStorage.removeItem(SESSION_KEY);
  });
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
  $('add-thread-button').addEventListener('click', () => { $('thread-create-error').textContent = ''; createThreadDialog.showModal(); });
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
  $('create-room-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') {
      createRoomDialog.close();
      return;
    }
    const name = $('room-name-input').value.trim();
    if (!name) return;
    send('create_room', { name });
    $('create-room-form').reset();
    createRoomDialog.close();
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
      send('delete_thread_message', {
        threadId: deletingTarget.threadId,
        messageId: deletingTarget.messageId,
      });
    } else {
      send('delete_message', { messageId: deletingTarget.messageId });
    }
    deletingTarget = null;
    deleteMessageDialog.close();
  });
  deleteMessageDialog.addEventListener('close', () => { deletingTarget = null; });

  composerInputShell.classList.add('highlight-enabled');
  renderComposerHighlight();
  syncAppViewportHeight();
  window.addEventListener('resize', syncAppViewportHeight);
  window.addEventListener('orientationchange', syncAppViewportHeight);
  window.visualViewport?.addEventListener('resize', syncAppViewportHeight);
  void ensureNotificationSetup();
  setAuthMode('login');
  connect();
})();
