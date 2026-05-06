try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
} catch (_) {
  // In production platforms env vars may be injected without dotenv package.
}
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const db = require('./db');
const runtimePaths = require('./runtime-paths');
const context = require('./context');
const { initTelegramClient, startAuthFlow, resolveAuthStep, getClient, getAuthStep } = require('./telegram');

const app = express();

const PORT = process.env.PORT || 5050;
const JWT_SECRET = String(process.env.JWT_SECRET || '').trim() || 'railway-fallback-jwt-secret-change-me';
if (!String(process.env.JWT_SECRET || '').trim()) {
  console.warn('JWT_SECRET is missing in environment. Using fallback secret. Set JWT_SECRET in Railway Variables for production security.');
}

const TRUSTED_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (TRUSTED_ORIGINS.includes(origin)) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)*up\.railway\.app$/i.test(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
};

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('CORS origin denied'));
  }
}));
app.use(express.json());

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;
const authAttemptMap = new Map();

const getClientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();

const authLimiter = (req, res, next) => {
  const key = `${getClientIp(req)}:${req.path}`;
  const now = Date.now();
  const state = authAttemptMap.get(key);

  if (!state || now > state.resetAt) {
    authAttemptMap.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return next();
  }

  if (state.count >= AUTH_MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((state.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(Math.max(retryAfterSec, 1)));
    return res.status(429).json({ error: 'Too many auth attempts. Please try again later.' });
  }

  state.count += 1;
  return next();
};

const sendServerError = (res, message = 'Internal server error') => (
  res.status(500).json({ error: message })
);

const bootstrapAdminFromEnv = async () => {
  const username = String(process.env.BOOTSTRAP_ADMIN_USERNAME || '').trim();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '').trim();
  if (!username) return;

  try {
    const existing = db.central.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
    if (!existing) {
      if (!password) {
        console.warn(`BOOTSTRAP_ADMIN_USERNAME is set (${username}), but BOOTSTRAP_ADMIN_PASSWORD is missing. Skipping admin bootstrap.`);
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      const info = db.central
        .prepare('INSERT INTO users (username, role, password_hash) VALUES (?, ?, ?)')
        .run(username, 'admin', hash);
      console.log(`Bootstrap admin created: ${username} (id ${info.lastInsertRowid})`);
      return;
    }

    db.central.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', existing.id);
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      db.central.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
      console.log(`Bootstrap admin updated: ${username} (role=admin, password reset)`);
      return;
    }
    console.log(`Bootstrap admin role ensured: ${username} (role=admin)`);
  } catch (error) {
    console.error('bootstrap admin error:', error);
  }
};

const verifyAuthToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  const queryToken = String(req.query?.token || '').trim();
  const token = headerToken || queryToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized. Please login.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    req.userRole = decoded.role || 'user';
    return context.runWithContext({ userId: decoded.userId }, next);
  } catch (_error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
};

app.use('/uploads', verifyAuthToken, express.static(runtimePaths.uploadsDir));

// --- SYSTEM AUTH ROUTES (Без контексту) ---
app.post('/api/system/register', authLimiter, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const existing = db.central.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ error: 'Username already exists' });

    const usersCount = db.central.prepare('SELECT COUNT(*) AS count FROM users').get();
    const role = Number(usersCount?.count || 0) === 0 ? 'admin' : 'user';

    const hash = await bcrypt.hash(password, 10);
    const info = db.central
      .prepare('INSERT INTO users (username, role, password_hash) VALUES (?, ?, ?)')
      .run(username, role, hash);

    res.json({ success: true, userId: info.lastInsertRowid, role });
  } catch (error) {
    console.error('register error:', error);
    sendServerError(res);
  }
});

