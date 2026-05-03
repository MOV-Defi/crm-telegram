const express = require('express');
const db = require('../db');
const { initTelegramClient } = require('../telegram');
const context = require('../context');
const runtimePaths = require('../runtime-paths');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const TELEGRAM_BOT_API = 'https://api.telegram.org';

const getDirectorySizeBytes = (dirPath) => {
    if (!fs.existsSync(dirPath)) return 0;
    const stack = [dirPath];
    let total = 0;
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile()) {
                total += fs.statSync(fullPath).size;
            }
        }
    }
    return total;
};

const clearDirectoryContents = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
        if (entry.name === '.gitkeep') continue;
        const fullPath = path.join(dirPath, entry.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed += 1;
    }
    const gitkeepPath = path.join(dirPath, '.gitkeep');
    if (!fs.existsSync(gitkeepPath)) fs.writeFileSync(gitkeepPath, '');
    return removed;
};

router.get('/telegram', (req, res) => {
    try {
        const idRow = db.prepare("SELECT value FROM settings WHERE key = 'api_id'").get();
        const hashRow = db.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get();
        res.json({ 
            configured: !!(idRow && hashRow),
            apiId: idRow ? idRow.value : req.app.locals.API_ID || '',
            apiHash: hashRow ? hashRow.value.substring(0, 4) + '...' + hashRow.value.substring(hashRow.value.length - 4) : ''
        });
    } catch (e) {
        console.error('settings/telegram POST error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/telegram', async (req, res) => {
    const apiIdInput = String(req.body?.apiId || '').trim();
    const apiHashInput = String(req.body?.apiHash || '').trim();

    try {
        const currentIdRow = db.prepare("SELECT value FROM settings WHERE key = 'api_id'").get();
        const currentHashRow = db.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get();
        
        let finalApiId = apiIdInput || String(currentIdRow?.value || '').trim();
        let finalApiHash = apiHashInput || String(currentHashRow?.value || '').trim();

        // Захист: якщо прийшов маскований хеш (з крапками), не перезаписуємо ним існуючий
        if (apiHashInput.includes('...')) {
            finalApiHash = String(currentHashRow?.value || '').trim();
        }

        if (!finalApiId || !finalApiHash) {
            return res.status(400).json({ error: "Введіть API ID та API HASH" });
        }

        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('api_id', finalApiId);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('api_hash', finalApiHash);

        // Update locals
        req.app.locals.API_ID = finalApiId;
        req.app.locals.API_HASH = finalApiHash;

        // Re-init client in the current user's tenant context
        await new Promise((resolve, reject) => {
            context.runWithContext({ userId: req.userId }, async () => {
                try {
                    await initTelegramClient(req.app.locals.API_ID, req.app.locals.API_HASH);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        
        res.json({ success: true, message: "Налаштування збережено" });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/logout', async (req, res) => {
    try {
        const { disconnectTelegramClient } = require('../telegram');
        await disconnectTelegramClient();
        res.json({ success: true, message: "Ви вийшли з Telegram" });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/session/clear', async (req, res) => {
    try {
        const { logoutTelegramClient } = require('../telegram');
        await logoutTelegramClient();

        // Очищаємо всі локальні дані старого акаунта
        db.prepare("DELETE FROM tags").run();
        db.prepare("DELETE FROM chat_tags").run();
        db.prepare("DELETE FROM notes").run();
        db.prepare("DELETE FROM local_pins").run();
        db.prepare("DELETE FROM message_media").run();
        db.prepare("DELETE FROM avatars").run();
        db.prepare("DELETE FROM campaigns").run();
        db.prepare("DELETE FROM campaign_logs").run();
        db.prepare("DELETE FROM ignored_chats").run();
        db.prepare("DELETE FROM saved_messages").run();
        db.prepare("UPDATE request_templates SET target_chat_id = NULL, target_chat_name = NULL").run();

        clearDirectoryContents(runtimePaths.mediaDir);
        clearDirectoryContents(runtimePaths.avatarsDir);

        res.json({ success: true, message: "Сесію очищено" });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/storage', (req, res) => {
    try {
        const mediaDir = runtimePaths.mediaDir;
        const avatarsDir = runtimePaths.avatarsDir;
        const mediaBytes = getDirectorySizeBytes(mediaDir);
        const avatarsBytes = getDirectorySizeBytes(avatarsDir);
        res.json({
            mediaBytes,
            avatarsBytes,
            totalBytes: mediaBytes + avatarsBytes
        });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/storage/clear-media', (req, res) => {
    try {
        const removedMedia = clearDirectoryContents(runtimePaths.mediaDir);
        const removedAvatars = clearDirectoryContents(runtimePaths.avatarsDir);
        res.json({ success: true, removedMedia, removedAvatars });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/bot', (req, res) => {
    try {
        const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_token'").get();
        const chatIdRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_chat_id'").get();
        const enabledRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_enabled'").get();
        res.json({
            enabled: String(enabledRow?.value || '0') === '1',
            hasToken: !!String(tokenRow?.value || '').trim(),
            chatId: String(chatIdRow?.value || '').trim()
        });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/bot', (req, res) => {
    try {
        const tokenInput = String(req.body?.token || '').trim();
        const chatIdInput = String(req.body?.chatId || '').trim();
        const enabled = req.body?.enabled ? 1 : 0;

        const currentTokenRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_token'").get();
        const finalToken = tokenInput || String(currentTokenRow?.value || '').trim();
        if (!finalToken || !chatIdInput) {
            return res.status(400).json({ error: 'Вкажіть Bot Token та Chat ID' });
        }

        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('bot_token', finalToken);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('bot_chat_id', chatIdInput);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('bot_enabled', String(enabled));

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/bot/test', async (req, res) => {
    try {
        const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_token'").get();
        const chatIdRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_chat_id'").get();
        const token = String(tokenRow?.value || '').trim();
        const chatId = String(chatIdRow?.value || '').trim();
        if (!token || !chatId) return res.status(400).json({ error: 'Bot не налаштований' });

        const text = String(req.body?.text || 'Тестове повідомлення від CRM бота').trim();
        const r = await fetch(`${TELEGRAM_BOT_API}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data?.ok) {
            return res.status(400).json({ error: data?.description || 'Не вдалося надіслати тестове повідомлення' });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/bot/send', async (req, res) => {
    try {
        const enabledRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_enabled'").get();
        const enabled = String(enabledRow?.value || '0') === '1';
        if (!enabled) return res.status(400).json({ error: 'Bot вимкнено' });

        const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_token'").get();
        const chatIdRow = db.prepare("SELECT value FROM settings WHERE key = 'bot_chat_id'").get();
        const token = String(tokenRow?.value || '').trim();
        const chatId = String(chatIdRow?.value || '').trim();
        if (!token || !chatId) return res.status(400).json({ error: 'Bot не налаштований' });

        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Порожнє повідомлення' });

        const r = await fetch(`${TELEGRAM_BOT_API}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data?.ok) {
            return res.status(400).json({ error: data?.description || 'Не вдалося надіслати повідомлення' });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
