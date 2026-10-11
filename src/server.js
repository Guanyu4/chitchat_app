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
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./routes/auth'));
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));
app.use('/api', require('./routes/api'));

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

initSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`💬 Messenger clone đang chạy tại http://localhost:${PORT}`);
});
