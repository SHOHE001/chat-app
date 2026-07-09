(() => {
  const NICKNAME_KEY = 'chat-app:nickname';

  const joinOverlay = document.getElementById('join-overlay');
  const joinForm = document.getElementById('join-form');
  const nicknameInput = document.getElementById('nickname-input');
  const joinError = document.getElementById('join-error');

  const chatScreen = document.getElementById('chat-screen');
  const messageList = document.getElementById('message-list');
  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const connectionStatus = document.getElementById('connection-status');

  let ws = null;
  let nickname = '';

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

  function connect(nick) {
    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', () => {
      setStatus('接続中');
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
        renderHistory(data.messages || []);
      } else if (data.type === 'message') {
        appendMessage(data.message);
      } else if (data.type === 'error') {
        if (data.reason === 'bad_nickname') {
          showJoin('ニックネームが不正です（32文字以内・制御文字不可）');
          ws.close();
        } else {
          setStatus(`エラー: ${data.reason}`);
        }
      }
    });

    ws.addEventListener('close', () => {
      setStatus('切断されました');
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

  const savedNickname = localStorage.getItem(NICKNAME_KEY);
  if (savedNickname) {
    nicknameInput.value = savedNickname;
  }
})();