app.post('/api/system/login', authLimiter, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const bootstrapUsername = String(process.env.BOOTSTRAP_ADMIN_USERNAME || '').trim();
    const bootstrapPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');

    if (bootstrapUsername && bootstrapPassword && username === bootstrapUsername && password === bootstrapPassword) {
      let user = db.central.prepare('SELECT * FROM users WHERE username = ?').get(username);
      const hash = await bcrypt.hash(password, 10);

      if (!user) {
        const info = db.central
          .prepare('INSERT INTO users (username, role, password_hash) VALUES (?, ?, ?)')
          .run(username, 'admin', hash);
        user = db.central.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      } else {
        db.central.prepare('UPDATE users SET role = ?, password_hash = ? WHERE id = ?').run('admin', hash, user.id);
        user = { ...user, role: 'admin', password_hash: hash };
      }

      const token = jwt.sign({ userId: user.id, username: user.username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ success: true, token, username: user.username, role: 'admin' });
    }

    const user = db.central.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const role = String(user.role || 'user');
    const token = jwt.sign({ userId: user.id, username: user.username, role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, username: user.username, role });
  } catch (error) {
    console.error('login error:', error);
    sendServerError(res);
  }
});

app.patch('/api/system/users/:id/role', verifyAuthToken, requireAdmin, (req, res) => {
  try {
    const targetUserId = Number.parseInt(req.params.id, 10);
    const role = String(req.body?.role || '').trim().toLowerCase();
    if (!Number.isFinite(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
    }
    const target = db.central.prepare('SELECT id, username, role FROM users WHERE id = ?').get(targetUserId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    db.central.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetUserId);
    return res.json({
      success: true,
      user: {
        id: target.id,
        username: target.username,
        role
      }
    });
  } catch (error) {
    console.error('update role error:', error);
    return sendServerError(res);
  }
});

app.get('/api/system/users', verifyAuthToken, requireAdmin, (req, res) => {
  try {
    const users = db.central.prepare(`
      SELECT id, username, role
      FROM users
      ORDER BY id ASC
    `).all();
    return res.json({ users });
  } catch (error) {
    console.error('list users error:', error);
    return sendServerError(res);
  }
});

const ALLOWED_PERMISSION_KEYS = new Set([
  'can_manage_documents',
  'can_manage_tags',
  'can_manage_broadcasts',
  'can_manage_requests',
  'can_manage_warehouse_orders'
]);

app.get('/api/system/users/:id/permissions', verifyAuthToken, requireAdmin, (req, res) => {
  try {
    const targetUserId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetUserId)) return res.status(400).json({ error: 'Invalid user id' });
    const rows = db.central.prepare(`
      SELECT permission_key, is_allowed
      FROM user_permissions
      WHERE user_id = ?
    `).all(targetUserId);
    const permissions = {};
    for (const row of rows) permissions[row.permission_key] = Number(row.is_allowed) === 1;
    return res.json({ userId: targetUserId, permissions });
  } catch (error) {
    console.error('get permissions error:', error);
    return sendServerError(res);
  }
});

app.patch('/api/system/users/:id/permissions', verifyAuthToken, requireAdmin, (req, res) => {
  try {
    const targetUserId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetUserId)) return res.status(400).json({ error: 'Invalid user id' });
    const patch = req.body?.permissions;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'permissions object is required' });

    const target = db.central.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const upsert = db.central.prepare(`
      INSERT INTO user_permissions (user_id, permission_key, is_allowed, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, permission_key) DO UPDATE SET
        is_allowed = excluded.is_allowed,
        updated_at = CURRENT_TIMESTAMP
    `);

    for (const [key, value] of Object.entries(patch)) {
      if (!ALLOWED_PERMISSION_KEYS.has(key)) continue;
      upsert.run(targetUserId, key, value ? 1 : 0);
    }

    const rows = db.central.prepare(`
      SELECT permission_key, is_allowed
      FROM user_permissions
      WHERE user_id = ?
    `).all(targetUserId);
    const permissions = {};
    for (const row of rows) permissions[row.permission_key] = Number(row.is_allowed) === 1;

    return res.json({ success: true, userId: targetUserId, permissions });
  } catch (error) {
    console.error('update permissions error:', error);
    return sendServerError(res);
  }
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/system/')) return next();
  return verifyAuthToken(req, res, next);
});

