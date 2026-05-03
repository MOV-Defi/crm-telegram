const express = require('express');
const db = require('../db');

const router = express.Router();

const TASKS_KEY = 'tasks_v2';
const TASK_REMINDER_SETTINGS_KEY = 'task_reminder_settings_v2';

router.get('/', (req, res) => {
  try {
    const tasksRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(TASKS_KEY);
    const reminderRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(TASK_REMINDER_SETTINGS_KEY);
    let tasks = [];
    let reminderSettings = { enabled: false, time: '09:00', lastSentDate: '' };
    try { tasks = tasksRow?.value ? JSON.parse(tasksRow.value) : []; } catch (_) {}
    try { reminderSettings = reminderRow?.value ? JSON.parse(reminderRow.value) : reminderSettings; } catch (_) {}
    res.json({ tasks, reminderSettings });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', (req, res) => {
  try {
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    const reminderSettings = req.body?.reminderSettings && typeof req.body.reminderSettings === 'object'
      ? req.body.reminderSettings
      : { enabled: false, time: '09:00', lastSentDate: '' };
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TASKS_KEY, JSON.stringify(tasks));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TASK_REMINDER_SETTINGS_KEY, JSON.stringify(reminderSettings));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
