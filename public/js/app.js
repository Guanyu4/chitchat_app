/* ChitChat — client app */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  token: localStorage.getItem('chitchat_token') || null,
  user: JSON.parse(localStorage.getItem('chitchat_user') || 'null'),
  conversations: [],
  activeConvId: null,
  messages: [],        // tin nhắn của conv đang mở
  hasMore: true,
  loadingMore: false,
  socket: null,
  typingUsers: new Map(),
  searchTimer: null,
};

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

const AVATAR_COLORS = ['#0084FF', '#7B61FF', '#00A550', '#E91E63', '#FF6B00', '#0097A7', '#8E24AA', '#C2185B'];
function avatarColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function avatarHTML(name, sizeClass = '', online = false) {
  return `<div class="avatar ${sizeClass}" style="background:${avatarColor(name)}">${esc(initials(name))}` +
    (online ? '<span class="online-dot"></span>' : '') + `</div>`;
}
function setAvatar(el, name, online) {
  el.innerHTML = avatarHTML(name, '', online);
  el.style.background = avatarColor(name);
  el.textContent = '';
  el.insertAdjacentHTML('afterbegin', esc(initials(name)));
  if (online) el.insertAdjacentHTML('beforeend', '<span class="online-dot"></span>');
}

function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const diff = now - d;
  if (diff < 60_000) return 'Vừa xong';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} giờ`;
  const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  if (diff < 7 * 86_400_000) return days[d.getDay()];
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function fmtMsgTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDateDivider(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Hôm nay';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return 'Hôm qua';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function fmtLastSeen(ts) {
  if (!ts) return 'Ngoại tuyến';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Vừa mới hoạt động';
  if (diff < 3_600_000) return `Hoạt động ${Math.floor(diff / 60_000)} phút trước`;
  if (diff < 86_400_000) return `Hoạt động ${Math.floor(diff / 3_600_000)} giờ trước`;
  return `Hoạt động ${fmtDateDivider(ts).toLowerCase()}`;
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}

/* ---------- Auth ---------- */
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#name-field').classList.toggle('hidden', mode === 'login');
  $('#auth-submit').textContent = mode === 'login' ? 'Đăng nhập' : 'Đăng ký';
  $('#auth-error').classList.add('hidden');
}
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    const payload = {
      email: $('#auth-email').value.trim(),
      password: $('#auth-pass').value,
    };
    let url = '/api/auth/login';
    if (authMode === 'register') {
      payload.name = $('#auth-name').value.trim();
      url = '/api/auth/register';
    }
    const { token, user } = await api(url, { method: 'POST', body: JSON.stringify(payload) });
    state.token = token;
    state.user = user;
    localStorage.setItem('chitchat_token', token);
    localStorage.setItem('chitchat_user', JSON.stringify(user));
    await enterApp();
  } catch (err) {
    const ee = $('#auth-error');
    ee.textContent = err.message;
    ee.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

function logout() {
  state.socket?.disconnect();
  state.socket = null;
  localStorage.removeItem('chitchat_token');
  localStorage.removeItem('chitchat_user');
  state.token = null; state.user = null;
  state.conversations = []; state.activeConvId = null; state.messages = [];
  document.body.classList.remove('chat-open');
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}
$('#btn-logout').onclick = logout;

/* ---------- App init ---------- */
async function enterApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  setAvatar($('#me-avatar'), state.user.name, false);
  $('#me-name').textContent = state.user.name;
  await loadConversations();
  connectSocket();
  if (window.innerWidth > 768 && state.conversations.length > 0) {
    openConversation(state.conversations[0].id);
  }
}

async function loadConversations() {
  try {
    const { conversations } = await api('/api/conversations');
    state.conversations = conversations;
    renderConvList();
  } catch (err) {
    if (err.message.includes('Token')) logout();
  }
}

/* ---------- Sidebar: danh sách hội thoại ---------- */
function convPeer(conv) {
  return conv.type === 'private' ? conv.peer : null;
}

function renderConvList(filter = '') {
  const list = $('#conv-list');
  const q = filter.trim().toLowerCase();
  const convs = state.conversations.filter((c) =>
    !q || c.displayName.toLowerCase().includes(q)
  );
  if (!convs.length) {
    list.innerHTML = `<div class="list-empty">${q ? 'Không tìm thấy cuộc trò chuyện nào.' : 'Chưa có cuộc trò chuyện nào.<br>Tìm người dùng ở ô tìm kiếm để bắt đầu chat!'}</div>`;
    return;
  }
  list.innerHTML = convs.map((c) => {
    const peer = convPeer(c);
    const preview = c.last_content
      ? (c.last_type === 'image' ? '📷 Đã gửi một ảnh' : c.last_content)
      : 'Bắt đầu cuộc trò chuyện';
    const prefix = c.last_sender_id === state.user.id ? 'Bạn: ' : '';
    const online = c.type === 'private' && peer?.online_status;
    return `<div class="conv-item ${c.id === state.activeConvId ? 'active' : ''}" data-id="${c.id}">
      ${avatarHTML(c.displayName, '', online)}
      <div class="conv-main">
        <div class="conv-top">
          <div class="conv-name">${esc(c.displayName)}</div>
          <div class="conv-time">${fmtListTime(c.last_at)}</div>
        </div>
        <div class="conv-bottom">
          <div class="conv-preview ${c.unread_count > 0 ? 'unread' : ''}">${esc(prefix + preview)}</div>
          ${c.unread_count > 0 ? `<div class="unread-badge">${c.unread_count > 99 ? '99+' : c.unread_count}</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  $$('#conv-list .conv-item').forEach((el) => {
    el.onclick = () => openConversation(Number(el.dataset.id));
  });
}

$('#search-input').addEventListener('input', (e) => {
  const q = e.target.value;
  renderConvList(q);
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => searchUsers(q), 300);
});

async function searchUsers(q) {
  const box = $('#user-results');
  q = q.trim();
  if (q.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  try {
    const { users } = await api(`/api/users?q=${encodeURIComponent(q)}`);
    if (!users.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `<div class="section-title">Mọi người</div>` + users.map((u) => `
      <div class="conv-item" data-uid="${u.id}">
        ${avatarHTML(u.name, 'avatar-sm', !!u.online_status)}
        <div class="conv-main">
          <div class="conv-name">${esc(u.name)}</div>
          <div class="conv-preview">${esc(u.email)}</div>
        </div>
      </div>`).join('');
    $$('#user-results .conv-item').forEach((el) => {
      el.onclick = () => startPrivateChat(Number(el.dataset.uid));
    });
  } catch { /* bỏ qua */ }
}

async function startPrivateChat(userId) {
  try {
    const { conversationId } = await api('/api/conversations/private', {
      method: 'POST', body: JSON.stringify({ userId }),
    });
    state.socket?.emit('conv:join', { conversationId });
    $('#search-input').value = '';
    $('#user-results').classList.add('hidden');
    await loadConversations();
    openConversation(conversationId);
  } catch (err) { toast(err.message); }
}

$('#btn-new-chat').onclick = () => {
  $('#search-input').focus();
  toast('Nhập tên hoặc email để tìm người dùng');
};

/* ---------- Chat: mở hội thoại ---------- */
function getConv(id) {
  return state.conversations.find((c) => c.id === id);
}

async function openConversation(id) {
  state.activeConvId = id;
  state.messages = [];
  state.hasMore = true;
  state.typingUsers.clear();
  state.socket?.emit('conv:join', { conversationId: id });
  updateTypingBar();
  renderConvList($('#search-input').value);
  const conv = getConv(id);
  if (!conv) return;

  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');
  document.body.classList.add('chat-open');

  setAvatar($('#chat-avatar'), conv.displayName, conv.type === 'private' && conv.peer?.online_status);
  $('#chat-name').textContent = conv.displayName;
  updatePeerStatus(conv);

  $('#messages').innerHTML = '';
  await loadMoreMessages(true);
  markSeen();
  $('#msg-input').focus();
}

function updatePeerStatus(conv) {
  const el = $('#chat-status');
  if (conv.type !== 'private' || !conv.peer) { el.textContent = ''; el.classList.remove('online'); return; }
  if (conv.peer.online_status) { el.textContent = 'Đang hoạt động'; el.classList.add('online'); }
  else { el.textContent = fmtLastSeen(conv.peer.last_seen); el.classList.remove('online'); }
}

$('#btn-back').onclick = () => {
  document.body.classList.remove('chat-open');
  state.activeConvId = null;
  state.messages = [];
  renderConvList($('#search-input').value);
};

/* ---------- Chat: tin nhắn ---------- */
function bubbleHTML(msg) {
  if (msg.type === 'image') {
    return `<div class="bubble"><img class="msg-img" src="${esc(msg.content)}" alt="Ảnh" loading="lazy"></div>`;
  }
  return `<div class="bubble">${esc(msg.content)}</div>`;
}

function ticksHTML(status) {
  if (status === 'seen') return `<div class="ticks seen" title="Đã xem">✓✓</div>`;
  if (status === 'delivered') return `<div class="ticks delivered" title="Đã nhận">✓✓</div>`;
  return `<div class="ticks sent" title="Đã gửi">✓</div>`;
}

function msgRowHTML(msg, prevMsg) {
  const mine = msg.sender_id === state.user.id;
  const grouped = prevMsg && prevMsg.sender_id === msg.sender_id &&
    (msg.created_at - prevMsg.created_at) < 120_000;
  const showAvatar = !mine && !grouped;
  const avatarPart = mine ? '' :
    (showAvatar
      ? avatarHTML(msg.sender_name || '?', 'avatar-xs')
      : '<div class="msg-avatar-spacer"></div>');
  return `<div class="msg-row ${mine ? 'me' : 'them'} ${grouped ? 'grouped' : ''}"
      data-id="${msg.id}" ${msg.clientId ? `data-client="${msg.clientId}"` : ''}>
    ${avatarPart}
    <div class="msg-body">
      ${bubbleHTML(msg)}
      <div class="msg-time">${fmtMsgTime(msg.created_at)}</div>
      ${mine ? `<div class="ticks-wrap">${ticksHTML(msg.status)}</div>` : ''}
    </div>
  </div>`;
}

function appendMessage(msg, { scroll = true } = {}) {
  const box = $('#messages');
  // chống trùng (theo id thật hoặc clientId tạm)
  if (box.querySelector(`[data-id="${msg.id}"]`)) return;
  if (msg.clientId) {
    const tmp = box.querySelector(`[data-client="${msg.clientId}"]`);
    if (tmp) {
      tmp.dataset.id = msg.id;
      tmp.removeAttribute('data-client');
      const tw = tmp.querySelector('.ticks-wrap');
      if (tw) tw.innerHTML = ticksHTML(msg.status);
      const m = state.messages.find((x) => x.clientId === msg.clientId);
      if (m) Object.assign(m, msg);
      refreshTicks();
      if (scroll) box.scrollTop = box.scrollHeight;
      return;
    }
  }
  const prev = state.messages[state.messages.length - 1];
  // divider ngày
  if (!prev || fmtDateDivider(prev.created_at) !== fmtDateDivider(msg.created_at)) {
    box.insertAdjacentHTML('beforeend', `<div class="date-divider">${fmtDateDivider(msg.created_at)}</div>`);
  }
  box.insertAdjacentHTML('beforeend', msgRowHTML(msg, prev));
  state.messages.push(msg);
  bindMsgImages(box);
  refreshTicks();
  if (scroll) box.scrollTop = box.scrollHeight;
}

function prependMessages(msgs) {
  const box = $('#messages');
  const oldH = box.scrollHeight;
  let html = '';
  let prev = null;
  for (const m of msgs) {
    if (!prev || fmtDateDivider(prev.created_at) !== fmtDateDivider(m.created_at)) {
      html += `<div class="date-divider">${fmtDateDivider(m.created_at)}</div>`;
    }
    html += msgRowHTML(m, prev);
    prev = m;
  }
  box.insertAdjacentHTML('afterbegin', html);
  state.messages = [...msgs, ...state.messages];
  bindMsgImages(box);
  refreshTicks();
  box.scrollTop = box.scrollHeight - oldH;
}

function bindMsgImages(scope) {
  scope.querySelectorAll('.msg-img').forEach((img) => {
    if (img._bound) return;
    img._bound = true;
    img.onclick = () => {
      $('#lightbox-img').src = img.src;
      $('#lightbox').classList.remove('hidden');
    };
  });
}
$('#lightbox-close').onclick = () => $('#lightbox').classList.add('hidden');
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden');
});

// chỉ hiện ticks ở tin nhắn cuối cùng của mình
function refreshTicks() {
  const rows = $$('#messages .msg-row.me');
  rows.forEach((r) => {
    const w = r.querySelector('.ticks-wrap');
    if (w) w.style.display = 'none';
  });
  const last = rows[rows.length - 1];
  if (last) {
    const w = last.querySelector('.ticks-wrap');
    if (w) w.style.display = '';
  }
}

async function loadMoreMessages(first = false) {
  if (state.loadingMore || !state.hasMore || !state.activeConvId) return;
  state.loadingMore = true;
  try {
    const before = first ? null : state.messages[0]?.id;
    const qs = before ? `?before=${before}&limit=40` : '?limit=40';
    const { messages } = await api(`/api/conversations/${state.activeConvId}/messages${qs}`);
    if (!messages.length) { state.hasMore = false; return; }
    if (messages.length < 40) state.hasMore = false;
    if (first) {
      const box = $('#messages');
      let html = '', prev = null;
      for (const m of messages) {
        if (!prev || fmtDateDivider(prev.created_at) !== fmtDateDivider(m.created_at)) {
          html += `<div class="date-divider">${fmtDateDivider(m.created_at)}</div>`;
        }
        html += msgRowHTML(m, prev);
        prev = m;
      }
      box.innerHTML = html;
      state.messages = messages;
      bindMsgImages(box);
      refreshTicks();
      box.scrollTop = box.scrollHeight;
    } else {
      prependMessages(messages);
    }
  } catch (err) { toast(err.message); }
  finally { state.loadingMore = false; }
}

$('#messages').addEventListener('scroll', (e) => {
  if (e.target.scrollTop < 60) loadMoreMessages();
});

/* ---------- Gửi tin nhắn ---------- */
function sendText() {
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text || !state.activeConvId) return;
  input.value = '';
  stopTyping();
  sendMessage({ content: text, type: 'text' });
}

function sendMessage({ content, type }) {
  const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const optimistic = {
    id: clientId, clientId,
    conversation_id: state.activeConvId,
    sender_id: state.user.id,
    sender_name: state.user.name,
    content, type: type || 'text',
    status: 'sent', created_at: Date.now(),
  };
  appendMessage(optimistic);
  state.socket.emit('message:send',
    { conversationId: state.activeConvId, content, type: type || 'text', clientId },
    (res) => {
      if (res?.error) {
        toast(res.error);
        document.querySelector(`[data-client="${clientId}"]`)?.remove();
        state.messages = state.messages.filter((m) => m.clientId !== clientId);
      } else if (res?.message) {
        appendMessage({ ...res.message, clientId });
        updateConvPreview(state.activeConvId, res.message);
      }
    });
}

$('#btn-send').onclick = sendText;
$('#msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

/* ---------- Upload ảnh ---------- */
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.activeConvId) return;
  if (file.size > 5 * 1024 * 1024) return toast('Ảnh tối đa 5MB.');
  const fd = new FormData();
  fd.append('image', file);
  try {
    toast('Đang tải ảnh lên...');
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload thất bại');
    sendMessage({ content: data.url, type: 'image' });
  } catch (err) { toast(err.message); }
});

/* ---------- Emoji ---------- */
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😡','👍','👎','🙏','👏','💪','🔥','❤️','💔','💯','✨','🎉','🥳','😴','🤯','😇','🤗','😜','🤪','😬','🙄','💤','👀','🙌','🤝','💡','📌','✅','❌','⭐','🌙','☀️','🌧️','🍕','☕','🍺','🎵','⚽','🚗','✈️','🏠','💼','📱','💻','🎮','📚','💰','🎁','💎','🚀','🌈','☃️','🎃','👻'];
function buildEmojiPanel() {
  $('#emoji-panel').innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join('');
  $$('#emoji-panel button').forEach((b) => {
    b.onclick = () => {
      const input = $('#msg-input');
      const s = input.selectionStart || input.value.length;
      input.value = input.value.slice(0, s) + b.textContent + input.value.slice(input.selectionEnd || s);
      input.focus();
      input.selectionStart = input.selectionEnd = s + b.textContent.length;
    };
  });
}
buildEmojiPanel();
$('#btn-emoji').onclick = (e) => {
  e.stopPropagation();
  $('#emoji-panel').classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emoji-panel') && !e.target.closest('#btn-emoji')) {
    $('#emoji-panel').classList.add('hidden');
  }
});

/* ---------- Typing ---------- */
let typingIdleTimer = null;
let typingActive = false;
$('#msg-input').addEventListener('input', () => {
  if (!state.activeConvId || !state.socket) return;
  if (!typingActive) {
    typingActive = true;
    state.socket.emit('typing:start', { conversationId: state.activeConvId });
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, 1500);
});
function stopTyping() {
  if (typingActive && state.activeConvId) {
    state.socket?.emit('typing:stop', { conversationId: state.activeConvId });
  }
  typingActive = false;
  clearTimeout(typingIdleTimer);
}

function updateTypingBar() {
  const bar = $('#typing-bar');
  const names = [...state.typingUsers.values()];
  if (!names.length || !state.activeConvId) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const conv = getConv(state.activeConvId);
  setAvatar($('#typing-avatar'), names[0], false);
  $('#typing-avatar').className = 'avatar avatar-xs';
  $('#typing-avatar').style.background = avatarColor(names[0]);
  $('#typing-avatar').textContent = initials(names[0]);
  bar.querySelector('.typing-text')?.remove();
  bar.insertAdjacentHTML('beforeend',
    `<div class="typing-text">${esc(names.length === 1 ? `${names[0]} đang nhập...` : `${names.length} người đang nhập...`)}</div>`);
}

/* ---------- Đã xem ---------- */
function markSeen() {
  if (!state.activeConvId || !state.socket) return;
  const conv = getConv(state.activeConvId);
  if (conv && conv.unread_count > 0) {
    conv.unread_count = 0;
    renderConvList($('#search-input').value);
  }
  state.socket.emit('messages:seen', { conversationId: state.activeConvId });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeConvId) markSeen();
});

/* ---------- Cập nhật preview sidebar ---------- */
function updateConvPreview(convId, msg) {
  const conv = getConv(convId);
  if (!conv) { loadConversations(); return; }
  conv.last_content = msg.content;
  conv.last_type = msg.type;
  conv.last_sender_id = msg.sender_id;
  conv.last_at = msg.created_at;
  // đưa lên đầu
  state.conversations = [conv, ...state.conversations.filter((c) => c.id !== convId)];
  renderConvList($('#search-input').value);
}

/* ---------- Socket ---------- */
function connectSocket() {
  state.socket?.disconnect();
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  socket.on('connect_error', () => {
    if (!socket._errShown) { socket._errShown = true; toast('Mất kết nối real-time, đang thử lại...'); }
  });
  socket.on('connect', () => { socket._errShown = false; });

  socket.on('message:new', (msg) => {
    const conv = getConv(msg.conversation_id);
    if (msg.conversation_id === state.activeConvId) {
      appendMessage(msg);
      markSeen();
    } else if (conv) {
      conv.unread_count = (conv.unread_count || 0) + (msg.sender_id === state.user.id ? 0 : 1);
    }
    updateConvPreview(msg.conversation_id, msg);
  });

  socket.on('typing:update', ({ conversationId, userId, name, typing }) => {
    if (conversationId !== state.activeConvId || userId === state.user.id) return;
    if (typing) state.typingUsers.set(userId, name);
    else state.typingUsers.delete(userId);
    updateTypingBar();
  });

  socket.on('user:online', ({ userId }) => {
    let changed = false;
    for (const c of state.conversations) {
      if (c.type === 'private' && c.peer?.id === userId) { c.peer.online_status = 1; changed = true; }
      if (c.id === state.activeConvId) updatePeerStatus(c);
    }
    if (changed) renderConvList($('#search-input').value);
  });

  socket.on('user:offline', ({ userId, lastSeen }) => {
    let changed = false;
    for (const c of state.conversations) {
      if (c.type === 'private' && c.peer?.id === userId) {
        c.peer.online_status = 0; c.peer.last_seen = lastSeen; changed = true;
      }
      if (c.id === state.activeConvId) updatePeerStatus(c);
    }
    if (changed) renderConvList($('#search-input').value);
  });

  socket.on('messages:seen', ({ conversationId, seenBy }) => {
    if (conversationId !== state.activeConvId || seenBy === state.user.id) return;
    let changed = false;
    for (const m of state.messages) {
      if (m.sender_id === state.user.id && m.status !== 'seen') { m.status = 'seen'; changed = true; }
    }
    if (changed) {
      $$('#messages .msg-row.me').forEach((row) => {
        const id = row.dataset.id;
        const m = state.messages.find((x) => String(x.id) === String(id));
        const w = row.querySelector('.ticks-wrap');
        if (m && w) w.innerHTML = ticksHTML(m.status);
      });
      refreshTicks();
    }
  });
}

/* ---------- Khởi động ---------- */
(async function boot() {
  if (state.token && state.user) {
    try {
      const { user } = await api('/api/auth/me');
      state.user = user;
      localStorage.setItem('chitchat_user', JSON.stringify(user));
      await enterApp();
      return;
    } catch { logout(); return; }
  }
  $('#auth-view').classList.remove('hidden');
})();