// --- TELEGRAM API AUTH FLOW ---
app.post('/api/auth/start', async (req, res) => {
  try {
    let client = getClient();
    if (!client) {
      const idRow = db.prepare("SELECT value FROM settings WHERE key = 'api_id'").get();
      const hashRow = db.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get();

      const API_ID = idRow ? idRow.value : process.env.API_ID;
      const API_HASH = hashRow ? hashRow.value : process.env.API_HASH;

      if (!API_ID || !API_HASH) {
        return res.status(500).json({ success: false, error: 'Налаштування API відсутні. Будь ласка, вкажіть API ID та API HASH в налаштуваннях.' });
      }

      client = await initTelegramClient(API_ID, API_HASH);
      if (!client) {
        return res.status(500).json({ success: false, error: 'Не вдалося ініціалізувати Telegram клієнт' });
      }
    }

    const userId = context.getUserId();
    if (!userId) {
      throw new Error('Database access outside of user context (SaaS isolation error)');
    }
    context.runWithContext({ userId }, () => {
      startAuthFlow().then((result) => {
        console.log(`[User ${userId}] Auth flow finished:`, result);
      }).catch((error) => {
        console.error(`[User ${userId}] Auth flow error:`, error);
      });
    });

    res.json({ success: true, message: 'Auth flow started. Please provide phone number next.' });
  } catch (error) {
    console.error('auth/start error:', error);
    sendServerError(res, 'Не вдалося запустити авторизацію Telegram');
  }
});

app.post('/api/auth/phone', (req, res) => {
  const { phone } = req.body;
  const resolved = resolveAuthStep('phoneNumber', phone);
  res.json({ success: resolved, message: resolved ? 'Phone accepted' : 'No active phone request' });
});

app.post('/api/auth/code', (req, res) => {
  const { code } = req.body;
  const resolved = resolveAuthStep('phoneCode', code);
  res.json({ success: resolved, message: resolved ? 'Code accepted' : 'No active code request' });
});

app.post('/api/auth/password', (req, res) => {
  const { password } = req.body;
  const resolved = resolveAuthStep('password', password);
  res.json({ success: resolved, message: resolved ? 'Password accepted' : 'No active password request' });
});

app.get('/api/auth/status', async (req, res) => {
  const client = getClient();
  let connected = false;
  if (client && client.connected) {
    try {
      const checkAuthPromise = client.checkAuthorization().catch((e) => { throw e; });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000));
      connected = await Promise.race([checkAuthPromise, timeoutPromise]);
    } catch (e) {
      if (e.message === 'timeout') { connected = true; } else { connected = false; }
    }
  }
  const step = getAuthStep();
  res.json({ connected, waitingFor: step });
});

// --- API CRM ---
const chatRoutes = require('./routes/chat');
app.use('/api/chat', chatRoutes);

const contactsRoutes = require('./routes/contacts');
app.use('/api/contacts', contactsRoutes);

const tagsRoutes = require('./routes/tags');
app.use('/api/tags', tagsRoutes);

const bulkRoutes = require('./routes/bulk');
app.use('/api/bulk', bulkRoutes);

const notesRoutes = require('./routes/notes');
app.use('/api/notes', notesRoutes);

const settingsRoutes = require('./routes/settings');
app.use('/api/settings', settingsRoutes);

const requestRoutes = require('./routes/requests');
app.use('/api/requests', requestRoutes);

const documentRoutes = require('./routes/documents');
app.use('/api/documents', documentRoutes);
const tasksRoutes = require('./routes/tasks');
app.use('/api/tasks', tasksRoutes);
const ordersRoutes = require('./routes/orders');
app.use('/api/orders', ordersRoutes);

