#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db');

const username = String(process.argv[2] || '').trim();
if (!username) {
  console.error('Usage: node scripts/make-admin.js <username>');
  process.exit(1);
}

try {
  const user = db.central.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }

  db.central.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', user.id);
  console.log(`User ${user.username} (id=${user.id}) is now admin.`);
} catch (error) {
  console.error('Failed to update role:', error.message);
  process.exit(1);
}
