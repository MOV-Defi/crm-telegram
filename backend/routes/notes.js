const express = require('express');
const db = require('../db');
const router = express.Router();

// Отримати всі збережені повідомлення
router.get('/saved', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM saved_messages ORDER BY created_at DESC').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Зберегти нове повідомлення в нотатки
router.post('/saved', (req, res) => {
    const { chatId, messageId, messageText, mediaPath, comment } = req.body;
    if (!chatId || !messageId) return res.status(400).json({ error: "Missing required fields" });

    try {
        const info = db.prepare(
            'INSERT INTO saved_messages (chat_id, message_id, message_text, media_path, comment) VALUES (?, ?, ?, ?, ?)'
        ).run(String(chatId), messageId, messageText || '', mediaPath || '', comment || '');
        
        const row = db.prepare('SELECT * FROM saved_messages WHERE id = ?').get(info.lastInsertRowid);
        res.json(row);
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Видалити збережене повідомлення
router.delete('/saved/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM saved_messages WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Отримати всі коментарі до чатів
router.get('/chat_notes', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM notes WHERE content != '' ORDER BY updated_at DESC").all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
