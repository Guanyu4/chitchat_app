const jwt = require('jsonwebtoken');
const { getUserById, getJwtSecret } = require('./db');

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    getJwtSecret(),
    { expiresIn: '30d' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Thiếu token xác thực' });
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const user = getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Tài khoản không tồn tại' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
  }
}

function verifySocketToken(token) {
  const payload = jwt.verify(token, getJwtSecret());
  const user = getUserById(payload.id);
  if (!user) throw new Error('no user');
  return user;
}

// Rate limiter đơn giản trong bộ nhớ: key -> timestamps
const buckets = new Map();
function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: message || 'Quá nhiều yêu cầu, thử lại sau.' });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}

function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

module.exports = { signToken, authMiddleware, verifySocketToken, rateLimit, sanitizeUser };
