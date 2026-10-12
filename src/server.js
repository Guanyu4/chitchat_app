const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { initSocket } = require('./socket');
const { rateLimit } = require('./middleware');

const app = express();
const server = http.createServer(app);
// Same-origin nên không cần CORS mở — bỏ origin:true để site lạ không connect được
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
});

// CSP: chỉ cho phép đúng các inline <script> đang có trong index.html
// (tính hash tự động nên sửa file HTML cũng không vỡ)
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const inlineScriptHashes = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...inlineScriptHashes],
      // style inline (style="...") vẫn cho phép — ít nguy hiểm, app dùng nhiều
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'https:', 'data:'],
      mediaSrc: ["'self'", 'https:'],
      connectSrc: ["'self'", 'wss:', 'https:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"], // chống clickjacking
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// Giới hạn chung: 600 request/phút/IP cho mọi API
app.use('/api/', rateLimit({ windowMs: 60_000, max: 600, message: 'Quá nhiều yêu cầu, thử lại sau.' }));

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
// Static: index.html + sw.js không cache (luôn lấy bản mới),
// file còn lại revalidate mỗi lần mở (304 nếu không đổi → nhanh mà không dính bản cũ)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use('/api/auth', require('./routes/auth'));
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));
app.use('/api', require('./routes/api'));

// SPA fallback
app.use((req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

initSocket(io);
app.set('io', io); // để các route có thể emit event real-time

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`💬 Messenger clone đang chạy tại http://localhost:${PORT}`);
});
