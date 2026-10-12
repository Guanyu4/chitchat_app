const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  maxHttpBufferSize: 1e6,
});

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
