const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  searchUsers, getConversationsForUser, getOrCreatePrivateConversation,
  createConversation, getMessages, isMember, memberIdsOf,
  markConversationSeen,
} = require('../db');
const { authMiddleware, sanitizeUser, rateLimit } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

// Tìm người dùng để bắt đầu chat mới
router.get('/users', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  res.json({ users: searchUsers(req.user.id, q) });
});

// Danh sách cuộc trò chuyện
router.get('/conversations', (req, res) => {
  const convs = getConversationsForUser(req.user.id).map((c) => ({
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
router.post('/conversations/private', (req, res) => {
  const { userId } = req.body || {};
  if (!userId || userId === req.user.id)
    return res.status(400).json({ error: 'userId không hợp lệ.' });
  const id = getOrCreatePrivateConversation(req.user.id, Number(userId));
  res.status(201).json({ conversationId: id });
});

// Tạo nhóm chat
router.post('/conversations/group', (req, res) => {
  const { name, memberIds } = req.body || {};
  const members = [...new Set([req.user.id, ...((memberIds || []).map(Number))])];
  if (members.length < 2)
    return res.status(400).json({ error: 'Nhóm cần ít nhất 2 thành viên.' });
  const id = createConversation('group', (name || '').trim() || 'Nhóm chat', members);
  res.status(201).json({ conversationId: id });
});

// Lịch sử tin nhắn (phân trang ngược: before = message id)
router.get('/conversations/:id/messages', (req, res) => {
  const convId = Number(req.params.id);
  if (!isMember(convId, req.user.id))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  res.json({ messages: getMessages(convId, before, limit) });
});

// Đánh dấu đã xem (dự phòng REST, socket cũng làm việc này)
router.post('/conversations/:id/seen', (req, res) => {
  const convId = Number(req.params.id);
  if (!isMember(convId, req.user.id))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  markConversationSeen(convId, req.user.id);
  res.json({ ok: true });
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ cho phép upload file ảnh (png, jpg, gif, webp).'));
  },
}).single('image');

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30 });

router.post('/upload', uploadLimiter, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file ảnh.' });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

module.exports = router;
