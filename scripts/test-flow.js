// Test end-to-end: đăng ký → đăng nhập → chat 2 người → real-time
// Chạy khi server đang mở: node scripts/test-flow.js
const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const ok = (name, cond, extra = '') =>
  results.push(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

async function api(path, token, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

const waitFor = (socket, ev, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout chờ event "${ev}"`)), timeout);
    socket.once(ev, (data) => { clearTimeout(t); resolve(data); });
  });

// Gửi tin nhắn qua socket và chờ ack trả về message
const sendAndWait = (socket, payload) =>
  new Promise((resolve, reject) => {
    socket.emit('message:send', payload, (res) => {
      if (res?.ok) resolve(res.message);
      else reject(new Error(res?.error || 'gửi tin nhắn thất bại'));
    });
  });

(async () => {
  const suffix = Date.now().toString(36);
  try {
    // 1. Đăng ký 2 user
    const a = await api('/api/auth/register', null, {
      method: 'POST',
      body: JSON.stringify({ name: 'Test A', email: `a${suffix}@test.com`, password: 'test1234' }),
    });
    const b = await api('/api/auth/register', null, {
      method: 'POST',
      body: JSON.stringify({ name: 'Test B', email: `b${suffix}@test.com`, password: 'test1234' }),
    });
    ok('Đăng ký 2 tài khoản', !!(a.token && b.token));

    // 2. Đăng nhập lại (kiểm tra login)
    const loginA = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email: `a${suffix}@test.com`, password: 'test1234' }),
    });
    ok('Đăng nhập', !!loginA.token);

    // 2b. Sai mật khẩu phải bị từ chối
    let rejected = false;
    try {
      await api('/api/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({ email: `a${suffix}@test.com`, password: 'sai' }),
      });
    } catch { rejected = true; }
    ok('Từ chối mật khẩu sai', rejected);

    // 3. Tạo conversation 1-1
    const { conversationId } = await api('/api/conversations/private', a.token, {
      method: 'POST', body: JSON.stringify({ userId: b.user.id }),
    });
    ok('Tạo cuộc trò chuyện 1-1', !!conversationId);

    // 4. Kết nối socket 2 user
    const sockA = io(BASE, { auth: { token: a.token } });
    const sockB = io(BASE, { auth: { token: b.token } });
    await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
    ok('Kết nối Socket.io 2 user', sockA.connected && sockB.connected);

    // 4b. A thấy B online
    const onlineEvt = await waitFor(sockA, 'user:online').catch(() => null);
    // (B đã online trước khi A connect nên có thể không có event — kiểm tra qua REST)
    const convsA = await api('/api/conversations', a.token);
    const convAB = convsA.conversations.find((c) => c.id === conversationId);
    ok('Trạng thái online của B', convAB?.peerOnline === true, `peerOnline=${convAB?.peerOnline}`);

    // 4c. Danh bạ: có B, online xếp trước
    const { contacts } = await api('/api/contacts', a.token);
    const contactB = contacts.find((c) => c.id === b.user.id);
    ok('Danh sách liên hệ (thấy B đang online)', !!contactB && contactB.online_status === 1);

    // 5. A gửi tin nhắn → B nhận real-time
    const text = `Xin chào B! ${suffix}`;
    const recvB = waitFor(sockB, 'message:new');
    const ack = await new Promise((res) => sockA.emit(
      'message:send',
      { conversationId, content: text, type: 'text', clientId: 't1' },
      res
    ));
    ok('A gửi tin nhắn (ack)', ack?.ok === true);
    const msgB = await recvB;
    ok('B nhận tin nhắn real-time', msgB.content === text && msgB.sender_id === a.user.id);
    ok('Trạng thái delivered khi người nhận online', msgB.status === 'delivered', `status=${msgB.status}`);

    // 6. Typing indicator
    const typingP = waitFor(sockB, 'typing:update');
    sockA.emit('typing:start', { conversationId });
    const typingEvt = await typingP;
    ok('Typing indicator', typingEvt.typing === true && typingEvt.userId === a.user.id);
    sockA.emit('typing:stop', { conversationId });

    // 7. B đã xem → A nhận event seen
    const seenP = waitFor(sockA, 'messages:seen');
    sockB.emit('messages:seen', { conversationId });
    const seenEvt = await seenP;
    ok('Read receipt (B đã xem → A nhận)', seenEvt.seenBy === b.user.id);

    // 8. Lịch sử chat lưu DB, status = seen
    const { messages } = await api(`/api/conversations/${conversationId}/messages`, a.token);
    const last = messages[messages.length - 1];
    ok('Lịch sử chat lưu trong DB', messages.length >= 1 && last.content === text);
    ok('Status tin nhắn = seen sau khi B xem', last.status === 'seen', `status=${last.status}`);

    // 9. Unread badge của B về 0 sau khi xem
    const convsB = await api('/api/conversations', b.token);
    const convBA = convsB.conversations.find((c) => c.id === conversationId);
    ok('Unread badge reset sau khi xem', convBA.unread_count === 0, `unread=${convBA.unread_count}`);

    // 10. B gửi lại → A nhận
    const recvA = waitFor(sockA, 'message:new');
    sockB.emit('message:send', { conversationId, content: 'Chào A!', type: 'text', clientId: 't2' }, () => {});
    const msgA = await recvA;
    ok('Chat 2 chiều real-time', msgA.content === 'Chào A!');

    // 11. Conv mới tạo khi cả 2 đang online → vẫn nhận real-time (không cần reload)
    const c = await api('/api/auth/register', null, {
      method: 'POST',
      body: JSON.stringify({ name: 'Test C', email: `c${suffix}@test.com`, password: 'test1234' }),
    });
    const sockC = io(BASE, { auth: { token: c.token } });
    await waitFor(sockC, 'connect');
    const { conversationId: convAC } = await api('/api/conversations/private', a.token, {
      method: 'POST', body: JSON.stringify({ userId: c.user.id }),
    });
    const recvC = waitFor(sockC, 'message:new');
    const ackC = await new Promise((res) => sockA.emit(
      'message:send',
      { conversationId: convAC, content: 'Chào C!', type: 'text', clientId: 't3' },
      res
    ));
    const msgC = await recvC;
    ok('Nhận real-time ở conv mới tạo khi đang online', ackC?.ok === true && msgC.content === 'Chào C!');
    sockC.disconnect();

    // 11b. Tắt / bật thông báo
    {
      const r1 = await api(`/api/conversations/${conversationId}/mute`, a.token, {
        method: 'POST', body: JSON.stringify({ muted: true }),
      });
      const r2 = await api(`/api/conversations/${conversationId}/mute`, a.token, {
        method: 'POST', body: JSON.stringify({ muted: false }),
      });
      ok('Tắt / bật thông báo', r1.muted === true && r2.muted === false);
    }

    // 11c. Tìm kiếm tin nhắn trong đoạn chat
    {
      const { results } = await api(
        `/api/conversations/${conversationId}/search?q=${encodeURIComponent('Xin chào B')}`, a.token);
      ok('Tìm kiếm tin nhắn', results.length > 0 && results.some((r) => r.content.includes('Xin chào B')));
    }

    // 11d. File phương tiện đã chia sẻ
    {
      const imgMsg = await sendAndWait(sockA, {
        conversationId, content: '/uploads/test.png', type: 'image', clientId: 't-img',
      });
      const { media } = await api(`/api/conversations/${conversationId}/media`, a.token);
      ok('File phương tiện đã chia sẻ', media.some((m) => m.id === imgMsg.id && m.type === 'image'));
    }

    // 11e. Lưu trữ / bỏ lưu trữ
    {
      await api(`/api/conversations/${conversationId}/archive`, a.token, {
        method: 'POST', body: JSON.stringify({ archived: true }),
      });
      const { conversations: arch } = await api('/api/conversations?filter=archived', a.token);
      const { conversations: main } = await api('/api/conversations', a.token);
      const archivedOk = arch.some((c) => c.id === conversationId) && !main.some((c) => c.id === conversationId);
      await api(`/api/conversations/${conversationId}/archive`, a.token, {
        method: 'POST', body: JSON.stringify({ archived: false }),
      });
      ok('Lưu trữ / bỏ lưu trữ', archivedOk);
    }

    // 11f. Gọi điện: signaling qua socket
    {
      const incomingP = waitFor(sockB, 'call:incoming');
      sockA.emit('call:invite', {
        conversationId, callId: 'test-call-1', kind: 'audio', offer: { type: 'offer', sdp: 'fake' },
      }, () => {});
      const inc = await incomingP;
      ok('Tín hiệu gọi đến (call:incoming)',
        inc.callId === 'test-call-1' && inc.kind === 'audio' && inc.fromUserId === a.user.id);

      const sigP = waitFor(sockA, 'call:signal');
      sockB.emit('call:signal', {
        conversationId, callId: 'test-call-1', signal: { type: 'ice', candidate: { candidate: 'fake' } },
      });
      const sig = await sigP;
      ok('Chuyển tiếp signal WebRTC', sig.signal.type === 'ice' && sig.fromUserId === b.user.id);

      const rejP = waitFor(sockA, 'call:rejected');
      sockB.emit('call:reject', { conversationId, callId: 'test-call-1' });
      await rejP;
      ok('Từ chối cuộc gọi (call:rejected)', true);

      const callMsg = await sendAndWait(sockA, {
        conversationId,
        content: JSON.stringify({ kind: 'audio', duration: 65, missed: false }),
        type: 'call', clientId: 't-call',
      });
      ok('Ghi log cuộc gọi', callMsg.type === 'call');
    }

    // 11g. Đổi avatar (+ real-time cho người khác)
    {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      const avP = waitFor(sockB, 'user:avatar');
      const fd = new FormData();
      fd.append('file', new Blob([png], { type: 'image/png' }), 'avatar.png');
      const res = await fetch(BASE + '/api/users/me/avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${a.token}` },
        body: fd,
      });
      const data = await res.json();
      const av = await avP;
      ok('Đổi avatar', res.ok && data.user.avatar_url?.startsWith('/uploads/'));
      ok('Real-time cập nhật avatar',
        av.userId === a.user.id && av.avatarUrl === data.user.avatar_url);
    }

    // 11h. Hình nền đoạn chat
    {
      const r = await api(`/api/conversations/${conversationId}/wallpaper`, a.token, {
        method: 'POST', body: JSON.stringify({ wallpaper: '/uploads/bg.png' }),
      });
      const { conversations } = await api('/api/conversations', a.token);
      const c = conversations.find((x) => x.id === conversationId);
      ok('Đổi / xóa hình nền đoạn chat',
        r.wallpaper === '/uploads/bg.png' && c.wallpaper === '/uploads/bg.png');
      await api(`/api/conversations/${conversationId}/wallpaper`, a.token, {
        method: 'POST', body: JSON.stringify({ wallpaper: null }),
      });
    }

    // 11i. Biểu tượng cảm xúc nhanh
    {
      const r = await api(`/api/conversations/${conversationId}/quick-emoji`, a.token, {
        method: 'POST', body: JSON.stringify({ emoji: '❤️' }),
      });
      const { conversations } = await api('/api/conversations', a.token);
      const c = conversations.find((x) => x.id === conversationId);
      ok('Đổi biểu tượng cảm xúc nhanh',
        r.emoji === '❤️' && c.quick_emoji === '❤️');
      const bad = await fetch(`${BASE}/api/conversations/${conversationId}/quick-emoji`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
        body: JSON.stringify({ emoji: 'hello' }),
      });
      ok('Chặn emoji nhanh không hợp lệ', bad.status === 400);
      await api(`/api/conversations/${conversationId}/quick-emoji`, a.token, {
        method: 'POST', body: JSON.stringify({ emoji: '👍' }),
      });
    }

    // 11j. Màu theme đoạn chat (lưu server)
    {
      const r = await api(`/api/conversations/${conversationId}/theme`, a.token, {
        method: 'POST', body: JSON.stringify({ color: '#E91E63' }),
      });
      const { conversations } = await api('/api/conversations', a.token);
      const c = conversations.find((x) => x.id === conversationId);
      ok('Đổi màu theme đoạn chat',
        r.color === '#E91E63' && c.theme_color === '#E91E63');
      const bad = await fetch(`${BASE}/api/conversations/${conversationId}/theme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
        body: JSON.stringify({ color: 'red' }),
      });
      ok('Chặn màu theme không hợp lệ', bad.status === 400);
    }

    // 12. Offline: B disconnect → A nhận user:offline (lọc đúng userId, bỏ qua event của C)
    const offP = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout chờ user:offline')), 8000);
      const handler = (data) => {
        if (data.userId === b.user.id) {
          clearTimeout(t);
          sockA.off('user:offline', handler);
          resolve(data);
        }
      };
      sockA.on('user:offline', handler);
    });
    sockB.disconnect();
    await offP;
    ok('Trạng thái offline khi disconnect', true);

    sockA.disconnect();
  } catch (e) {
    results.push(`❌ FAIL  Exception: ${e.message}`);
  }
  console.log('\n===== KẾT QUẢ TEST =====');
  results.forEach((r) => console.log(r));
  const failed = results.filter((r) => r.startsWith('❌')).length;
  console.log(`\n${failed === 0 ? '🎉 Tất cả test đều PASS' : `⚠️ ${failed} test FAIL`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
