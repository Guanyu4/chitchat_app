const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'messenger.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
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

// ---------- users ----------
const stmtCreateUser = db.prepare(
  `INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)`
);
const stmtUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
const stmtUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const stmtSetOnline = db.prepare(
  `UPDATE users SET online_status = 1 WHERE id = ?`
);
const stmtSetOffline = db.prepare(
  `UPDATE users SET online_status = 0, last_seen = ? WHERE id = ?`
);
const stmtSearchUsers = db.prepare(
  `SELECT id, name, email, avatar_url, online_status, last_seen
   FROM users WHERE id != ? AND (name LIKE ? OR email LIKE ?) LIMIT 20`
);

function createUser(name, email, passwordHash) {
  const r = stmtCreateUser.run(name, email, passwordHash, Date.now());
  return getUserById(Number(r.lastInsertRowid));
}
function getUserByEmail(email) {
  return stmtUserByEmail.get(email.toLowerCase());
}
function getUserById(id) {
  return stmtUserById.get(id);
}
function setOnline(id) {
  stmtSetOnline.run(id);
}
function setOffline(id) {
  stmtSetOffline.run(Date.now(), id);
}
function searchUsers(excludeId, q) {
  const like = `%${q}%`;
  return stmtSearchUsers.all(excludeId, like, like);
}

// ---------- conversations ----------
const stmtCreateConv = db.prepare(
  `INSERT INTO conversations (type, name, created_at) VALUES (?, ?, ?)`
);
const stmtAddMember = db.prepare(
  `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`
);
const stmtMembersOf = db.prepare(
  `SELECT user_id FROM conversation_members WHERE conversation_id = ?`
);
const stmtIsMember = db.prepare(
  `SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
);
const stmtFindPrivate = db.prepare(`
  SELECT cm1.conversation_id AS id
  FROM conversation_members cm1
  JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
  JOIN conversations c ON c.id = cm1.conversation_id
  WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.type = 'private'
    AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 2
  LIMIT 1
`);
const stmtConversationsForUser = db.prepare(`
  SELECT c.id, c.type, c.name, c.created_at,
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
  ORDER BY COALESCE(last_at, c.created_at) DESC
`);
const stmtPeerOf = db.prepare(`
  SELECT u.id, u.name, u.avatar_url, u.online_status, u.last_seen
  FROM users u
  JOIN conversation_members cm ON cm.user_id = u.id
  WHERE cm.conversation_id = ? AND u.id != ?
  LIMIT 1
`);
const stmtGroupMembers = db.prepare(`
  SELECT u.id, u.name, u.avatar_url, u.online_status
  FROM users u
  JOIN conversation_members cm ON cm.user_id = u.id
  WHERE cm.conversation_id = ?
`);
const stmtSetLastRead = db.prepare(`
  UPDATE conversation_members SET last_read_message_id = ?
  WHERE conversation_id = ? AND user_id = ?
`);

function createConversation(type, name, memberIds) {
  const r = stmtCreateConv.run(type, name || null, Date.now());
  const id = Number(r.lastInsertRowid);
  for (const uid of memberIds) stmtAddMember.run(id, uid);
  return id;
}
function getOrCreatePrivateConversation(uidA, uidB) {
  const found = stmtFindPrivate.get(uidA, uidB);
  if (found) return found.id;
  return createConversation('private', null, [uidA, uidB]);
}
function getConversationsForUser(uid) {
  const rows = stmtConversationsForUser.all({ uid });
  return rows.map((c) => {
    let peer = null;
    let members = [];
    if (c.type === 'private') {
      peer = stmtPeerOf.get(c.id, uid) || null;
    } else {
      members = stmtGroupMembers.all(c.id);
    }
    return { ...c, peer, members };
  });
}
function isMember(conversationId, userId) {
  return !!stmtIsMember.get(conversationId, userId);
}
function memberIdsOf(conversationId) {
  return stmtMembersOf.all(conversationId).map((r) => r.user_id);
}

// ---------- messages ----------
const stmtCreateMessage = db.prepare(
  `INSERT INTO messages (conversation_id, sender_id, content, type, status, created_at)
   VALUES (?, ?, ?, ?, 'sent', ?)`
);
const stmtMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const stmtMessages = db.prepare(`
  SELECT m.*, u.name AS sender_name, u.avatar_url AS sender_avatar
  FROM messages m JOIN users u ON u.id = m.sender_id
  WHERE m.conversation_id = ?
    AND (? IS NULL OR m.id < ?)
  ORDER BY m.id DESC LIMIT ?
`);
const stmtMarkSeen = db.prepare(`
  UPDATE messages SET status = 'seen'
  WHERE conversation_id = ? AND sender_id != ? AND status != 'seen'
`);
const stmtMarkDelivered = db.prepare(`
  UPDATE messages SET status = 'delivered'
  WHERE id = ? AND status = 'sent'
`);
const stmtMaxMsgId = db.prepare(
  `SELECT MAX(id) AS max_id FROM messages WHERE conversation_id = ?`
);

function createMessage(conversationId, senderId, content, type) {
  const r = stmtCreateMessage.run(
    conversationId, senderId, content, type || 'text', Date.now()
  );
  const msg = stmtMessageById.get(Number(r.lastInsertRowid));
  const sender = getUserById(senderId);
  return {
    ...msg,
    sender_name: sender.name,
    sender_avatar: sender.avatar_url,
  };
}
function getMessages(conversationId, beforeId, limit = 50) {
  const rows = stmtMessages.all(
    conversationId, beforeId || null, beforeId || null, Math.min(limit, 100)
  );
  return rows.reverse();
}
function markConversationSeen(conversationId, userId) {
  stmtMarkSeen.run(conversationId, userId);
  const maxId = stmtMaxMsgId.get(conversationId).max_id || 0;
  stmtSetLastRead.run(maxId, conversationId, userId);
}
function markDelivered(messageId) {
  stmtMarkDelivered.run(messageId);
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