const TELEGRAM_BOT_API = 'https://api.telegram.org';
const sentRepeatCache = new Map();
const sendBotMessageForUser = async (userId, text) => {
  return context.runWithContext({ userId }, async () => {
    const enabled = String(db.prepare("SELECT value FROM settings WHERE key='bot_enabled'").get()?.value || '0') === '1';
    if (!enabled) return false;
    const token = String(db.prepare("SELECT value FROM settings WHERE key='bot_token'").get()?.value || '').trim();
    const chatId = String(db.prepare("SELECT value FROM settings WHERE key='bot_chat_id'").get()?.value || '').trim();
    if (!token || !chatId) return false;
    const r = await fetch(`${TELEGRAM_BOT_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text || '') })
    });
    const data = await r.json().catch(() => ({}));
    return !!(r.ok && data?.ok);
  });
};

setInterval(async () => {
  try {
    const users = db.central.prepare('SELECT id FROM users').all();
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const nowTime = `${hh}:${mm}`;
    const today = now.toISOString().slice(0, 10);
    for (const u of users) {
      await context.runWithContext({ userId: u.id }, async () => {
        const tasksRaw = db.prepare("SELECT value FROM settings WHERE key='tasks_v2'").get()?.value;
        const reminderRaw = db.prepare("SELECT value FROM settings WHERE key='task_reminder_settings_v2'").get()?.value;
        let tasks = [];
        let reminder = { enabled: false, time: '09:00', lastSentDate: '' };
        try { tasks = tasksRaw ? JSON.parse(tasksRaw) : []; } catch (_) {}
        try { reminder = reminderRaw ? JSON.parse(reminderRaw) : reminder; } catch (_) {}
        let changed = false;

        for (const task of tasks) {
          if (!task?.reminderAt) continue;
          const ts = new Date(task.reminderAt).getTime();
          if (!Number.isFinite(ts) || ts > Date.now()) continue;
          if (!task.reminderRepeat && task.reminderSentAt) continue;

          const key = `${u.id}:${task.id}:${task.reminderAt}`;
          if (task.reminderRepeat) {
            const repeatKey = `${key}:${today}:${nowTime}`;
            if (sentRepeatCache.has(repeatKey)) continue;
            sentRepeatCache.set(repeatKey, Date.now());
          }
          const ok = await sendBotMessageForUser(u.id, `Нагадування по задачі\nЗадача: ${task.title || 'Без назви'}`);
          if (!ok) continue;

          if (task.reminderRepeat === 'daily') {
            const d = new Date(task.reminderAt);
            d.setDate(d.getDate() + 1);
            task.reminderAt = d.toISOString().slice(0, 16);
            task.reminderSentAt = new Date().toISOString();
            changed = true;
          } else if (task.reminderRepeat === 'weekly') {
            const d = new Date(task.reminderAt);
            d.setDate(d.getDate() + 7);
            task.reminderAt = d.toISOString().slice(0, 16);
            task.reminderSentAt = new Date().toISOString();
            changed = true;
          } else {
            task.reminderSentAt = new Date().toISOString();
            changed = true;
          }
        }

        if (reminder.enabled && reminder.time === nowTime && reminder.lastSentDate !== today) {
          const todayTasks = tasks.filter((t) => String(t.planDate || '') === today);
          const lines = todayTasks.length
            ? todayTasks.map((t, i) => `${i + 1}. ${t.title || 'Без назви'}`)
            : ['На сьогодні задач немає.'];
          const ok = await sendBotMessageForUser(u.id, `Щоденний дайджест задач (${today})\n\n${lines.join('\n')}`);
          if (ok) {
            reminder.lastSentDate = today;
            changed = true;
          }
        }

        if (changed) {
          db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('tasks_v2', ?)").run(JSON.stringify(tasks));
          db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('task_reminder_settings_v2', ?)").run(JSON.stringify(reminder));
        }
      });
    }
  } catch (e) {
    console.error('Task scheduler error:', e.message);
  }
}, 60000);

// Сервінг фронтенду
const resolveFrontendDistDir = () => {
  const candidates = [
    String(process.env.FRONTEND_DIST_DIR || '').trim(),
    path.join(__dirname, '..', 'frontend', 'dist'),
    path.join(process.cwd(), 'frontend', 'dist'),
    '/app/frontend/dist'
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p));

  const uniqueCandidates = [...new Set(candidates)];
  const existing = uniqueCandidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  return { existing, candidates: uniqueCandidates };
};

const { existing: frontendDistDir, candidates: frontendDistCandidates } = resolveFrontendDistDir();

if (frontendDistDir) {
  console.log(`[frontend] Serving static files from: ${frontendDistDir}`);
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });
  app.use(express.static(frontendDistDir));
  app.get(/^\/(?!api|uploads).*/, (req, res) => {
    res.sendFile(path.join(frontendDistDir, 'index.html'));
  });
} else {
  console.warn(`[frontend] Dist directory not found. Tried: ${frontendDistCandidates.join(', ')}`);
  app.get('/', (_req, res) => {
    res.status(503).send(`Frontend build not found. Tried: ${frontendDistCandidates.join(', ')}`);
  });
}

const startServer = (port = PORT) => {
  const server = app.listen(port, async () => {
    await bootstrapAdminFromEnv();
    console.log(`Server is running on port ${port} (SaaS Mode)`);
  });
  return server;
};

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, verifyAuthToken };
