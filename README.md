# 💬 ChitChat — Ứng dụng nhắn tin thời gian thực

Web app chat real-time lấy cảm hứng từ Facebook Messenger. Chạy tốt trên cả desktop và mobile (responsive + PWA, có thể "Add to Home Screen").

## ✨ Tính năng

- **Đăng ký / đăng nhập** — email + mật khẩu, mã hoá bcrypt, JWT session (30 ngày)
- **Danh sách hội thoại** — avatar, tên, tin nhắn cuối, thời gian, badge số tin chưa đọc
- **Chat real-time** qua Socket.io — không cần reload trang
- **Bong bóng chat** kiểu Messenger (xanh bên phải / xám bên trái, bo góc 18px)
- **"Đang nhập..."** — typing indicator với hiệu ứng 3 chấm
- **Online / offline** — chấm xanh + "Đang hoạt động" / "Hoạt động X phút trước"
- **Đã gửi ✓ / Đã nhận ✓✓ / Đã xem ✓✓ xanh** — read receipt real-time
- **Gửi ảnh** (tối đa 5MB) + **emoji picker**
- **Tìm kiếm** hội thoại & tìm người dùng để bắt đầu chat mới
- **Gọi thoại / video** 📞🎥 — WebRTC P2P, signaling qua Socket.io (STUN công cộng)
- **Panel thông tin đoạn chat** — bấm vào tên người chat: xem file/ảnh đã chia sẻ, tìm kiếm tin nhắn, tắt/bật thông báo, đổi màu bong bóng chat, lưu trữ đoạn chat
- **Đoạn chat đã lưu trữ** 🗃️ — ẩn khỏi danh sách chính, tự hiện lại khi có tin nhắn mới
- **Tin nhắn thoại** 🎤 — ghi âm và gửi, nghe lại ngay trong khung chat
- **Thả like nhanh** 👍 — bấm khi ô chat trống để gửi like cỡ lớn
- **Responsive mobile** — sidebar ẩn khi mở chat, nút back
- **PWA** — manifest + service worker, cài được lên home screen
- **Bảo mật** — validate input, rate limiting chống spam, giới hạn kích thước file

## 🚀 Chạy nhanh

```bash
cd messenger-clone
npm install
npm run seed     # tạo 3 tài khoản demo
npm start        # chạy tại http://localhost:3000
```

Tài khoản demo (mật khẩu `demo1234`):

| Email | Tên |
|---|---|
| demo1@demo.com | An Nguyễn |
| demo2@demo.com | Bình Trần |
| demo3@demo.com | Chi Phạm |

Mở 2 tab/browser khác nhau, đăng nhập 2 tài khoản → chat thử real-time.

Chạy test tự động (cần server đang chạy):

```bash
npm test
```

## 🛠 Stack

- **Backend:** Node.js + Express 5
- **Real-time:** Socket.io 4
- **Database:** SQLite (better-sqlite3, WAL mode) — file `data/messenger.db`
- **Auth:** JWT + bcryptjs
- **Upload:** multer (lưu local `uploads/`, tối đa 5MB, chỉ ảnh)
- **Frontend:** HTML/CSS/JS thuần, mobile-first

## 📁 Cấu trúc

```
messenger-clone/
├── src/
│   ├── server.js        # Express + Socket.io, static files, SPA fallback
│   ├── db.js            # SQLite schema + query helpers
│   ├── socket.js        # real-time: message, typing, online/offline, seen
│   ├── middleware.js    # JWT auth, rate limiter
│   └── routes/
│       ├── auth.js      # POST /api/auth/register, /login, GET /me
│       └── api.js       # users, conversations, messages, upload
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   ├── manifest.json    # PWA
│   ├── sw.js            # service worker
│   └── icons/           # icon 192/512
├── scripts/
│   ├── seed.js          # tạo tài khoản demo
│   ├── test-flow.js     # test e2e 16 case
│   └── make-icons.js    # tạo icon PNG
├── data/                # SQLite db + jwt secret (tự tạo)
└── uploads/             # ảnh upload (tự tạo)
```

## 🔌 API tóm tắt

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/auth/register` | `{name, email, password}` |
| POST | `/api/auth/login` | `{email, password}` |
| GET | `/api/auth/me` | Thông tin user hiện tại |
| GET | `/api/users?q=` | Tìm người dùng |
| GET | `/api/conversations` | Danh sách hội thoại (+ unread) |
| POST | `/api/conversations/private` | `{userId}` — lấy/tạo chat 1-1 |
| POST | `/api/conversations/group` | `{name, memberIds}` — tạo nhóm |
| GET | `/api/conversations/:id/messages?before=&limit=` | Lịch sử chat (phân trang) |
| POST | `/api/upload` | Upload ảnh (multipart `image`) |

Socket events: `message:send` → `message:new` · `typing:start/stop` → `typing:update` ·
`messages:seen` → `messages:seen` · `user:online` / `user:offline`

## 🌐 Deploy lên internet (cho mọi người dùng)

Database dùng **Turso** (SQLite trên cloud, miễn phí, không giới hạn thời gian) nên chạy tốt trên gói free của Render mà không cần ổ đĩa.

1. Tạo tài khoản [Turso](https://turso.tech) (đăng nhập bằng GitHub cho nhanh)
   - Tạo database mới tên `chitchat`
   - Tạo auth token cho database đó (mục Tokens)
   - Copy 2 giá trị: **Database URL** (dạng `libsql://chitchat-xxx.turso.io`) và **Auth token**
2. Trên GitHub: upload code mới nhất lên repo (kéo-thả ghi đè các file cũ là được)
3. Trên Render: **New +** → **Blueprint** → chọn repo → khi được hỏi, điền `TURSO_DATABASE_URL` và `TURSO_AUTH_TOKEN` → **Apply**
4. Đợi 3-5 phút build xong → bạn có link dạng `https://chitchat-xxxx.onrender.com` — gửi cho ai cũng dùng được, mỗi người tự đăng ký tài khoản riêng

Lưu ý gói free:
- Sau 15 phút không ai dùng, server "ngủ" — người mở đầu tiên chờ ~1 phút để nó thức dậy
- Tin nhắn và tài khoản lưu trên Turso nên không bao giờ mất. Riêng ảnh upload lưu tạm trên server, có thể mất khi server khởi động lại (giới hạn của gói free — nâng cấp sau nếu cần)

## 🔮 Gợi ý mở rộng

- [ ] Chat nhóm (UI tạo nhóm — backend đã hỗ trợ)
- [ ] Gọi video/voice (WebRTC)
- [ ] Reactions (thả cảm xúc vào tin nhắn)
- [ ] Push notification (Web Push API)
- [ ] Dark mode
- [ ] Chuyển SQLite → PostgreSQL khi cần scale (tách lớp `db.js`)
