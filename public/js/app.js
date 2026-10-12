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
  contacts: [],
  view: 'chats', // 'chats' | 'archived'
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
function avatarHTML(name, sizeClass = '', online = false, avatarUrl = null) {
  // Nếu ảnh lỗi (404) → onerror tự gỡ img, hiện chữ cái thay thế
  const inner = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" loading="lazy" onerror="this.remove()">${esc(initials(name))}`
    : esc(initials(name));
  return `<div class="avatar ${sizeClass}" style="background:${avatarColor(name)}">${inner}` +
    (online ? '<span class="online-dot"></span>' : '') + `</div>`;
}
function setAvatar(el, name, online, avatarUrl = null) {
  el.style.background = avatarColor(name);
  el.innerHTML = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" onerror="this.remove()">${esc(initials(name))}`
    : esc(initials(name));
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
  if (callState.pc || callState.pendingOffer) cleanupCall();
  localStorage.removeItem('chitchat_token');
  localStorage.removeItem('chitchat_user');
  state.token = null; state.user = null;
  state.conversations = []; state.activeConvId = null; state.messages = [];
  state.contacts = []; state.view = 'chats';
  $('#archived-banner').classList.add('hidden');
  document.body.classList.remove('chat-open');
  delete document.body.dataset.sideTab;
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}
$('#btn-logout').onclick = logout;

/* ---------- App init ---------- */
async function enterApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  setAvatar($('#me-avatar'), state.user.name, false, state.user.avatar_url);
  $('#me-name').textContent = state.user.name;
  await loadConversations();
  await loadContacts();
  connectSocket();
  if (window.innerWidth > 768 && state.conversations.length > 0) {
    openConversation(state.conversations[0].id);
  }
}

async function loadConversations(filter = '') {
  try {
    const qs = filter ? `?filter=${filter}` : '';
    const { conversations } = await api('/api/conversations' + qs);
    state.conversations = conversations;
    renderConvList();
  } catch (err) {
    if (err.message.includes('Token')) logout();
  }
}

