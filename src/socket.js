const {
  getConversationsForUser, createMessage, isMember, memberIdsOf,
  markConversationSeen, markDelivered, setOnline, setOffline, getUserById,
} = require('./db');
const { verifySocketToken } = require('./middleware');

// userId -> Set<socketId>
const onlineSockets = new Map();
const isOnline = (uid) => onlineSockets.has(uid);

// Rate limit gửi tin nhắn: userId -> timestamps
const msgBuckets = new Map();
function msgRateOk(userId) {
  const now = Date.now();
  const arr = (msgBuckets.get(userId) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 60) return false;
  arr.push(now);
  msgBuckets.set(userId, arr);
  return true;
}

function initSocket(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('missing token'));
    try {
      socket.user = verifySocketToken(token);
      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    const uid = user.id;

    // --- online tracking ---
    if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
    const wasOffline = onlineSockets.get(uid).size === 0;
    onlineSockets.get(uid).add(socket.id);
    if (wasOffline) {
      setOnline(uid);
      socket.broadcast.emit('user:online', { userId: uid });
    }

    // --- join rooms ---
    socket.join(`user:${uid}`);
    const convs = getConversationsForUser(uid);
    for (const c of convs) socket.join(`conv:${c.id}`);

    // --- gửi tin nhắn ---
    socket.on('message:send', (payload, ack) => {
      try {
        const { conversationId, content, type = 'text', clientId } = payload || {};
        const convId = Number(conversationId);
        if (!convId || !isMember(convId, uid))
          return ack?.({ error: 'Cuộc trò chuyện không hợp lệ.' });
        if (!msgRateOk(uid))
          return ack?.({ error: 'Bạn gửi tin nhắn quá nhanh, chậm lại chút nhé.' });
        if (type === 'text') {
          if (!content || !content.trim())
            return ack?.({ error: 'Tin nhắn trống.' });
          if (content.length > 2000)
            return ack?.({ error: 'Tin nhắn tối đa 2000 ký tự.' });
        }
        if (type === 'image' && !content)
          return ack?.({ error: 'Thiếu URL ảnh.' });

        const msg = createMessage(convId, uid, content.trim?.() ?? content, type);

        // Đảm bảo mọi member đang online đều đã join room (kể cả conv mới tạo sau khi connect)
        for (const memberId of memberIdsOf(convId)) {
          const sids = onlineSockets.get(memberId);
          if (sids) for (const sid of sids) io.sockets.sockets.get(sid)?.join(`conv:${convId}`);
        }

        // delivered nếu người nhận đang online
        const others = memberIdsOf(convId).filter((id) => id !== uid);
        const anyOnline = others.some(isOnline);
        let finalStatus = 'sent';
        if (anyOnline) {
          markDelivered(msg.id);
          finalStatus = 'delivered';
        }
        const out = { ...msg, status: finalStatus, clientId };

        io.to(`conv:${convId}`).emit('message:new', out);
        ack?.({ ok: true, message: out });
      } catch (e) {
        ack?.({ error: 'Gửi tin nhắn thất bại.' });
      }
    });

    // --- typing indicator ---
    const typingTimers = new Map();
    socket.on('typing:start', ({ conversationId }) => {
      const convId = Number(conversationId);
      if (!convId || !isMember(convId, uid)) return;
      socket.to(`conv:${convId}`).emit('typing:update', {
        conversationId: convId, userId: uid, name: user.name, typing: true,
      });
      clearTimeout(typingTimers.get(convId));
      typingTimers.set(
        convId,
        setTimeout(() => {
          socket.to(`conv:${convId}`).emit('typing:update', {
            conversationId: convId, userId: uid, name: user.name, typing: false,
          });
        }, 4000)
      );
    });
    socket.on('typing:stop', ({ conversationId }) => {
      const convId = Number(conversationId);
      if (!convId || !isMember(convId, uid)) return;
      clearTimeout(typingTimers.get(convId));
      socket.to(`conv:${convId}`).emit('typing:update', {
        conversationId: convId, userId: uid, name: user.name, typing: false,
      });
    });

    // --- đã xem ---
    socket.on('messages:seen', ({ conversationId }) => {
      const convId = Number(conversationId);
      if (!convId || !isMember(convId, uid)) return;
      markConversationSeen(convId, uid);
      socket.to(`conv:${convId}`).emit('messages:seen', {
        conversationId: convId, seenBy: uid,
      });
    });

    // --- join room khi có conversation mới (tạo sau khi đã connect) ---
    socket.on('conv:join', ({ conversationId }) => {
      const convId = Number(conversationId);
      if (convId && isMember(convId, uid)) socket.join(`conv:${convId}`);
    });

    // --- disconnect ---
    socket.on('disconnect', () => {
      const set = onlineSockets.get(uid);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          onlineSockets.delete(uid);
          setOffline(uid);
          const u = getUserById(uid);
          io.emit('user:offline', { userId: uid, lastSeen: u?.last_seen || Date.now() });
        }
      }
      for (const t of typingTimers.values()) clearTimeout(t);
    });
  });
}

module.exports = { initSocket, isOnline };
