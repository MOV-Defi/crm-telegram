const fs = require('fs');
const path = require('path');

// Для сервера дані краще зберігати в папці data/ в корені проєкту
const dataRoot = path.resolve(process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data'));

// Центральна БД для користувачів/логінів
const centralDbPath = path.join(dataRoot, 'central.db');

const ensureDir = (targetPath) => {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
};

ensureDir(dataRoot);

// Завантаження (аватарки, медіа) робимо спільними для всіх тенантів,
// щоб express.static міг легко їх віддавати. Унікальність файлів забезпечується рандомом в іменах.
const uploadsDir = path.join(dataRoot, 'uploads');
const avatarsDir = path.join(uploadsDir, 'avatars');
const mediaDir = path.join(uploadsDir, 'media');

ensureDir(uploadsDir);
ensureDir(avatarsDir);
ensureDir(mediaDir);

// Отримання шляхів для конкретного тенанта (користувача)
const getTenantDir = (userId) => {
  const tenantDir = path.join(dataRoot, `tenant_${userId}`);
  ensureDir(tenantDir);
  return tenantDir;
};

const getTenantDbPath = (userId) => {
  return path.join(getTenantDir(userId), 'crm.db');
};

const getTenantUploadsDir = (userId) => {
  // Повертаємо глобальну папку для сумісності
  return uploadsDir;
};

module.exports = {
  dataRoot,
  centralDbPath,
  getTenantDir,
  getTenantDbPath,
  getTenantUploadsDir,
  // Для старої сумісності (якщо десь напряму імпортується)
  uploadsDir,
  avatarsDir,
  mediaDir
};
