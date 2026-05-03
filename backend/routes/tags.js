const express = require('express');
const db = require('../db');

const router = express.Router();

// Отримання всіх існуючих тегів
router.get('/', (req, res) => {
    try {
        const tags = db.prepare('SELECT * FROM tags').all();
        res.json(tags);
    } catch (error) {
        console.error('Помилка отримання тегів:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Отримання тегів, присвоєних конкретному чату/користувачу
router.get('/chat/:chatId', (req, res) => {
    try {
        const { chatId } = req.params;
        const tags = db.prepare(`
            SELECT t.* FROM tags t
            JOIN chat_tags ct ON t.id = ct.tag_id
            WHERE ct.chat_id = ?
        `).all(chatId);
        res.json(tags);
    } catch (error) {
        console.error(`Помилка отримання тегів для ${req.params.chatId}:`, error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Створення нового тегу
router.post('/', (req, res) => {
    const { name, color } = req.body;
    if (!name || !color) {
        return res.status(400).json({ error: `Поля name та color обов'язкові` });
    }
    
    try {
        const info = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color);
        res.json({ id: info.lastInsertRowid, name, color });
    } catch (error) {
        // Якщо порушено UNIQUE constraint або інше
        console.error('Помилка створення тегу:', error);
        res.status(400).json({ error: error.message });
    }
});

// Оновлення існуючого тегу (назва або колір)
router.put('/:id', (req, res) => {
    const { name, color } = req.body;
    if (!name || !color) {
        return res.status(400).json({ error: `Поля name та color обов'язкові` });
    }
    try {
        db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, req.params.id);
        res.json({ id: parseInt(req.params.id), name, color });
    } catch (error) {
        console.error('Помилка оновлення тегу:', error);
        res.status(400).json({ error: error.message });
    }
});

// Видалення існуючого тегу (каскадно видалить і призначення)
router.delete('/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Помилка видалення тегу:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Присвоїти тег чату/клієнту
router.post('/assign', (req, res) => {
    const { chatId, tagId } = req.body;
    if (!chatId || !tagId) {
        return res.status(400).json({ error: `Поля chatId та tagId обов'язкові` });
    }

    try {
        db.prepare('INSERT OR IGNORE INTO chat_tags (chat_id, tag_id) VALUES (?, ?)').run(chatId, tagId);
        res.json({ success: true, chatId, tagId });
    } catch (error) {
        console.error('Помилка присвоєння тегу:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Зняти тег з чату/клієнта
router.post('/remove', (req, res) => {
    const { chatId, tagId } = req.body;
    if (!chatId || !tagId) {
        return res.status(400).json({ error: `Поля chatId та tagId обов'язкові` });
    }

    try {
        db.prepare('DELETE FROM chat_tags WHERE chat_id = ? AND tag_id = ?').run(chatId, tagId);
        res.json({ success: true, chatId, tagId });
    } catch (error) {
        console.error('Помилка видалення тегу з чату:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Отримати всі чати, згруповані по тегам (або всі призначення)
router.get('/assignments', (req, res) => {
    try {
        const assignments = db.prepare('SELECT * FROM chat_tags').all();
        res.json(assignments);
    } catch (error) {
        console.error('Помилка отримання призначень тегів:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
