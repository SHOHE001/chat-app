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

  let ws = null;
  let nickname = '';
  let isAdmin = false;
  let currentRoomId = null;
  let rooms = [];

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

  function appendMessage(message) {
    const li = document.createElement('li');
    li.className = 'message-item';

    const authorEl = document.createElement('span');
    authorEl.className = 'author';
    authorEl.textContent = message.author;

    const bodyEl = document.createElement('span');
    bodyEl.className = 'body';
    bodyEl.textContent = message.body;

    li.appendChild(authorEl);
    li.appendChild(bodyEl);
    messageList.appendChild(li);
    messageList.scrollTop = messageList.scrollHeight;
  }

  function renderHistory(messages) {
    messageList.textContent = '';
    for (const message of messages) {
      appendMessage(message);
    }
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
        renderHistory(data.messages || []);
        updateRoomNameHeader();
      } else if (data.type === 'rooms') {
        rooms = data.rooms || [];
        renderRooms();
      } else if (data.type === 'room_switched') {
        currentRoomId = data.roomId;
        renderHistory(data.messages || []);
        updateRoomNameHeader();
        renderRooms();
      } else if (data.type === 'message') {
        appendMessage(data.message);
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

  const savedNickname = localStorage.getItem(NICKNAME_KEY);
  if (savedNickname) {
    nicknameInput.value = savedNickname;
  }
})();
