const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  searchUsers, getContacts, getUserById, updateAvatar, getConversationsForUser, getOrCreatePrivateConversation,
  createConversation, getMessages, isMember,
  markConversationSeen, setMuted, setArchived, getMedia, searchMessages, setWallpaper,
} = require('../db');
const { authMiddleware, rateLimit } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

// Danh bạ người liên hệ (online trước)
router.get('/contacts', async (req, res) => {
  res.json({ contacts: await getContacts(req.user.id) });
});

// Tìm người dùng để bắt đầu chat mới
router.get('/users', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  res.json({ users: await searchUsers(req.user.id, q) });
});

// Danh sách cuộc trò chuyện (?filter=archived để xem đã lưu trữ)
router.get('/conversations', async (req, res) => {
  const onlyArchived = req.query.filter === 'archived';
  const convs = (await getConversationsForUser(req.user.id, onlyArchived)).map((c) => ({
    ...c,
    displayName:
      c.type === 'private'
        ? c.peer?.name || 'Người dùng'
        : c.name || c.members.map((m) => m.name).join(', '),
    displayAvatar:
      c.type === 'private' ? c.peer?.avatar_url || null : null,
    peerOnline: c.type === 'private' ? !!c.peer?.online_status : false,
    peerId: c.type === 'private' ? c.peer?.id || null : null,
  }));
  res.json({ conversations: convs });
});

// Tạo / lấy cuộc trò chuyện 1-1
router.post('/conversations/private', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId || userId === req.user.id)
    return res.status(400).json({ error: 'userId không hợp lệ.' });
  const id = await getOrCreatePrivateConversation(req.user.id, Number(userId));
  res.status(201).json({ conversationId: id });
});

// Tạo nhóm chat
router.post('/conversations/group', async (req, res) => {
  const { name, memberIds } = req.body || {};
  const members = [...new Set([req.user.id, ...((memberIds || []).map(Number))])];
  if (members.length < 2)
    return res.status(400).json({ error: 'Nhóm cần ít nhất 2 thành viên.' });
  const id = await createConversation('group', (name || '').trim() || 'Nhóm chat', members);
  res.status(201).json({ conversationId: id });
});

// Lịch sử tin nhắn (phân trang ngược: before = message id)
router.get('/conversations/:id/messages', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  res.json({ messages: await getMessages(convId, before, limit) });
});

// Đánh dấu đã xem (dự phòng REST, socket cũng làm việc này)
router.post('/conversations/:id/seen', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  await markConversationSeen(convId, req.user.id);
  res.json({ ok: true });
});

// Tắt / bật thông báo của đoạn chat
router.post('/conversations/:id/mute', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  await setMuted(convId, req.user.id, !!req.body?.muted);
  res.json({ ok: true, muted: !!req.body?.muted });
});

// Lưu trữ / bỏ lưu trữ đoạn chat
router.post('/conversations/:id/archive', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  await setArchived(convId, req.user.id, !!req.body?.archived);
  res.json({ ok: true, archived: !!req.body?.archived });
});

// Đổi / xóa hình nền đoạn chat (riêng cho mình)
router.post('/conversations/:id/wallpaper', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  const wallpaper = (req.body?.wallpaper || '').trim() || null;
  if (wallpaper && !wallpaper.startsWith('/uploads/'))
    return res.status(400).json({ error: 'Hình nền không hợp lệ.' });
  await setWallpaper(convId, req.user.id, wallpaper);
  res.json({ ok: true, wallpaper });
});

// File phương tiện đã chia sẻ
router.get('/conversations/:id/media', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  res.json({ media: await getMedia(convId) });
});

// Tìm kiếm tin nhắn trong đoạn chat
router.get('/conversations/:id/search', async (req, res) => {
  const convId = Number(req.params.id);
  const q = (req.query.q || '').trim();
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  if (q.length < 2) return res.json({ results: [] });
  res.json({ results: await searchMessages(convId, q) });
});

// ---- Upload ảnh ----
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else if (/^audio\/(webm|mp4|mpeg|ogg|x-m4a)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ cho phép file ảnh hoặc âm thanh.'));
  },
}).single('file');

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// Đổi avatar của chính mình (multipart field "file")
router.post('/users/me/avatar', (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file ảnh.' });
    if (!req.file.mimetype.startsWith('image/'))
      return res.status(400).json({ error: 'Avatar phải là file ảnh.' });
    try {
      const url = `/uploads/${req.file.filename}`;
      // Xoá avatar cũ nếu là file upload local
      const me = await getUserById(req.user.id);
      if (me?.avatar_url?.startsWith('/uploads/')) {
        fs.unlink(path.join(UPLOAD_DIR, path.basename(me.avatar_url)), () => {});
      }
      const user = await updateAvatar(req.user.id, url);
      // Báo real-time cho mọi client đang online
      req.app.get('io')?.emit('user:avatar', { userId: user.id, avatarUrl: url });
      res.json({ user });
    } catch (e) {
      res.status(500).json({ error: 'Đổi avatar thất bại.' });
    }
  });
});

router.post('/upload', uploadLimiter, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file.' });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

module.exports = router;
