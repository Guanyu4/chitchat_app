const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Chế độ cloud (Turso): set TURSO_DATABASE_URL=libsql://... + TURSO_AUTH_TOKEN
// Chế độ local: dùng file SQLite thường (mặc định)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(DATA_DIR, 'messenger.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const N = (v) => (typeof v === 'bigint' ? Number(v) : v);

async function initSchema() {
  await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  online_status INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'private',
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'sent',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
`);
  await db.execute('PRAGMA journal_mode = WAL');
}

const schemaReady = initSchema();

async function q(sql, args) {
  await schemaReady;
  const rs = await db.execute({ sql, args: args ?? [] });
  return rs;
}
const row = (rs) => rs.rows[0] || null;

// ---------- users ----------
async function createUser(name, email, passwordHash) {
  const r = await q(
    `INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    [name, email, passwordHash, Date.now()]
  );
  return getUserById(N(r.lastInsertRowid));
}
async function getUserByEmail(email) {
  return row(await q(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()]));
}
async function getUserById(id) {
  return row(await q(`SELECT * FROM users WHERE id = ?`, [id]));
}
async function setOnline(id) {
  await q(`UPDATE users SET online_status = 1 WHERE id = ?`, [id]);
}
async function setOffline(id) {
  await q(`UPDATE users SET online_status = 0, last_seen = ? WHERE id = ?`, [Date.now(), id]);
}
async function searchUsers(excludeId, query) {
  const like = `%${query}%`;
  const rs = await q(
    `SELECT id, name, email, avatar_url, online_status, last_seen
     FROM users WHERE id != ? AND (name LIKE ? OR email LIKE ?) LIMIT 20`,
    [excludeId, like, like]
  );
  return rs.rows;
}

// ---------- conversations ----------
async function createConversation(type, name, memberIds) {
  const r = await q(
    `INSERT INTO conversations (type, name, created_at) VALUES (?, ?, ?)`,
    [type, name || null, Date.now()]
  );
  const id = N(r.lastInsertRowid);
  for (const uid of memberIds) {
    await q(
      `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`,
      [id, uid]
    );
  }
  return id;
}
async function getOrCreatePrivateConversation(uidA, uidB) {
  const found = row(await q(
    `SELECT cm1.conversation_id AS id
     FROM conversation_members cm1
     JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
     JOIN conversations c ON c.id = cm1.conversation_id
     WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.type = 'private'
       AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 2
     LIMIT 1`,
    [uidA, uidB]
  ));
  if (found) return N(found.id);
  return createConversation('private', null, [uidA, uidB]);
}
async function getConversationsForUser(uid) {
  const rs = await q(
    `SELECT c.id, c.type, c.name, c.created_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_content,
      (SELECT m.type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_type,
      (SELECT m.sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender_id,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id AND m.sender_id != @uid
           AND m.id > COALESCE((SELECT last_read_message_id FROM conversation_members
                                 WHERE conversation_id = c.id AND user_id = @uid), 0)
      ) AS unread_count
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.user_id = @uid
    ORDER BY COALESCE(last_at, c.created_at) DESC`,
    { uid }
  );
  const out = [];
  for (const c of rs.rows) {
    const conv = { ...c, id: N(c.id), unread_count: N(c.unread_count) };
    let peer = null;
    let members = [];
    if (c.type === 'private') {
      peer = row(await q(
        `SELECT u.id, u.name, u.avatar_url, u.online_status, u.last_seen
         FROM users u
         JOIN conversation_members cm ON cm.user_id = u.id
         WHERE cm.conversation_id = ? AND u.id != ?
         LIMIT 1`,
        [c.id, uid]
      ));
      if (peer) peer.id = N(peer.id);
    } else {
      const mrs = await q(
        `SELECT u.id, u.name, u.avatar_url, u.online_status
         FROM users u
         JOIN conversation_members cm ON cm.user_id = u.id
         WHERE cm.conversation_id = ?`,
        [c.id]
      );
      members = mrs.rows.map((m) => ({ ...m, id: N(m.id) }));
    }
    out.push({ ...conv, peer, members });
  }
  return out;
}
async function isMember(conversationId, userId) {
  return !!row(await q(
    `SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId]
  ));
}
async function memberIdsOf(conversationId) {
  const rs = await q(
    `SELECT user_id FROM conversation_members WHERE conversation_id = ?`,
    [conversationId]
  );
  return rs.rows.map((r) => N(r.user_id));
}

// ---------- messages ----------
async function createMessage(conversationId, senderId, content, type) {
  const r = await q(
    `INSERT INTO messages (conversation_id, sender_id, content, type, status, created_at)
     VALUES (?, ?, ?, ?, 'sent', ?)`,
    [conversationId, senderId, content, type || 'text', Date.now()]
  );
  const msg = row(await q(`SELECT * FROM messages WHERE id = ?`, [N(r.lastInsertRowid)]));
  const sender = await getUserById(senderId);
  return {
    ...msg,
    id: N(msg.id),
    sender_name: sender.name,
    sender_avatar: sender.avatar_url,
  };
}
async function getMessages(conversationId, beforeId, limit = 50) {
  const rs = await q(
    `SELECT m.*, u.name AS sender_name, u.avatar_url AS sender_avatar
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ?
       AND (? IS NULL OR m.id < ?)
     ORDER BY m.id DESC LIMIT ?`,
    [conversationId, beforeId || null, beforeId || null, Math.min(limit, 100)]
  );
  return rs.rows.map((m) => ({ ...m, id: N(m.id) })).reverse();
}
async function markConversationSeen(conversationId, userId) {
  await q(
    `UPDATE messages SET status = 'seen'
     WHERE conversation_id = ? AND sender_id != ? AND status != 'seen'`,
    [conversationId, userId]
  );
  const maxRow = row(await q(
    `SELECT MAX(id) AS max_id FROM messages WHERE conversation_id = ?`,
    [conversationId]
  ));
  await q(
    `UPDATE conversation_members SET last_read_message_id = ?
     WHERE conversation_id = ? AND user_id = ?`,
    [N(maxRow?.max_id || 0), conversationId, userId]
  );
}
async function markDelivered(messageId) {
  await q(`UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'`, [messageId]);
}

// ---------- jwt secret ----------
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

module.exports = {
  createUser, getUserByEmail, getUserById, setOnline, setOffline, searchUsers,
  createConversation, getOrCreatePrivateConversation, getConversationsForUser,
  isMember, memberIdsOf, createMessage, getMessages,
  markConversationSeen, markDelivered, getJwtSecret,
};
