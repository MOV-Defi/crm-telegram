const express = require('express');
const db = require('../db');
const runtimePaths = require('../runtime-paths');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();
const upload = multer({ dest: runtimePaths.mediaDir });

const VIEW_KEY = 'can_view_warehouse_orders';
const EDIT_KEY = 'can_edit_warehouse_orders';
const LEGACY_MANAGE_KEY = 'can_manage_warehouse_orders';
const STATUS_SET = new Set(['new', 'in_progress', 'ready', 'issued', 'rejected']);
const REQUEST_TYPE_SET = new Set(['reservation', 'issuance']);
const PROJECT_RE = /про(?:е|є)кт\s*[:\-]?\s*["«]?([^"\n»]+)["»]?/i;

const decodeMultipartFileName = (name) => {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (!/[ÐÑ]/.test(raw)) return raw;
  try {
    const repaired = Buffer.from(raw, 'latin1').toString('utf8').trim();
    if (!repaired) return raw;
    if (/[\p{Script=Cyrillic}\p{L}\p{N}]/u.test(repaired)) return repaired;
    return raw;
  } catch (_) {
    return raw;
  }
};

const normalizeOrderRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    media_name: decodeMultipartFileName(row.media_name),
    request_type: REQUEST_TYPE_SET.has(String(row.request_type || '').trim()) ? String(row.request_type).trim() : 'issuance'
  };
};

const getPermissionValue = (userId, permissionKey) => {
  const row = db.central.prepare(`
    SELECT is_allowed FROM user_permissions WHERE user_id = ? AND permission_key = ?
  `).get(userId, permissionKey);
  return Number(row?.is_allowed || 0) === 1;
};

const canEditOrders = (req) => {
  if (req.userRole === 'admin') return true;
  return getPermissionValue(req.userId, EDIT_KEY) || getPermissionValue(req.userId, LEGACY_MANAGE_KEY);
};

const canViewOrders = (req) => {
  if (req.userRole === 'admin') return true;
  return getPermissionValue(req.userId, VIEW_KEY) || canEditOrders(req);
};

router.get('/permissions', (req, res) => {
  try {
    const canEdit = canEditOrders(req);
    const canView = canViewOrders(req);
    res.json({ canView, canEdit, canManage: canEdit });
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', (req, res) => {
  try {
    if (!canViewOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const rows = db.central.prepare(`
      SELECT *
      FROM warehouse_orders
      ORDER BY id DESC
      LIMIT 500
    `).all();
    res.json(rows.map(normalizeOrderRow));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', upload.single('file'), (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const chatId = String(req.body?.chatId || '').trim();
    const chatName = String(req.body?.chatName || '').trim();
    const messageId = Number.parseInt(req.body?.messageId, 10);
    const messageText = String(req.body?.messageText || '').trim();
    let projectName = String(req.body?.projectName || '').trim();
    const requesterName = String(req.body?.requesterName || '').trim();
    const requestTypeRaw = String(req.body?.requestType || '').trim();
    const requestType = REQUEST_TYPE_SET.has(requestTypeRaw) ? requestTypeRaw : 'issuance';
    let mediaPath = String(req.body?.mediaPath || '').trim();
    let mediaName = decodeMultipartFileName(String(req.body?.mediaName || '').trim());

    if (req.file) {
      const normalizedOriginalName = decodeMultipartFileName(req.file.originalname || '');
      const ext = path.extname(normalizedOriginalName || '') || '.bin';
      const safeBase = String(path.basename(normalizedOriginalName || 'file', ext))
        .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
        .trim()
        .slice(0, 80) || 'file';
      const finalName = `${safeBase}_${crypto.randomBytes(3).toString('hex')}${ext.toLowerCase()}`;
      const finalPath = path.join(runtimePaths.mediaDir, finalName);
      fs.renameSync(req.file.path, finalPath);
      mediaPath = `/uploads/media/${finalName}`;
      mediaName = normalizedOriginalName || finalName;
    }

    if (!messageText && !mediaPath) {
      return res.status(400).json({ error: 'Додайте опис або файл замовлення' });
    }
    if (!projectName && messageText) {
      const m = messageText.match(PROJECT_RE);
      if (m?.[1]) projectName = String(m[1]).trim().slice(0, 255);
    }
    const info = db.central.prepare(`
      INSERT INTO warehouse_orders (
        chat_id, chat_name, message_id, message_text, media_path, media_name, project_name, requester_name, request_type, status,
        created_by_user_id, created_by_username, status_updated_at, status_updated_by_user_id, status_updated_by_username
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, CURRENT_TIMESTAMP, ?, ?)
    `).run(
      chatId,
      chatName,
      Number.isFinite(messageId) ? messageId : null,
      messageText || null,
      mediaPath || null,
      mediaName || null,
      projectName || null,
      requesterName || req.username || null,
      requestType,
      req.userId,
      req.username || null,
      req.userId,
      req.username || null
    );
    const created = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json(normalizeOrderRow(created));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/status', (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    const nextStatus = String(req.body?.status || '').trim();
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });
    if (!STATUS_SET.has(nextStatus)) return res.status(400).json({ error: 'Некоректний статус' });
    const current = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Замовлення не знайдено' });
    db.central.prepare(`
      UPDATE warehouse_orders
      SET status = ?,
          updated_at = CURRENT_TIMESTAMP,
          status_updated_at = CURRENT_TIMESTAMP,
          status_updated_by_user_id = ?,
          status_updated_by_username = ?,
          assigned_to_user_id = COALESCE(assigned_to_user_id, ?),
          assigned_to_username = COALESCE(assigned_to_username, ?)
      WHERE id = ?
    `).run(nextStatus, req.userId, req.username || null, req.userId, req.username || null, id);
    const updated = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    res.json(normalizeOrderRow(updated));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', upload.single('file'), (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });

    const current = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Замовлення не знайдено' });

    const messageText = String(req.body?.messageText || current.message_text || '').trim();
    const projectName = String(req.body?.projectName || current.project_name || '').trim();
    const requesterName = String(req.body?.requesterName || current.requester_name || '').trim();
    const requestTypeRaw = String(req.body?.requestType || current.request_type || '').trim();
    const requestType = REQUEST_TYPE_SET.has(requestTypeRaw) ? requestTypeRaw : 'issuance';

    let mediaPath = String(current.media_path || '');
    let mediaName = String(current.media_name || '');

    if (req.file) {
      const normalizedOriginalName = decodeMultipartFileName(req.file.originalname || '');
      const ext = path.extname(normalizedOriginalName || '') || '.bin';
      const safeBase = String(path.basename(normalizedOriginalName || 'file', ext))
        .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
        .trim()
        .slice(0, 80) || 'file';
      const finalName = `${safeBase}_${crypto.randomBytes(3).toString('hex')}${ext.toLowerCase()}`;
      const finalPath = path.join(runtimePaths.mediaDir, finalName);
      fs.renameSync(req.file.path, finalPath);
      mediaPath = `/uploads/media/${finalName}`;
      mediaName = normalizedOriginalName || finalName;
    }

    db.central.prepare(`
      UPDATE warehouse_orders
      SET message_text = ?,
          project_name = ?,
          requester_name = ?,
          request_type = ?,
          media_path = ?,
          media_name = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      messageText || null,
      projectName || null,
      requesterName || null,
      requestType,
      mediaPath || null,
      mediaName || null,
      id
    );

    const updated = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    res.json(normalizeOrderRow(updated));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
