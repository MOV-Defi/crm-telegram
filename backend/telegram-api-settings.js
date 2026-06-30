const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('./db');
const runtimePaths = require('./runtime-paths');

const readFromCurrentTenant = () => {
  try {
    const apiId = String(db.prepare("SELECT value FROM settings WHERE key = 'api_id'").get()?.value || '').trim();
    const apiHash = String(db.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get()?.value || '').trim();
    return apiId && apiHash ? { apiId, apiHash, source: 'tenant' } : null;
  } catch (_) {
    return null;
  }
};

const readFromEnv = () => {
  const apiId = String(process.env.API_ID || '').trim();
  const apiHash = String(process.env.API_HASH || '').trim();
  return apiId && apiHash ? { apiId, apiHash, source: 'env' } : null;
};

const readFromTenantDb = (dbPath) => {
  let tenantDb = null;
  try {
    tenantDb = new Database(dbPath, { readonly: true });
    const apiId = String(tenantDb.prepare("SELECT value FROM settings WHERE key = 'api_id'").get()?.value || '').trim();
    const apiHash = String(tenantDb.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get()?.value || '').trim();
    return apiId && apiHash ? { apiId, apiHash, source: path.basename(path.dirname(dbPath)) } : null;
  } catch (_) {
    return null;
  } finally {
    try {
      if (tenantDb) tenantDb.close();
    } catch (_) {}
  }
};

const readFromConfiguredTenant = () => {
  let entries = [];
  try {
    entries = fs.readdirSync(runtimePaths.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^tenant_\d+$/.test(entry.name))
      .sort((a, b) => Number(a.name.replace('tenant_', '')) - Number(b.name.replace('tenant_', '')));
  } catch (_) {
    return null;
  }

  for (const entry of entries) {
    const found = readFromTenantDb(path.join(runtimePaths.dataRoot, entry.name, 'crm.db'));
    if (found) return found;
  }
  return null;
};

const getTelegramApiSettings = () => (
  readFromCurrentTenant()
  || readFromEnv()
  || readFromConfiguredTenant()
  || { apiId: '', apiHash: '', source: null }
);

const saveTelegramApiSettingsForCurrentTenant = (apiId, apiHash) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('api_id', String(apiId || '').trim());
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('api_hash', String(apiHash || '').trim());
};

const maskApiHash = (apiHash) => {
  const value = String(apiHash || '').trim();
  return value ? value.substring(0, 4) + '...' + value.substring(value.length - 4) : '';
};

module.exports = {
  getTelegramApiSettings,
  saveTelegramApiSettingsForCurrentTenant,
  maskApiHash
};