/* ---------- Danh bạ: người liên hệ ---------- */
function fmtContactSeen(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return m < 1 ? 'Vừa xong' : `${m} phút`;
  }
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} giờ`;
  return fmtDateDivider(ts);
}

async function loadContacts() {
  try {
    const { contacts } = await api('/api/contacts');
    state.contacts = contacts;
    renderContacts();
  } catch { /* bỏ qua */ }
}

function renderContacts() {
  const html = state.contacts.length ? state.contacts.map((c) => {
    const online = !!c.online_status;
    return `<div class="contact-item" data-uid="${c.id}">
      ${avatarHTML(c.name, 'avatar-sm', online, c.avatar_url)}
      <div class="contact-main">
        <div class="contact-name">${esc(c.name)}</div>
        ${online ? '' : `<div class="contact-sub">${fmtContactSeen(c.last_seen)}</div>`}
      </div>
    </div>`;
  }).join('') : `<div class="list-empty">Chưa có người liên hệ nào.</div>`;
  for (const id of ['#contacts-list', '#contacts-list-mobile']) {
    const box = $(id);
    if (box) box.innerHTML = html;
  }
  $$('.contact-item').forEach((el) => {
    el.onclick = () => startPrivateChat(Number(el.dataset.uid));
  });
}

// Tabs mobile: Đoạn chat / Danh bạ
$$('#sidebar-tabs .sidebar-tab').forEach((btn) => {
  btn.onclick = () => {
    $$('#sidebar-tabs .sidebar-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.body.dataset.sideTab = btn.dataset.tab;
    if (btn.dataset.tab === 'contacts') loadContacts();
  };
});

/* ---------- Chế độ xem: chat / đã lưu trữ ---------- */
async function setView(view) {
  state.view = view;
  const archived = view === 'archived';
  $('#archived-banner').classList.toggle('hidden', !archived);
  $('#btn-archive-view').classList.toggle('active-view', archived);
  await loadConversations(archived ? 'archived' : '');
}
$('#btn-archive-view').onclick = () => setView(state.view === 'archived' ? 'chats' : 'archived');
$('#btn-back-chats').onclick = () => setView('chats');

/* ---------- Info panel: thông tin đoạn chat ---------- */
const THEME_COLORS = ['#0084FF', '#7B61FF', '#E91E63', '#E0245E', '#FF6B00', '#00A550', '#0097A7'];
function applyTheme(convId) {
  const c = localStorage.getItem(`chitchat_theme_${convId}`) || '#0084FF';
  document.documentElement.style.setProperty('--bubble-me', c);
}

/* ---------- Hình nền đoạn chat ---------- */
function applyWallpaper(conv) {
  const box = $('#messages');
  const wp = conv?.wallpaper || null;
  if (wp) {
    box.classList.add('has-wallpaper');
    box.style.backgroundImage = `url("${wp}")`;
  } else {
    box.classList.remove('has-wallpaper');
    box.style.backgroundImage = '';
  }
  const prev = $('#wallpaper-preview');
  if (prev) prev.style.backgroundImage = wp ? `url("${wp}")` : '';
  $('#btn-wallpaper-remove')?.classList.toggle('hidden', !wp);
}

$('#btn-wallpaper').onclick = () => $('#wallpaper-input').click();
$('#wallpaper-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const conv = getActiveConv();
  if (!file || !conv) return;
  if (!file.type.startsWith('image/')) return toast('Hình nền phải là file ảnh.');
  if (file.size > 10 * 1024 * 1024) return toast('Ảnh tối đa 10MB.');
  const fd = new FormData();
  fd.append('file', file);
  try {
    toast('Đang tải hình nền lên...');
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: fd,
    });
    const upData = await up.json();
    if (!up.ok) throw new Error(upData.error || 'Upload thất bại');
    await api(`/api/conversations/${conv.id}/wallpaper`, {
      method: 'POST', body: JSON.stringify({ wallpaper: upData.url }),
    });
    conv.wallpaper = upData.url;
    applyWallpaper(conv);
    toast('Đã đổi hình nền! 🎨');
  } catch (err) { toast(err.message); }
});
$('#btn-wallpaper-remove').onclick = async () => {
  const conv = getActiveConv();
  if (!conv) return;
  try {
    await api(`/api/conversations/${conv.id}/wallpaper`, {
      method: 'POST', body: JSON.stringify({ wallpaper: null }),
    });
    conv.wallpaper = null;
    applyWallpaper(conv);
    toast('Đã xóa hình nền.');
  } catch (err) { toast(err.message); }
};

function getActiveConv() {
  return state.conversations.find((c) => c.id === state.activeConvId);
}

function openInfoPane() {
  const conv = getActiveConv();
  if (!conv) return;
  $('#info-name').textContent = conv.name;
  setAvatar($('#info-avatar'), conv.name, conv.online,
    conv.type === 'private' ? conv.peer?.avatar_url || null : null);
  const st = $('#info-status');
  if (conv.type === 'private') {
    if (conv.online) { st.textContent = 'Đang hoạt động'; st.classList.add('online'); }
    else { st.textContent = conv.lastSeen ? 'Hoạt động ' + fmtLastSeen(conv.lastSeen).replace('Hoạt động ', '') : ''; st.classList.remove('online'); }
  } else {
    st.textContent = `${conv.memberCount || ''} thành viên`.trim();
    st.classList.remove('online');
  }
  $('#info-mute-label').textContent = conv.muted ? 'Bật lại thông báo' : 'Tắt thông báo';
  $('#info-archive-btn').textContent = conv.archived ? '📤 Bỏ lưu trữ đoạn chat' : '📦 Lưu trữ đoạn chat';
  // reset accordion + search
  $$('.acc-head').forEach((h) => { h.classList.remove('open'); $('#' + h.dataset.acc).classList.add('hidden'); });
  $('#info-search-box').classList.add('hidden');
  $('#info-search-input').value = '';
  $('#info-search-results').innerHTML = '';
  renderInfoMembers(conv);
  renderThemeDots(conv.id);
  applyWallpaper(conv);
  loadInfoMedia(conv.id);
  $('#info-pane').classList.remove('hidden');
}
function closeInfoPane() { $('#info-pane').classList.add('hidden'); }
$('#chat-peer-btn').onclick = openInfoPane;
$('#info-close').onclick = closeInfoPane;
$('#info-back').onclick = closeInfoPane;

$$('.acc-head').forEach((h) => {
  h.onclick = () => {
    const body = $('#' + h.dataset.acc);
    const open = body.classList.toggle('hidden');
    h.classList.toggle('open', !open);
  };
});

function renderInfoMembers(conv) {
  const box = $('#acc-chat-info');
  if (conv.type === 'group' && conv.members?.length) {
    box.innerHTML = conv.members.map((m) =>
      `<div class="acc-member">${avatarHTML(m.name, 'avatar-sm', !!m.online_status, m.avatar_url)}<span>${esc(m.name)}</span></div>`
    ).join('');
  } else if (conv.type === 'private' && conv.peer) {
    box.innerHTML = `<div class="acc-member">${avatarHTML(conv.peer.name, 'avatar-sm', !!conv.peer.online_status, conv.peer.avatar_url)}<span>${esc(conv.peer.name)}</span></div>
      <p style="margin-top:8px">Đoạn chat 1-1 giữa bạn và ${esc(conv.peer.name)}.</p>`;
  } else {
    box.innerHTML = '<p>Không có thông tin thêm.</p>';
  }
}

function renderThemeDots(convId) {
  const cur = localStorage.getItem(`chitchat_theme_${convId}`) || '#0084FF';
  $('#theme-dots').innerHTML = THEME_COLORS.map((c) =>
    `<button class="theme-dot${c === cur ? ' selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join('');
  $$('#theme-dots .theme-dot').forEach((d) => {
    d.onclick = () => {
      localStorage.setItem(`chitchat_theme_${convId}`, d.dataset.color);
      applyTheme(convId);
      renderThemeDots(convId);
    };
  });
}

