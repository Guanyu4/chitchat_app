const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  searchUsers, getContacts, getUserById, updateAvatar, getConversationsForUser, getOrCreatePrivateConversation,
  createConversation, getMessages, isMember,
  markConversationSeen, setMuted, setArchived, getMedia, searchMessages, setWallpaper,
  setQuickEmoji, setThemeColor,
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
  const groupName = (name || '').trim().slice(0, 50) || 'Nhóm chat';
  const id = await createConversation('group', groupName, members);
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
  if (wallpaper && !wallpaper.startsWith('/uploads/') && !/^https?:\/\//.test(wallpaper))
    return res.status(400).json({ error: 'Hình nền không hợp lệ.' });
  await setWallpaper(convId, req.user.id, wallpaper);
  res.json({ ok: true, wallpaper });
});

// Đổi biểu tượng cảm xúc nhanh của đoạn chat (riêng cho mình)
router.post('/conversations/:id/quick-emoji', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  const emoji = (req.body?.emoji || '').trim();
  // 1 emoji (1-10 ký tự, không khoảng trắng, phải chứa ký tự emoji)
  if (!/^\S{1,10}$/u.test(emoji) || !/\p{Extended_Pictographic}/u.test(emoji))
    return res.status(400).json({ error: 'Biểu tượng không hợp lệ.' });
  await setQuickEmoji(convId, req.user.id, emoji);
  res.json({ ok: true, emoji });
});

// Đổi màu bong bóng chat (riêng cho mình, lưu server để đăng nhập lại vẫn giữ)
router.post('/conversations/:id/theme', async (req, res) => {
  const convId = Number(req.params.id);
  if (!(await isMember(convId, req.user.id)))
    return res.status(403).json({ error: 'Bạn không thuộc cuộc trò chuyện này.' });
  const color = (req.body?.color || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color))
    return res.status(400).json({ error: 'Màu không hợp lệ.' });
  await setThemeColor(convId, req.user.id, color);
  res.json({ ok: true, color });
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

// ---- Upload file ----
// Nếu có CLOUDINARY_URL hợp lệ → lưu lên Cloudinary (không mất khi server restart).
// Không có hoặc sai → fallback lưu local, server vẫn chạy bình thường.
let cloudinary = null;
let USE_CLOUDINARY = false;
try {
  const c = require('cloudinary').v2;
  const url = (process.env.CLOUDINARY_URL || '').trim();
  if (url.startsWith('cloudinary://')) {
    c.config({ secure: true }); // tự đọc CLOUDINARY_URL
    cloudinary = c;
    USE_CLOUDINARY = true;
    console.log('☁️  Cloudinary: bật lưu trữ đám mây');
  } else if (url) {
    console.warn('⚠️  CLOUDINARY_URL không hợp lệ (phải bắt đầu bằng "cloudinary://") — dùng lưu trữ local.');
  }
} catch (e) {
  console.warn('⚠️  Không khởi tạo được Cloudinary — dùng lưu trữ local:', e.message);
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = USE_CLOUDINARY
  ? multer.memoryStorage()
  : multer.diskStorage({
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

// Upload buffer lên Cloudinary, trả về secure_url
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'chitchat', resource_type: 'auto' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// Trả về URL cuối cùng của file vừa upload (cloud hoặc local)
async function fileUrl(file) {
  if (USE_CLOUDINARY) {
    const result = await uploadToCloudinary(file.buffer);
    return result.secure_url;
  }
  return `/uploads/${file.filename}`;
}

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// Đổi avatar của chính mình (multipart field "file")
router.post('/users/me/avatar', (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file ảnh.' });
    if (!req.file.mimetype.startsWith('image/'))
      return res.status(400).json({ error: 'Avatar phải là file ảnh.' });
    try {
      const url = await fileUrl(req.file);
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
      console.error('❌ Đổi avatar thất bại:', e.message || e);
      res.status(500).json({ error: 'Đổi avatar thất bại.' });
    }
  });
});

router.post('/upload', uploadLimiter, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file.' });
    try {
      const url = await fileUrl(req.file);
      res.status(201).json({ url });
    } catch (e) {
      console.error('❌ Upload file thất bại:', e.message || e);
      res.status(500).json({ error: 'Upload thất bại, thử lại sau.' });
    }
  });
});

module.exports = router;
