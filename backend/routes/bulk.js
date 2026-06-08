const express = require('express');
const { getClient } = require('../telegram');
const db = require('../db');

const router = express.Router();

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Запуск нової кампанії масової розсилки
router.post('/send', async (req, res) => {
    const { message, targets, delaySeconds = 2 } = req.body;
    
    if (!message || !targets || !Array.isArray(targets) || targets.length === 0) {
        return res.status(400).json({ error: "Повідомлення та масив отримувачів (targets) обов'язкові" });
    }

    const client = getClient();
    if (!client || !client.connected) {
        return res.status(503).json({ error: 'Telegram клієнт не підключений' });
    }

    try {
        // Створюємо запис про кампанію в БД
        const info = db.prepare('INSERT INTO campaigns (status, total_count) VALUES (?, ?)').run('running', targets.length);
        const campaignId = info.lastInsertRowid;

        res.json({ success: true, campaignId, message: 'Кампанія успішно запущена' });

        // Асинхронно відправляємо повідомлення
        (async () => {
            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < targets.length; i++) {
                const targetId = targets[i];
                try {
                    // Відправка
                    await client.sendMessage(targetId, { message });
                    
                    // Логування успіху
                    db.prepare('INSERT INTO campaign_logs (campaign_id, chat_id, status) VALUES (?, ?, ?)').run(campaignId, targetId, 'delivered');
                    successCount++;
                } catch (error) {
                    console.error(`Помилка відправки для ${targetId}:`, error);
                    // Логування помилки
                    db.prepare('INSERT INTO campaign_logs (campaign_id, chat_id, status, error_message) VALUES (?, ?, ?, ?)').run(campaignId, targetId, 'error', error.message.substring(0, 255));
                    failCount++;
                }

                // Оновлюємо поточну статистику кампанії
                db.prepare('UPDATE campaigns SET success_count = ?, fail_count = ? WHERE id = ?').run(successCount, failCount, campaignId);
                
                // Затримка перед наступним повідомленням (тільки якщо це не останнє)
                if (i < targets.length - 1) {
                    await wait(delaySeconds * 1000);
                }
            }

            // Завершення кампанії
            db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run('completed', campaignId);
            console.log(`Campaign ${campaignId} finished. Success: ${successCount}, Failed: ${failCount}`);
        })();

    } catch (error) {
        console.error('Помилка запуску кампанії:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Отримання статусу кампаній
router.get('/status', (req, res) => {
    try {
        const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 10').all();
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Отримання логів конкретної кампанії
router.get('/:id/logs', (req, res) => {
    try {
        const logs = db.prepare('SELECT * FROM campaign_logs WHERE campaign_id = ?').all(req.params.id);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