async function loadInfoMedia(convId) {
  const box = $('#info-media');
  box.innerHTML = '<p>Đang tải...</p>';
  try {
    const { media } = await api(`/api/conversations/${convId}/media`);
    if (!media.length) { box.innerHTML = '<p>Chưa có file nào được chia sẻ.</p>'; return; }
    const imgs = media.filter((m) => m.type === 'image');
    const audios = media.filter((m) => m.type === 'audio');
    box.innerHTML =
      (imgs.length ? `<div class="media-grid">${imgs.map((m) =>
        `<img src="${esc(m.content)}" loading="lazy" data-src="${esc(m.content)}" onerror="this.style.display='none'">`).join('')}</div>` : '') +
      (audios.length ? `<div class="media-audio">${audios.map((m) =>
        `<audio controls preload="none" src="${esc(m.content)}" style="width:100%;margin-top:6px"></audio>`).join('')}</div>` : '');
    box.querySelectorAll('img').forEach((img) => {
      img.onclick = () => openLightbox(img.dataset.src);
    });
  } catch { box.innerHTML = '<p>Không tải được.</p>'; }
}

// Tắt / bật thông báo
$('#info-mute-btn').onclick = async () => {
  const conv = getActiveConv();
  if (!conv) return;
  const muted = !conv.muted;
  try {
    await api(`/api/conversations/${conv.id}/mute`, {
      method: 'POST', body: JSON.stringify({ muted }),
    });
    conv.muted = muted;
    $('#info-mute-label').textContent = muted ? 'Bật lại thông báo' : 'Tắt thông báo';
    toast(muted ? 'Đã tắt thông báo đoạn chat.' : 'Đã bật lại thông báo.');
  } catch (err) { toast(err.message); }
};

// Lưu trữ / bỏ lưu trữ
$('#info-archive-btn').onclick = async () => {
  const conv = getActiveConv();
  if (!conv) return;
  const archived = !conv.archived;
  try {
    await api(`/api/conversations/${conv.id}/archive`, {
      method: 'POST', body: JSON.stringify({ archived }),
    });
    conv.archived = archived;
    toast(archived ? 'Đã lưu trữ đoạn chat.' : 'Đã bỏ lưu trữ.');
    closeInfoPane();
    await loadConversations(state.view === 'archived' ? 'archived' : '');
    if (archived && state.view !== 'archived') {
      // rời khỏi chat vừa lưu trữ
      state.activeConvId = null;
      $('#chat-empty').classList.remove('hidden');
      $('#chat-main').classList.add('hidden');
      document.body.classList.remove('chat-open');
    }
  } catch (err) { toast(err.message); }
};

