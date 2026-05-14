const express = require('express');
const db = require('../db');

const router = express.Router();
const requireAdminWrite = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Лише адміністратор може змінювати дані кредитного відділу' });
  }
  return next();
};

const parseLinkedChats = (value) => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
};

const toRow = (row) => ({
  id: row.id,
  bankName: row.bank_name || '',
  managerName: row.manager_name || '',
  phone: row.phone || '',
  email: row.email || '',
  telegramContact: row.telegram_contact || '',
  responsibility: row.responsibility || '',
  notes: row.notes || '',
  linkedChatIds: parseLinkedChats(row.linked_chat_ids_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

router.get('/', (req, res) => {
  try {
    const rows = db.central.prepare(`
      SELECT *
      FROM credit_managers
      ORDER BY bank_name COLLATE NOCASE ASC, manager_name COLLATE NOCASE ASC
    `).all();
    return res.json(rows.map(toRow));
  } catch (error) {
    console.error('credit managers list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', requireAdminWrite, (req, res) => {
  try {
    const bankName = String(req.body?.bankName || '').trim();
    const managerName = String(req.body?.managerName || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim();
    const telegramContact = String(req.body?.telegramContact || '').trim();
    const responsibility = String(req.body?.responsibility || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const linkedChatIds = Array.isArray(req.body?.linkedChatIds)
      ? req.body.linkedChatIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (!bankName || !managerName) {
      return res.status(400).json({ error: 'Поля "Банк" і "Менеджер" обовʼязкові' });
    }

    const info = db.central.prepare(`
      INSERT INTO credit_managers (
        bank_name, manager_name, phone, email, telegram_contact, responsibility, notes, linked_chat_ids_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bankName,
      managerName,
      phone || null,
      email || null,
      telegramContact || null,
      responsibility || null,
      notes || null,
      JSON.stringify(linkedChatIds)
    );

    const created = db.central.prepare('SELECT * FROM credit_managers WHERE id = ?').get(Number(info.lastInsertRowid));
    return res.status(201).json(toRow(created));
  } catch (error) {
    console.error('credit managers create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireAdminWrite, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });

    const existing = db.central.prepare('SELECT * FROM credit_managers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Запис не знайдено' });

    const bankName = String(req.body?.bankName || '').trim();
    const managerName = String(req.body?.managerName || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim();
    const telegramContact = String(req.body?.telegramContact || '').trim();
    const responsibility = String(req.body?.responsibility || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const linkedChatIds = Array.isArray(req.body?.linkedChatIds)
      ? req.body.linkedChatIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (!bankName || !managerName) {
      return res.status(400).json({ error: 'Поля "Банк" і "Менеджер" обовʼязкові' });
    }

    db.central.prepare(`
      UPDATE credit_managers
      SET
        bank_name = ?,
        manager_name = ?,
        phone = ?,
        email = ?,
        telegram_contact = ?,
        responsibility = ?,
        notes = ?,
        linked_chat_ids_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      bankName,
      managerName,
      phone || null,
      email || null,
      telegramContact || null,
      responsibility || null,
      notes || null,
      JSON.stringify(linkedChatIds),
      id
    );

    const updated = db.central.prepare('SELECT * FROM credit_managers WHERE id = ?').get(id);
    return res.json(toRow(updated));
  } catch (error) {
    console.error('credit managers update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireAdminWrite, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });

    db.central.prepare('DELETE FROM credit_managers WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (error) {
    console.error('credit managers delete error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
