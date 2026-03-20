const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ==================== DATABASE CONNECTION ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Uh0xAuseDTE9@ep-orange-king-aetsxx7k-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
  if (err) console.error('❌ DB Error:', err.message);
  else console.log('✅ Connected to Neon PostgreSQL');
});

// ==================== HEALTH CHECK ====================
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'OXYX API is running' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working!', time: new Date().toISOString() });
});

// ==================== AUTH ====================
app.post('/api/register', async (req, res) => {
  const { username, email, password, token, ip } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM users WHERE username=$1 OR email=$2', [username, email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Username or email exists' });
    
    let role = 'user';
    if (token) {
      const t = await pool.query('SELECT * FROM staff_tokens WHERE token=$1 AND used=false', [token]);
      if (t.rows.length) { 
        role = 'staff'; 
        await pool.query('UPDATE staff_tokens SET used=true, used_by=$1 WHERE token=$2', [username, token]); 
      }
    }
    
    const id = 'u' + Date.now();
    const hashed = bcrypt.hashSync(password, 10);
    await pool.query(`INSERT INTO users(id, username, email, password_hash, role, created_at) VALUES($1,$2,$3,$4,$5,$6)`, 
      [id, username, email, hashed, role, Date.now()]);
    
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password, ip, device } = req.body;
  try {
    const banned = await pool.query('SELECT * FROM banned_ips WHERE ip=$1', [ip]);
    if (banned.rows.length) return res.status(403).json({ error: 'Your IP is banned' });
    
    const user = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!user.rows.length) return res.status(401).json({ error: 'User not found' });
    if (!bcrypt.compareSync(password, user.rows[0].password_hash)) return res.status(401).json({ error: 'Invalid password' });
    
    const u = user.rows[0];
    await pool.query(`INSERT INTO sessions(uid, username, role, ip, last_ping, online, device, joined_at) 
      VALUES($1,$2,$3,$4,$5,true,$6,$7) ON CONFLICT(uid) DO UPDATE SET last_ping=$5, online=true, ip=$4, device=$6`,
      [u.id, u.username, u.role, ip, Date.now(), device, u.created_at]);
    
    res.json({ success: true, user: { id: u.id, username: u.username, role: u.role } });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post('/api/logout', async (req, res) => {
  const { uid } = req.body;
  try {
    await pool.query('UPDATE sessions SET online=false, last_ping=0 WHERE uid=$1', [uid]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post('/api/ping', async (req, res) => {
  const { uid, ip } = req.body;
  try {
    await pool.query('UPDATE sessions SET last_ping=$1, online=true, ip=$2 WHERE uid=$3', [Date.now(), ip, uid]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/online', async (req, res) => {
  try {
    const now = Date.now();
    const result = await pool.query('SELECT username, role, ip FROM sessions WHERE $1 - last_ping < 90000 AND online=true', [now]);
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== BUILDS ====================
app.post('/api/builds', async (req, res) => {
  const { name, type, price, category, desc, contact, photoData, buildFileName, buildFileData, submitter } = req.body;
  try {
    const id = 'b' + Date.now();
    await pool.query(`INSERT INTO builds(id, name, type, price, category, description, contact, photo_data, build_file_name, build_file_data, submitter, created_at) 
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, name, type, price, category, desc, contact, photoData, buildFileName, buildFileData, submitter, Date.now()]);
    res.json({ success: true, id });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/builds', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM builds WHERE status=\'approved\' ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

app.get('/api/builds/pending', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM builds WHERE status=\'pending\' ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

app.put('/api/builds/:id/approve', async (req, res) => {
  try {
    await pool.query('UPDATE builds SET status=\'approved\' WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.delete('/api/builds/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM builds WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ==================== RATINGS ====================
app.post('/api/ratings', async (req, res) => {
  const { buildId, userId, rating } = req.body;
  try {
    await pool.query('INSERT INTO ratings(build_id, user_id, rating) VALUES($1,$2,$3) ON CONFLICT(build_id, user_id) DO UPDATE SET rating=$3', 
      [buildId, userId, rating]);
    const avg = await pool.query('SELECT AVG(rating) as avg FROM ratings WHERE build_id=$1', [buildId]);
    res.json({ success: true, avg: avg.rows[0].avg });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/ratings/:buildId', async (req, res) => {
  try {
    const result = await pool.query('SELECT user_id, rating FROM ratings WHERE build_id=$1', [req.params.buildId]);
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== COMMENTS ====================
app.post('/api/comments', async (req, res) => {
  const { buildId, userId, username, text, parentId } = req.body;
  try {
    const id = 'c' + Date.now();
    await pool.query(`INSERT INTO comments(id, build_id, user_id, username, text, parent_id, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, buildId, userId, username, text, parentId, Date.now()]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/comments/:buildId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM comments WHERE build_id=$1 ORDER BY created_at ASC', [req.params.buildId]);
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== CHAT ====================
app.post('/api/chat', async (req, res) => {
  const { channel, sender, role, text, image } = req.body;
  try {
    const id = 'msg' + Date.now();
    await pool.query(`INSERT INTO chat_messages(id, channel, sender, role, text, image, timestamp) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, channel, sender, role, text, image, Date.now()]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/chat/:channel', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM chat_messages WHERE channel=$1 ORDER BY timestamp DESC LIMIT 100', [req.params.channel]);
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

app.put('/api/chat/pin/:id', async (req, res) => {
  try {
    await pool.query('UPDATE chat_messages SET pinned = NOT pinned WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ==================== ANNOUNCEMENTS ====================
app.post('/api/announcements', async (req, res) => {
  const { message, sender, role } = req.body;
  try {
    const id = 'a' + Date.now();
    await pool.query(`INSERT INTO announcements(id, message, sender, role, timestamp) VALUES($1,$2,$3,$4,$5)`, 
      [id, message, sender, role, Date.now()]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements ORDER BY timestamp DESC LIMIT 10');
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== DMS ====================
app.post('/api/dms', async (req, res) => {
  const { sender, receiver, text } = req.body;
  try {
    const id = 'dm' + Date.now();
    const participants = [sender, receiver].sort();
    await pool.query(`INSERT INTO dms(id, participants, sender, receiver, text, timestamp) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, participants, sender, receiver, text, Date.now()]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/dms/:user1/:user2', async (req, res) => {
  try {
    const participants = [req.params.user1, req.params.user2].sort();
    const result = await pool.query('SELECT * FROM dms WHERE participants=$1 ORDER BY timestamp ASC', [participants]);
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== INBOX ====================
app.post('/api/inbox', async (req, res) => {
  const { userId, message, type, fromUser } = req.body;
  try {
    const id = 'in' + Date.now();
    await pool.query(`INSERT INTO inbox(id, user_id, message, type, from_user, timestamp) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, userId, message, type, fromUser, Date.now()]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/inbox/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inbox WHERE user_id=$1 ORDER BY timestamp DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== STAFF TOKENS ====================
app.post('/api/tokens', async (req, res) => {
  const { token, createdBy } = req.body;
  try {
    await pool.query('INSERT INTO staff_tokens(token, created_at, created_by) VALUES($1,$2,$3)', [token, Date.now(), createdBy]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/tokens', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM staff_tokens');
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== BAN IP ====================
app.post('/api/ban', async (req, res) => {
  const { ip, reason, bannedBy } = req.body;
  try {
    await pool.query('INSERT INTO banned_ips(ip, reason, banned_at, banned_by) VALUES($1,$2,$3,$4) ON CONFLICT(ip) DO NOTHING', 
      [ip, reason, Date.now(), bannedBy]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/banned', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM banned_ips');
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

app.delete('/api/unban/:ip', async (req, res) => {
  try {
    await pool.query('DELETE FROM banned_ips WHERE ip=$1', [req.params.ip]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ==================== ACTIVITY LOGS ====================
app.get('/api/logs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) { 
    res.json([]); 
  }
});

// ==================== START SERVER ====================
app.listen(port, () => console.log(`✅ OXYX API running on port ${port}`));