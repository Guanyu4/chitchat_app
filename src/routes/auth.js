const express = require('express');
const bcrypt = require('bcryptjs');
const {
  createUser, getUserByEmail,
} = require('../db');
const { signToken, sanitizeUser, rateLimit, authMiddleware } = require('../middleware');

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 60_000, max: 20, message: 'Đăng nhập/đăng ký quá nhanh, thử lại sau 1 phút.' });

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

router.post('/register', authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ họ tên, email và mật khẩu.' });
  if (!validEmail(email))
    return res.status(400).json({ error: 'Email không hợp lệ.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
  if (name.trim().length < 2)
    return res.status(400).json({ error: 'Họ tên quá ngắn.' });
  if (await getUserByEmail(email))
    return res.status(409).json({ error: 'Email này đã được đăng ký.' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const user = await createUser(name.trim(), email.toLowerCase().trim(), passwordHash);
  const token = signToken(user);
  res.status(201).json({ token, user: sanitizeUser(user) });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu.' });
  const user = await getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
  const token = signToken(user);
  res.json({ token, user: sanitizeUser(user) });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

module.exports = router;