// Tìm kiếm trong đoạn chat
$('#info-search-btn').onclick = () => {
  $('#info-search-box').classList.toggle('hidden');
  $('#info-search-input').focus();
};
let infoSearchTimer = null;
$('#info-search-input').addEventListener('input', (e) => {
  clearTimeout(infoSearchTimer);
  const q = e.target.value.trim();
  infoSearchTimer = setTimeout(async () => {
    const box = $('#info-search-results');
    if (q.length < 2 || !state.activeConvId) { box.innerHTML = ''; return; }
    try {
      const { results } = await api(`/api/conversations/${state.activeConvId}/search?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.length ? results.map((r) =>
        `<div class="info-search-result" data-id="${r.id}">
           <div>${esc(r.type === 'call' ? '📞 Cuộc gọi' : r.content.slice(0, 80))}</div>
           <div class="s-meta">${esc(r.sender_name)} • ${fmtDateDivider(r.created_at)} ${fmtClock(r.created_at)}</div>
         </div>`
      ).join('') : '<p style="padding:8px 4px">Không tìm thấy.</p>';
      box.querySelectorAll('.info-search-result').forEach((el) => {
        el.onclick = () => jumpToMessage(Number(el.dataset.id));
      });
    } catch { /* ignore */ }
  }, 350);
});

// Trang cá nhân
$('#info-profile-btn').onclick = () => {
  const conv = getActiveConv();
  if (!conv || conv.type !== 'private' || !conv.peer) return toast('Chỉ xem được trang cá nhân của chat 1-1.');
  $('#profile-name').textContent = conv.peer.name;
  $('#profile-email').textContent = conv.peer.email || '';
  setAvatar($('#profile-avatar'), conv.peer.name, !!conv.peer.online_status, conv.peer.avatar_url);
  $('#profile-status').textContent = conv.peer.online_status ? '🟢 Đang hoạt động'
    : (conv.peer.last_seen ? 'Hoạt động ' + fmtLastSeen(conv.peer.last_seen) : '');
  $('#profile-modal').classList.remove('hidden');
};

// Đóng modal
$$('[data-close]').forEach((btn) => {
  btn.onclick = () => $('#' + btn.dataset.close).classList.add('hidden');
});
$$('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
});
$('#btn-help').onclick = () => $('#help-modal').classList.remove('hidden');

function updateContactStatus(userId, online, lastSeen) {
  let changed = false;
  for (const c of state.contacts) {
    if (c.id === userId) {
      c.online_status = online ? 1 : 0;
      if (lastSeen) c.last_seen = lastSeen;
      changed = true;
    }
  }
  if (changed) {
    state.contacts.sort((a, b) => (b.online_status - a.online_status) || (b.last_seen - a.last_seen));
    renderContacts();
  }
}

/* ---------- Gọi thoại / video (WebRTC P2P, signaling qua Socket.io) ---------- */
const callState = {
  pc: null, stream: null, callId: null, kind: null, conversationId: null,
  peerName: '', peerAvatar: null, isCaller: false, pendingOffer: null,
  startTime: 0, timerInt: null, logSent: false, micOn: true, camOn: true,
};
const RTC_CONF = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function showCallUI(mode) {
  $('#call-overlay').classList.remove('hidden');
  $('#call-name').textContent = callState.peerName;
  setAvatar($('#call-avatar'), callState.peerName, false, callState.peerAvatar);
  const incoming = mode === 'incoming';
  $('#call-incoming').classList.toggle('hidden', !incoming);
  $('#call-controls').classList.toggle('hidden', incoming);
  $('#call-status').textContent = incoming
    ? `Cuộc gọi ${callState.kind === 'video' ? 'video' : 'thoại'} đến...`
    : 'Đang gọi...';
  $('#call-timer').classList.add('hidden');
  $('#call-center').style.display = '';
  $('#call-remote-video').style.display = 'none';
  $('#call-local-video').classList.add('hidden');
  $('#call-cam-btn').classList.toggle('hidden', callState.kind !== 'video');
  $('#call-mic-btn').classList.remove('off');
  $('#call-cam-btn').classList.remove('off');
  callState.micOn = true; callState.camOn = true;
}
function hideCallUI() {
  $('#call-overlay').classList.add('hidden');
  stopRingtone();
  clearInterval(callState.timerInt);
  const rv = $('#call-remote-video'); rv.removeAttribute('src'); rv.srcObject = null;
  const lv = $('#call-local-video'); lv.removeAttribute('src'); lv.srcObject = null;
}
function startCallTimer() {
  callState.startTime = Date.now();
  $('#call-timer').classList.remove('hidden');
  $('#call-status').textContent = 'Đã kết nối';
  clearInterval(callState.timerInt);
  callState.timerInt = setInterval(() => {
    $('#call-timer').textContent = fmtDur((Date.now() - callState.startTime) / 1000);
  }, 1000);
}
function cleanupCall() {
  if (callState.stream) callState.stream.getTracks().forEach((t) => t.stop());
  if (callState.pc) { try { callState.pc.close(); } catch { /* ignore */ } }
  Object.assign(callState, {
    pc: null, stream: null, callId: null, kind: null, conversationId: null,
    pendingOffer: null, startTime: 0, isCaller: false,
  });
  hideCallUI();
}
// Kết thúc cuộc gọi (sendSignal: có báo cho phía bên kia không)
function endCall(sendSignal = true, missed = false) {
  const { callId, conversationId, kind, isCaller, startTime, logSent } = callState;
  if (sendSignal && callId && conversationId) {
    state.socket.emit('call:end', { conversationId, callId });
  }
  // Chỉ người gọi ghi log 1 lần (tránh trùng)
  if (isCaller && !logSent && conversationId && kind) {
    callState.logSent = true;
    const duration = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    sendMessage({
      content: JSON.stringify({ kind, duration, missed: missed || !startTime }),
      type: 'call',
    });
  }
  cleanupCall();
}

function makePeerConnection(callId, conversationId) {
  const pc = new RTCPeerConnection(RTC_CONF);
  pc.onicecandidate = (e) => {
    if (e.candidate) state.socket.emit('call:signal', {
      conversationId, callId, signal: { type: 'ice', candidate: e.candidate },
    });
  };
  pc.ontrack = (e) => {
    const rv = $('#call-remote-video');
    rv.srcObject = e.streams[0];
    rv.style.display = 'block';
    $('#call-center').style.display = 'none';
  };
  return pc;
}

async function startCall(kind) {
  if (!state.activeConvId) return toast('Hãy mở một cuộc trò chuyện trước.');
  if (callState.pc || callState.pendingOffer) return toast('Đang có cuộc gọi khác.');
  const conv = getActiveConv();
  if (conv?.type !== 'private') return toast('Hiện chỉ hỗ trợ gọi 1-1.');
  if (!navigator.mediaDevices?.getUserMedia) return toast('Thiết bị không hỗ trợ gọi điện.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
  } catch { return toast('Không truy cập được micro/camera. Hãy cấp quyền.'); }
  const callId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const conversationId = state.activeConvId;
  const pc = makePeerConnection(callId, conversationId);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    Object.assign(callState, {
      pc, stream, callId, kind, conversationId,
      peerName: conv.name, peerAvatar: conv.peer?.avatar_url || null,
      isCaller: true, logSent: false,
    });
    state.socket.emit('call:invite', { conversationId, callId, kind, offer }, (res) => {
      if (res?.error) { toast(res.error); endCall(false, true); }
    });
    showCallUI('outgoing');
    if (kind === 'video') {
      const lv = $('#call-local-video');
      lv.srcObject = stream;
      lv.classList.remove('hidden');
    }
  } catch { toast('Không khởi tạo được cuộc gọi.'); cleanupCall(); }
}

async function acceptCall() {
  const { pendingOffer, callId, kind, conversationId } = callState;
  if (!pendingOffer) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
  } catch { toast('Không truy cập được micro/camera.'); return; }
  const pc = makePeerConnection(callId, conversationId);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    Object.assign(callState, { pc, stream, pendingOffer: null });
    state.socket.emit('call:signal', { conversationId, callId, signal: { type: 'sdp', sdp: answer } });
    showCallUI('active');
    if (kind === 'video') {
      const lv = $('#call-local-video');
      lv.srcObject = stream;
      lv.classList.remove('hidden');
    }
    startCallTimer();
  } catch { toast('Không kết nối được cuộc gọi.'); cleanupCall(); }
}

// Nhạc chuông đơn giản
let ringTimer = null, ringCtx = null;
function playRingtone() {
  stopRingtone();
  try {
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!ringCtx) return;
      [[440, 0], [480, 450]].forEach(([freq, delay]) => {
        setTimeout(() => {
          if (!ringCtx) return;
          const o = ringCtx.createOscillator(), g = ringCtx.createGain();
          o.connect(g); g.connect(ringCtx.destination);
          o.frequency.value = freq; g.gain.value = 0.07;
          o.start(); o.stop(ringCtx.currentTime + 0.35);
        }, delay);
      });
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch { /* ignore */ }
}
function stopRingtone() {
  clearInterval(ringTimer); ringTimer = null;
  if (ringCtx) { ringCtx.close().catch(() => {}); ringCtx = null; }
}

$('#btn-voice-call').onclick = () => startCall('audio');
$('#btn-video-call').onclick = () => startCall('video');
$('#call-accept-btn').onclick = () => { stopRingtone(); acceptCall(); };
$('#call-reject-btn').onclick = () => {
  const { callId, conversationId } = callState;
  if (callId) state.socket.emit('call:reject', { conversationId, callId });
  cleanupCall();
};
$('#call-hangup-btn').onclick = () => {
  const { isCaller, startTime, callId, conversationId } = callState;
  if (isCaller && !startTime && callId) {
    state.socket.emit('call:cancel', { conversationId, callId });
    endCall(false, true); // người gọi hủy khi chưa kết nối → log "nhỡ"
  } else {
    endCall(true);
  }
};
$('#call-mic-btn').onclick = () => {
  callState.micOn = !callState.micOn;
  callState.stream?.getAudioTracks().forEach((t) => { t.enabled = callState.micOn; });
  $('#call-mic-btn').classList.toggle('off', !callState.micOn);
};
$('#call-cam-btn').onclick = () => {
  callState.camOn = !callState.camOn;
  callState.stream?.getVideoTracks().forEach((t) => { t.enabled = callState.camOn; });
  $('#call-cam-btn').classList.toggle('off', !callState.camOn);
};

/* ---------- Đổi avatar ---------- */
$('#me-avatar').onclick = () => $('#avatar-input').click();
$('#avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Avatar phải là file ảnh.');
  if (file.size > 10 * 1024 * 1024) return toast('Ảnh tối đa 10MB.');
  const fd = new FormData();
  fd.append('file', file);
  try {
    toast('Đang tải avatar lên...');
    const res = await fetch('/api/users/me/avatar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Đổi avatar thất bại');
    state.user.avatar_url = data.user.avatar_url;
    localStorage.setItem('chitchat_user', JSON.stringify(state.user));
    setAvatar($('#me-avatar'), state.user.name, false, state.user.avatar_url);
    toast('Đã đổi avatar! 🎉');
  } catch (err) { toast(err.message); }
});

/* ---------- Dark mode ---------- */
function setThemeMode(dark) {
  document.documentElement.classList.toggle('dark', dark);
  try { localStorage.setItem('chitchat_dark', dark ? '1' : '0'); } catch (e) {}
  const btn = $('#btn-theme');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
}
function initThemeMode() {
  let dark = false;
  try { dark = localStorage.getItem('chitchat_dark') === '1'; } catch (e) {}
  setThemeMode(dark);
  $('#btn-theme').onclick = () => {
    const nowDark = !document.documentElement.classList.contains('dark');
    setThemeMode(nowDark);
    toast(nowDark ? 'Đã bật chế độ tối 🌙' : 'Đã bật chế độ sáng ☀️');
  };
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
      ? (c.last_type === 'image' ? '📷 Đã gửi một ảnh'
        : c.last_type === 'audio' ? '🎤 Tin nhắn thoại'
        : c.last_type === 'call' ? '📞 Cuộc gọi'
        : c.last_content)
      : 'Bắt đầu cuộc trò chuyện';
    const prefix = c.last_sender_id === state.user.id ? 'Bạn: ' : '';
    const online = c.type === 'private' && peer?.online_status;
    return `<div class="conv-item ${c.id === state.activeConvId ? 'active' : ''}" data-id="${c.id}">
      ${avatarHTML(c.displayName, '', online, c.displayAvatar)}
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
        ${avatarHTML(u.name, 'avatar-sm', !!u.online_status, u.avatar_url)}
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
  applyTheme(id);
  state.socket?.emit('conv:join', { conversationId: id });
  updateTypingBar();
  renderConvList($('#search-input').value);
  const conv = getConv(id);
  if (!conv) return;
  applyWallpaper(conv);

  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');
  document.body.classList.add('chat-open');

  setAvatar($('#chat-avatar'), conv.displayName, conv.type === 'private' && conv.peer?.online_status, conv.displayAvatar);
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
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function bubbleHTML(msg) {
  if (msg.type === 'image') {
    return `<div class="bubble"><img class="msg-img" src="${esc(msg.content)}" alt="Ảnh" loading="lazy" onerror="this.closest('.bubble').classList.add('img-broken');this.remove()"><span class="img-broken-text">🖼️ Ảnh không còn tồn tại</span></div>`;
  }
  if (msg.type === 'audio') {
    return `<div class="bubble"><audio controls preload="metadata" src="${esc(msg.content)}"></audio></div>`;
  }
  if (msg.type === 'text' && msg.content === '👍') {
    return `<div class="bubble bubble-like">👍</div>`;
  }
  return `<div class="bubble">${esc(msg.content)}</div>`;
}

function callLogHTML(msg) {
  let info = {};
  try { info = JSON.parse(msg.content); } catch { /* ignore */ }
  const icon = info.kind === 'video' ? '🎥' : '📞';
  const label = info.missed ? 'Cuộc gọi nhỡ'
    : `Cuộc gọi ${info.kind === 'video' ? 'video' : 'thoại'}`;
  const dur = !info.missed && info.duration ? ` • ${fmtDur(info.duration)}` : '';
  return `<div class="call-log" data-id="${msg.id}">${icon} ${label}${dur}</div>`;
}

function ticksHTML(status) {
  if (status === 'seen') return `<div class="ticks seen" title="Đã xem">✓✓</div>`;
  if (status === 'delivered') return `<div class="ticks delivered" title="Đã nhận">✓✓</div>`;
  return `<div class="ticks sent" title="Đã gửi">✓</div>`;
}

function msgRowHTML(msg, prevMsg) {
  if (msg.type === 'call') return callLogHTML(msg);
  const mine = msg.sender_id === state.user.id;
  const grouped = prevMsg && prevMsg.sender_id === msg.sender_id &&
    (msg.created_at - prevMsg.created_at) < 120_000;
  const showAvatar = !mine && !grouped;
  const avatarPart = mine ? '' :
    (showAvatar
      ? avatarHTML(msg.sender_name || '?', 'avatar-xs', false, msg.sender_avatar)
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

function renderFullList(messages) {
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
}

// Nhảy tới một tin nhắn cụ thể (dùng cho tìm kiếm)
async function jumpToMessage(id) {
  if (!state.activeConvId) return;
  try {
    const { messages } = await api(
      `/api/conversations/${state.activeConvId}/messages?before=${id + 1}&limit=40`
    );
    state.hasMore = true;
    renderFullList(messages);
    $('#info-pane').classList.add('hidden');
    requestAnimationFrame(() => {
      const el = document.querySelector(`#messages [data-id="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1700);
      }
    });
  } catch (err) { toast(err.message); }
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
      renderFullList(messages);
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
  input.dispatchEvent(new Event('input'));
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
// Hiện nút gửi khi đang gõ, nút like khi ô trống (kiểu Messenger)
$('#msg-input').addEventListener('input', () => {
  const has = $('#msg-input').value.trim().length > 0;
  $('#btn-send').classList.toggle('hidden', !has);
  $('#btn-like').classList.toggle('hidden', has);
});
$('#btn-like').onclick = () => {
  const input = $('#msg-input');
  if (!input.value.trim() && state.activeConvId) {
    sendMessage({ content: '👍', type: 'text' });
  } else {
    input.value += '👍';
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
};

/* ---------- Tin nhắn thoại ---------- */
let mediaRecorder = null, audioChunks = [], recTimer = null, recStart = 0;
$('#btn-mic').onclick = async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // onstop sẽ upload + gửi
    return;
  }
  if (!state.activeConvId) return toast('Hãy mở một cuộc trò chuyện trước.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      $('#rec-indicator').classList.add('hidden');
      $('#btn-mic').classList.remove('recording');
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) return toast('Ghi âm quá ngắn.');
      const fd = new FormData();
      fd.append('file', blob, 'voice.webm');
      try {
        toast('Đang gửi tin nhắn thoại...');
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.token}` },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload thất bại');
        sendMessage({ content: data.url, type: 'audio' });
      } catch (err) { toast(err.message); }
      mediaRecorder = null;
    };
    mediaRecorder.start();
    recStart = Date.now();
    $('#rec-indicator').classList.remove('hidden');
    const tick = () => { $('#rec-time').textContent = fmtDur((Date.now() - recStart) / 1000); };
    tick();
    recTimer = setInterval(tick, 500);
  } catch {
    toast('Không truy cập được micro. Hãy cho phép quyền micro.');
  }
};

/* ---------- Upload ảnh ---------- */
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.activeConvId) return;
  if (file.size > 10 * 1024 * 1024) return toast('File tối đa 10MB.');
  const fd = new FormData();
  fd.append('file', file);
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
    if (conv && conv.archived && msg.sender_id !== state.user.id) conv.archived = 0; // tự bỏ lưu trữ khi có tin mới
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
    updateContactStatus(userId, true);
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
    updateContactStatus(userId, false, lastSeen);
  });

  // Ai đó đổi avatar → cập nhật khắp nơi, real-time
  socket.on('user:avatar', ({ userId, avatarUrl }) => {
    let changed = false;
    for (const c of state.conversations) {
      if (c.type === 'private' && c.peer?.id === userId) {
        c.peer.avatar_url = avatarUrl;
        c.displayAvatar = avatarUrl;
        changed = true;
      }
    }
    for (const ct of state.contacts) {
      if (ct.id === userId) { ct.avatar_url = avatarUrl; changed = true; }
    }
    if (changed) {
      renderConvList($('#search-input').value);
      renderContacts();
    }
    const conv = getActiveConv();
    if (conv?.type === 'private' && conv.peer?.id === userId) {
      setAvatar($('#chat-avatar'), conv.displayName, !!conv.peer.online_status, avatarUrl);
    }
  });

  // --- Cuộc gọi đến / tín hiệu WebRTC ---
  socket.on('call:incoming', ({ callId, conversationId, kind, offer, fromUserId, fromName, fromAvatar }) => {
    if (callState.pc || callState.pendingOffer) {
      socket.emit('call:reject', { conversationId, callId, busy: true });
      return;
    }
    Object.assign(callState, {
      callId, kind, conversationId, pendingOffer: offer,
      peerName: fromName, peerAvatar: fromAvatar || null, isCaller: false, logSent: false,
    });
    showCallUI('incoming');
    playRingtone();
  });
  socket.on('call:signal', async ({ callId, fromUserId, signal }) => {
    if (!callState.pc || callState.callId !== callId || fromUserId === state.user.id) return;
    try {
      if (signal.type === 'sdp') {
        await callState.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (!callState.startTime) {
          showCallUI('active');
          if (callState.kind === 'video' && callState.stream) {
            const lv = $('#call-local-video');
            lv.srcObject = callState.stream;
            lv.classList.remove('hidden');
          }
          startCallTimer();
        }
      } else if (signal.type === 'ice' && signal.candidate) {
        await callState.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch { /* bỏ qua signal lỗi */ }
  });
  socket.on('call:rejected', ({ callId, busy }) => {
    if (callState.callId !== callId) return;
    stopRingtone();
    toast(busy ? 'Người kia đang bận.' : 'Cuộc gọi bị từ chối.');
    endCall(false, true);
  });
  socket.on('call:cancelled', ({ callId }) => {
    if (callState.callId !== callId) return;
    toast('Cuộc gọi đã bị hủy.');
    cleanupCall();
  });
  socket.on('call:ended', ({ callId }) => {
    if (callState.callId !== callId) return;
    toast('Cuộc gọi đã kết thúc.');
    endCall(false);
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
  initThemeMode();
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
