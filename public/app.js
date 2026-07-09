(() => {
  const NICKNAME_KEY = 'chat-app:nickname';
  const ADMIN_PASSWORD_KEY = 'chat-app:admin-password';

  const joinOverlay = document.getElementById('join-overlay');
  const joinForm = document.getElementById('join-form');
  const nicknameInput = document.getElementById('nickname-input');
  const joinError = document.getElementById('join-error');

  const chatScreen = document.getElementById('chat-screen');
  const messageList = document.getElementById('message-list');
  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const connectionStatus = document.getElementById('connection-status');
  const roomNameEl = document.getElementById('room-name');

  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sidebarOpenBtn = document.getElementById('sidebar-open');
  const sidebarCloseBtn = document.getElementById('sidebar-close');
  const roomList = document.getElementById('room-list');

  const adminLoginToggle = document.getElementById('admin-login-toggle');
  const adminLoginForm = document.getElementById('admin-login-form');
  const adminPasswordInput = document.getElementById('admin-password-input');
  const adminLoginError = document.getElementById('admin-login-error');

  const createRoomForm = document.getElementById('create-room-form');
  const createRoomInput = document.getElementById('create-room-input');
  const createRoomError = document.getElementById('create-room-error');

  const threadOverlay = document.getElementById('thread-overlay');
  const threadPanel = document.getElementById('thread-panel');
  const threadCloseBtn = document.getElementById('thread-close');
  const threadRootEl = document.getElementById('thread-root');
  const threadReplyList = document.getElementById('thread-reply-list');
  const threadReplyForm = document.getElementById('thread-reply-form');
  const threadReplyInput = document.getElementById('thread-reply-input');

  let ws = null;
  let nickname = '';
  let isAdmin = false;
  let currentRoomId = null;
  let rooms = [];
  let openThreadRootId = null;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/`;
  }

  function showJoin(errorText) {
    joinOverlay.classList.remove('hidden');
    chatScreen.classList.add('hidden');
    joinError.textContent = errorText || '';
  }

  function showChat() {
    joinOverlay.classList.add('hidden');
    chatScreen.classList.remove('hidden');
  }

  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.remove('hidden');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.add('hidden');
  }

  function formatThreadBadgeText(count) {
    return `\u{1F4AC} ${count}件`;
  }

  function appendMessage(message) {
    const li = document.createElement('li');
    li.className = 'message-item';
    li.dataset.messageId = String(message.id);

    const authorEl = document.createElement('span');
    authorEl.className = 'author';
    authorEl.textContent = message.author;

    const bodyEl = document.createElement('span');
    bodyEl.className = 'body';
    bodyEl.textContent = message.body;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'message-actions';

    const threadBtn = document.createElement('button');
    threadBtn.type = 'button';
    threadBtn.className = 'thread-open-btn';
    threadBtn.textContent = 'スレッド';
    threadBtn.addEventListener('click', () => {
      openThread(message.id);
    });
    actionsEl.appendChild(threadBtn);

    const badgeEl = document.createElement('span');
    badgeEl.className = 'thread-badge hidden';
    actionsEl.appendChild(badgeEl);

    li.appendChild(authorEl);
    li.appendChild(bodyEl);
    li.appendChild(actionsEl);
    messageList.appendChild(li);
    messageList.scrollTop = messageList.scrollHeight;

    const replyCount = typeof message.thread_reply_count === 'number' ? message.thread_reply_count : 0;
    updateThreadBadge(message.id, replyCount);
  }

  function updateThreadBadge(rootId, count) {
    const li = messageList.querySelector(`li[data-message-id="${rootId}"]`);
    if (!li) return;
    const badgeEl = li.querySelector('.thread-badge');
    if (!badgeEl) return;
    badgeEl.dataset.count = String(count);
    if (count > 0) {
      badgeEl.textContent = formatThreadBadgeText(count);
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.textContent = '';
      badgeEl.classList.add('hidden');
    }
  }

  function renderHistory(messages) {
    messageList.textContent = '';
    for (const message of messages) {
      appendMessage(message);
    }
  }

  function openThreadPanel() {
    threadPanel.classList.add('open');
    threadOverlay.classList.remove('hidden');
  }

  function closeThreadPanel() {
    threadPanel.classList.remove('open');
    threadOverlay.classList.add('hidden');
    openThreadRootId = null;
    threadRootEl.textContent = '';
    threadReplyList.textContent = '';
  }

  function renderThreadRoot(root) {
    threadRootEl.textContent = '';

    const authorEl = document.createElement('span');
    authorEl.className = 'author';
    authorEl.textContent = root.author;

    const bodyEl = document.createElement('span');
    bodyEl.className = 'body';
    bodyEl.textContent = root.body;

    threadRootEl.appendChild(authorEl);
    threadRootEl.appendChild(bodyEl);
  }

  function appendThreadReply(reply) {
    const li = document.createElement('li');
    li.className = 'thread-reply-item';

    const authorEl = document.createElement('span');
    authorEl.className = 'author';
    authorEl.textContent = reply.author;

    const bodyEl = document.createElement('span');
    bodyEl.className = 'body';
    bodyEl.textContent = reply.body;

    li.appendChild(authorEl);
    li.appendChild(bodyEl);
    threadReplyList.appendChild(li);
    threadReplyList.scrollTop = threadReplyList.scrollHeight;
  }

  function renderThreadReplies(messages) {
    threadReplyList.textContent = '';
    for (const message of messages) {
      appendThreadReply(message);
    }
  }

  function openThread(rootId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'open_thread', rootId }));
  }

  function setStatus(text) {
    connectionStatus.textContent = text;
  }

  function updateRoomNameHeader() {
    const room = rooms.find((r) => r.id === currentRoomId);
    roomNameEl.textContent = room ? room.name : '';
  }

  function renderRooms() {
    roomList.textContent = '';
    for (const room of rooms) {
      const li = document.createElement('li');
      li.className = 'room-item';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'room-select';
      if (room.id === currentRoomId) {
        selectBtn.className += ' active';
      }
      selectBtn.textContent = room.name;
      selectBtn.addEventListener('click', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'switch_room', roomId: room.id }));
        closeSidebar();
      });
      li.appendChild(selectBtn);

      if (isAdmin) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'room-delete';
        deleteBtn.textContent = '削除';
        deleteBtn.addEventListener('click', () => {
          const confirmed = confirm(`ルーム「${room.name}」を削除しますか？`);
          if (!confirmed) return;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'delete_room', roomId: room.id }));
        });
        li.appendChild(deleteBtn);
      }

      roomList.appendChild(li);
    }
    updateRoomNameHeader();
  }

  function showAdminUi() {
    adminLoginToggle.classList.add('hidden');
    adminLoginForm.classList.add('hidden');
    createRoomForm.classList.remove('hidden');
    renderRooms();
  }

  /**
   * 管理者 UI を非表示に戻す降格処理。isAdmin を false にし、ルーム作成フォームを隠して
   * ログインボタンを再表示する。connect() 開始時・close 時・認証失敗時の3箇所で共有する。
   */
  function demoteAdmin() {
    isAdmin = false;
    adminLoginToggle.classList.remove('hidden');
    adminLoginForm.classList.add('hidden');
    createRoomForm.classList.add('hidden');
    renderRooms();
  }

  function connect(nick) {
    demoteAdmin();
    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', () => {
      setStatus('接続中');
      const savedAdminPassword = sessionStorage.getItem(ADMIN_PASSWORD_KEY);
      if (savedAdminPassword) {
        ws.send(JSON.stringify({ type: 'admin_auth', password: savedAdminPassword }));
      }
      ws.send(JSON.stringify({ type: 'join', nickname: nick }));
    });

    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === 'history') {
        showChat();
        setStatus('接続済み');
        currentRoomId = data.roomId;
        closeThreadPanel();
        renderHistory(data.messages || []);
        updateRoomNameHeader();
      } else if (data.type === 'rooms') {
        rooms = data.rooms || [];
        renderRooms();
      } else if (data.type === 'room_switched') {
        currentRoomId = data.roomId;
        closeThreadPanel();
        renderHistory(data.messages || []);
        updateRoomNameHeader();
        renderRooms();
      } else if (data.type === 'message') {
        const message = data.message;
        if (message.thread_root_id === null || message.thread_root_id === undefined) {
          appendMessage(message);
        } else {
          const rootId = message.thread_root_id;
          if (openThreadRootId === rootId) {
            appendThreadReply(message);
          }
          const li = messageList.querySelector(`li[data-message-id="${rootId}"]`);
          if (li) {
            const badgeEl = li.querySelector('.thread-badge');
            const currentCount = badgeEl ? parseInt(badgeEl.dataset.count || '0', 10) : 0;
            updateThreadBadge(rootId, currentCount + 1);
          }
        }
      } else if (data.type === 'thread_history') {
        openThreadRootId = data.rootId;
        renderThreadRoot(data.root);
        renderThreadReplies(data.messages || []);
        openThreadPanel();
      } else if (data.type === 'admin_auth_ok') {
        isAdmin = true;
        showAdminUi();
      } else if (data.type === 'error') {
        if (data.reason === 'bad_nickname') {
          showJoin('ニックネームが不正です（32文字以内・制御文字不可）');
          ws.close();
        } else if (data.reason === 'bad_admin_password' || data.reason === 'admin_disabled') {
          sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
          demoteAdmin();
          adminLoginError.textContent =
            data.reason === 'admin_disabled' ? '管理者機能は無効です' : '合言葉が違います';
        } else if (data.reason === 'bad_room_name' || data.reason === 'room_exists') {
          createRoomError.textContent =
            data.reason === 'room_exists' ? 'そのルーム名は既に存在します' : 'ルーム名が不正です（32文字以内・制御文字不可）';
        } else if (
          data.reason === 'forbidden' ||
          data.reason === 'cannot_delete_default' ||
          data.reason === 'room_not_found'
        ) {
          // 管理操作の失敗はアラートで通知する
          window.alert(`操作に失敗しました: ${data.reason}`);
        } else if (data.reason === 'thread_not_found') {
          closeThreadPanel();
          setStatus('エラー: thread_not_found');
        } else {
          setStatus(`エラー: ${data.reason}`);
        }
      }
    });

    ws.addEventListener('close', () => {
      setStatus('切断されました');
      demoteAdmin();
    });

    ws.addEventListener('error', () => {
      setStatus('接続エラー');
    });
  }

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = nicknameInput.value.trim();
    if (!value) {
      return;
    }
    nickname = value;
    localStorage.setItem(NICKNAME_KEY, nickname);
    connect(nickname);
  });

  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = messageInput.value.trim();
    if (!body || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({ type: 'message', body }));
    messageInput.value = '';
  });

  sidebarOpenBtn.addEventListener('click', () => {
    openSidebar();
  });

  sidebarCloseBtn.addEventListener('click', () => {
    closeSidebar();
  });

  sidebarOverlay.addEventListener('click', () => {
    closeSidebar();
  });

  adminLoginToggle.addEventListener('click', () => {
    adminLoginForm.classList.toggle('hidden');
  });

  adminLoginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const password = adminPasswordInput.value;
    if (!password || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    adminLoginError.textContent = '';
    sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
    ws.send(JSON.stringify({ type: 'admin_auth', password }));
  });

  createRoomForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = createRoomInput.value.trim();
    if (!name || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    createRoomError.textContent = '';
    ws.send(JSON.stringify({ type: 'create_room', name }));
    createRoomInput.value = '';
  });

  threadCloseBtn.addEventListener('click', () => {
    closeThreadPanel();
  });

  threadOverlay.addEventListener('click', () => {
    closeThreadPanel();
  });

  threadReplyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = threadReplyInput.value.trim();
    if (!body || !ws || ws.readyState !== WebSocket.OPEN || openThreadRootId === null) {
      return;
    }
    ws.send(JSON.stringify({ type: 'message', body, threadRootId: openThreadRootId }));
    threadReplyInput.value = '';
  });

  const savedNickname = localStorage.getItem(NICKNAME_KEY);
  if (savedNickname) {
    nicknameInput.value = savedNickname;
  }
})();
