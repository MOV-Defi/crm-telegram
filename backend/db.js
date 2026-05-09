const Database = require('better-sqlite3');
const runtimePaths = require('./runtime-paths');
const context = require('./context');

const centralDb = new Database(runtimePaths.centralDbPath);
centralDb.pragma('journal_mode = WAL');

const isReadonlyDbError = (error) => (
  String(error?.code || '').toUpperCase() === 'SQLITE_READONLY' ||
  /readonly/i.test(String(error?.message || ''))
);

const safeDbWrite = (dbInstance, operationName, fn) => {
  try {
    return fn();
  } catch (error) {
    if (isReadonlyDbError(error)) {
      console.warn(`[db] Skip write operation "${operationName}" because database is readonly.`);
      return null;
    }
    throw error;
  }
};

centralDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS request_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    target_chat_id TEXT,
    target_chat_name TEXT,
    body_template TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS document_template_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS document_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_url TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES document_template_categories(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL,
    permission_key TEXT NOT NULL,
    is_allowed INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, permission_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS warehouse_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    chat_name TEXT,
    message_id INTEGER,
    message_text TEXT,
    media_path TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_by_user_id INTEGER,
    created_by_username TEXT,
    assigned_to_user_id INTEGER,
    assigned_to_username TEXT,
    status_updated_at DATETIME,
    status_updated_by_user_id INTEGER,
    status_updated_by_username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const ensureUsersRoleColumn = () => {
  const columns = centralDb.prepare(`PRAGMA table_info(users)`).all();
  const hasRole = columns.some((column) => column.name === 'role');
  if (!hasRole) {
    centralDb.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  }
};

ensureUsersRoleColumn();

const ensureCentralColumn = (tableName, columnName, definition) => {
  const columns = centralDb.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    safeDbWrite(centralDb, `ALTER TABLE ${tableName} ADD COLUMN ${columnName}`, () => {
      centralDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    });
  }
};

ensureCentralColumn('warehouse_orders', 'project_name', 'TEXT');
ensureCentralColumn('warehouse_orders', 'requester_name', 'TEXT');
ensureCentralColumn('warehouse_orders', 'media_name', 'TEXT');
ensureCentralColumn('warehouse_orders', 'request_type', "TEXT NOT NULL DEFAULT 'issuance'");
safeDbWrite(centralDb, "migrate warehouse_orders reserved->new with request_type", () => {
  centralDb.exec(`
    UPDATE warehouse_orders
    SET request_type = 'reservation'
    WHERE status = 'reserved' AND (request_type IS NULL OR TRIM(request_type) = '');
    UPDATE warehouse_orders
    SET status = 'new'
    WHERE status = 'reserved';
    UPDATE warehouse_orders
    SET request_type = 'issuance'
    WHERE request_type IS NULL OR TRIM(request_type) = '';
  `);
});

const setupCentralDb = () => {
  const ensureRequestTemplate = ({ code, title, description, bodyTemplate, fieldsJson }) => {
    const existing = centralDb.prepare('SELECT id FROM request_templates WHERE code = ?').get(code);
    if (!existing) {
      safeDbWrite(centralDb, `INSERT request_template:${code}`, () => centralDb.prepare(`
        INSERT INTO request_templates
        (code, title, description, target_chat_id, target_chat_name, body_template, fields_json, is_active)
        VALUES (?, ?, ?, NULL, NULL, ?, ?, 1)
      `).run(code, title, description, bodyTemplate, fieldsJson));
    } else {
      safeDbWrite(centralDb, `UPDATE request_template:${code}`, () => centralDb.prepare(`
        UPDATE request_templates
        SET title = ?, description = ?, body_template = ?, fields_json = ?, is_active = 1
        WHERE code = ?
      `).run(title, description, bodyTemplate, fieldsJson, code));
    }
  };

  // Default templates moved here...
};

setupCentralDb();

const tenantDatabases = new Map();

const getTenantDb = () => {
    const userId = context.getUserId();
    if (!userId) {
        const stack = new Error().stack;
        const errorMsg = `[${new Date().toISOString()}] Database access outside of user context! Stack:\n${stack}\n\n`;
        require('fs').appendFileSync(require('path').join(__dirname, 'error.log'), errorMsg);
        console.error(errorMsg);
        throw new Error('Database access outside of user context (SaaS isolation error)');
    }
    
    if (!tenantDatabases.has(userId)) {
        const dbPath = runtimePaths.getTenantDbPath(userId);
        const dbInstance = new Database(dbPath);
        dbInstance.pragma('journal_mode = WAL');
        setupTenantDb(dbInstance);
        tenantDatabases.set(userId, dbInstance);
    }
    return tenantDatabases.get(userId);
};

const dbProxy = new Proxy({}, {
    get(target, prop) {
        // Expose centralDb for specific auth queries if needed, 
        // but normally centralDb is imported directly or we add a property.
        if (prop === 'central') return centralDb;
        
        const db = getTenantDb();
        const val = db[prop];
        if (typeof val === 'function') {
            return val.bind(db);
        }
        return val;
    }
});

const setupTenantDb = (dbInstance) => {
const initDb = () => {
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS avatars (
      entity_id TEXT PRIMARY KEY,
      avatar_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_media (
      message_id INTEGER,
      peer_id TEXT,
      media_path TEXT NOT NULL,
      PRIMARY KEY (message_id, peer_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_tags (
      chat_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, tag_id),
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notes (
      chat_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS local_pins (
      folder_id TEXT,
      chat_id TEXT,
      pinned_at INTEGER,
      PRIMARY KEY (folder_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT CHECK(status IN ('pending', 'running', 'paused', 'completed', 'failed')) DEFAULT 'pending',
      total_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaign_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      chat_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('delivered', 'error')),
      error_message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ignored_chats (
      chat_id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS saved_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      message_text TEXT,
      media_path TEXT,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );



    CREATE TABLE IF NOT EXISTS logistics_warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      address TEXT,
      work_schedule TEXT,
      geo_link TEXT,
      contact_person TEXT,
      contact_phone TEXT,
      loading_type TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS logistics_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      recipient_type TEXT,
      address TEXT,
      contact_person TEXT,
      contact_phone TEXT,
      delivery_time_note TEXT,
      unloading_type TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS logistics_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_manager_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS purchase_address_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS tk_manager_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS tk_recipient_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      details TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS local_chat_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS local_chat_group_items (
      group_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      chat_name TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, chat_id),
      FOREIGN KEY (group_id) REFERENCES local_chat_groups(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_managers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_name TEXT NOT NULL,
      manager_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      telegram_contact TEXT,
      responsibility TEXT,
      notes TEXT,
      linked_chat_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT CHECK(status IN ('pending', 'running', 'paused', 'completed', 'failed')) DEFAULT 'pending',
      total_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

initDb();

const ensureColumn = (tableName, columnName, definition) => {
  const columns = dbInstance.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    safeDbWrite(dbInstance, `ALTER TABLE ${tableName} ADD COLUMN ${columnName}`, () => {
      dbInstance.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    });
  }
};

ensureColumn('notes', 'anchor_message_id', 'INTEGER');
ensureColumn('message_media', 'media_name', 'TEXT');
ensureColumn('local_chat_group_items', 'chat_name', 'TEXT');

const seedLocalChatGroups = () => {
  const defaults = [
    { name: 'Основні', color: '#3b82f6' },
    { name: 'Фінанси', color: '#22c55e' },
    { name: 'Склад', color: '#f59e0b' },
    { name: 'Закупки', color: '#ec4899' }
  ];

  // Міграція зі старої системної назви.
  safeDbWrite(dbInstance, 'migrate local_chat_groups:Основні групи -> Основні', () => {
    const hasMain = dbInstance.prepare('SELECT id FROM local_chat_groups WHERE lower(name) = lower(?) LIMIT 1').get('Основні');
    if (hasMain) return;
    dbInstance.prepare('UPDATE local_chat_groups SET name = ? WHERE lower(name) = lower(?)')
      .run('Основні', 'Основні групи');
  });

  defaults.forEach((item, index) => {
    safeDbWrite(dbInstance, `seed local_chat_groups:${item.name}`, () => {
      const existing = dbInstance.prepare(`
        SELECT id, color
        FROM local_chat_groups
        WHERE lower(name) = lower(?)
        LIMIT 1
      `).get(item.name);

      if (existing) {
        dbInstance.prepare(`
          UPDATE local_chat_groups
          SET sort_order = ?, is_system = 1, color = COALESCE(NULLIF(color, ''), ?)
          WHERE id = ?
        `).run(index, item.color, existing.id);
        return;
      }

      dbInstance.prepare(`
        INSERT INTO local_chat_groups (name, color, sort_order, is_system)
        VALUES (?, ?, ?, 1)
      `).run(item.name, item.color, index);
    });
  });
};

const seedTemplates = () => {
  const centralSetup = (args) => {
    const existing = centralDb.prepare('SELECT id FROM request_templates WHERE code = ?').get(args.code);
    if (!existing) {
      centralDb.prepare(`
        INSERT INTO request_templates
        (code, title, description, target_chat_id, target_chat_name, body_template, fields_json, is_active)
        VALUES (?, ?, ?, NULL, NULL, ?, ?, 1)
      `).run(args.code, args.title, args.description, args.bodyTemplate, args.fieldsJson);
    } else {
      centralDb.prepare(`
        UPDATE request_templates
        SET title = ?, description = ?, body_template = ?, fields_json = ?, is_active = 1
        WHERE code = ?
      `).run(args.title, args.description, args.bodyTemplate, args.fieldsJson, args.code);
    }
  };
  const ensureRequestTemplate = centralSetup;

  centralSetup({
  code: 'payment_request',
  title: 'Заявка на оплату',
  description: 'Текстова заявка для відправки в чат оплат.',
  bodyTemplate: `Дата заявки: {{request_date}}

🚵Проект Менеджер: {{project_manager}}
🔸 🏣 Об'єкт: {{project_name}}
Адреса: {{address}}

📍🔍 Сума: {{amount}}
💵 валюта: {{currency}}

🧩Підрядник/Постачальник: {{contractor}}

⚒️Призначення: {{purpose}}

✅очікувана дата видачі та отримувач:
{{expected_delivery}}`,
  fieldsJson: JSON.stringify([
    { key: 'request_date', label: 'Дата заявки', type: 'text', required: true, placeholder: '09.04' },
    { key: 'project_manager', label: 'Проект Менеджер', type: 'text', required: true, placeholder: 'ПІБ менеджера' },
    { key: 'project_name', label: "Об'єкт", type: 'text', required: true, placeholder: 'всі об’єкти Солара' },
    { key: 'address', label: 'Адреса', type: 'text', required: false, placeholder: 'Вкажіть адресу або залиште порожнім' },
    { key: 'amount', label: 'Сума', type: 'text', required: true, placeholder: '33645 грн' },
    { key: 'currency', label: 'Валюта', type: 'text', required: true, placeholder: 'грн.' },
    { key: 'contractor', label: 'Підрядник/Постачальник', type: 'text', required: true, placeholder: 'ПІБ постачальника' },
    { key: 'purpose', label: 'Призначення', type: 'textarea', required: true, placeholder: 'Оплата замовлення...' },
    { key: 'expected_delivery', label: 'Очікувана дата видачі та отримувач', type: 'textarea', required: true, placeholder: 'середа, 10.04. ПІБ постачальника' }
  ])
});

ensureRequestTemplate({
  code: 'purchase_request',
  title: 'Заявка на закупки',
  description: 'Заявка на матеріали за шаблоном Excel з автопідстановкою списку позицій.',
  bodyTemplate: `Доброго дня. Прошу обробити заявку на закупку.

Дата: {{request_date}}
Проект: {{project_name}}
Менеджер: {{manager_name}}

{{items_list}}

Реквізити: {{requisites}}
Форма оплати: {{payment_form}}
Терміни: {{terms}}
Адреса доставки: {{delivery_address}}
Оплата доставки: {{delivery_payment}}
Додатковий коментар: {{additional_comment}}`,
  fieldsJson: JSON.stringify([
    { key: 'request_date', label: 'Дата заявки', type: 'text', required: true, placeholder: '14.04.2026' },
    { key: 'project_name', label: 'Проект', type: 'text', required: true, placeholder: 'Назва проекту' },
    { key: 'manager_name', label: 'Менеджер', type: 'text', required: true, placeholder: 'ПІБ менеджера' },
    {
      key: 'items_list',
      label: 'Список товарів',
      type: 'textarea',
      required: true,
      placeholder: 'Вставте позиції вручну або через блок "Вставка з Excel" вище'
    },
    {
      key: 'selected_mentions',
      label: 'Кого відмітити в повідомленні',
      type: 'multi_contact_mentions',
      required: false,
      defaultMentions: [],
      helpText: 'Вибери людей з учасників обраного чату, щоб додати згадки перед повідомленням.'
    },
    {
      key: 'purchase_chat_message',
      label: 'Текст повідомлення в чат',
      type: 'textarea',
      required: false,
      placeholder: 'Короткий супровідний текст перед DOCX'
    },
    { key: 'requisites', label: 'Реквізити', type: 'textarea', required: false, placeholder: 'Реквізити для оплати' },
    {
      key: 'payment_form',
      label: 'Форма оплати',
      type: 'select',
      required: true,
      defaultValue: 'pdv',
      options: [
        { value: 'pdv', label: 'ПДВ' },
        { value: 'fop', label: 'ФОП' },
        { value: 'cash', label: 'Готівка' },
        { value: 'other', label: 'Інше' }
      ]
    },
    {
      key: 'payment_form_other',
      label: 'Форма оплати: інше',
      type: 'text',
      required: false,
      placeholder: 'Вкажіть інший варіант',
      visibleWhen: { field: 'payment_form', equals: 'other' }
    },
    { key: 'terms', label: 'Терміни', type: 'text', required: false, placeholder: 'Бажані терміни' },
    { key: 'delivery_address', label: 'Адреса доставки', type: 'textarea', required: false, placeholder: 'Місто, вулиця, №' },
    {
      key: 'delivery_payment',
      label: 'Оплата доставки',
      type: 'select',
      required: true,
      defaultValue: 'cashless',
      options: [
        { value: 'cashless', label: 'Безнал' },
        { value: 'cash', label: 'Готівка' },
        { value: 'other', label: 'Інше' }
      ]
    },
    { key: 'additional_comment', label: 'Додатковий коментар', type: 'textarea', required: false, placeholder: 'Уточнення до заявки' }
  ])
});

ensureRequestTemplate({
  code: 'tk_delivery_request',
  title: 'Доставка ТК',
  description: 'Заявка на доставку через ТК з вибором чату, відмітками людей і вкладенням файлу.',
  bodyTemplate: `Доброго дня.

Заявка на доставку ТК

Проєкт: {{project_name}}
Менеджер: {{manager_name}}

Отримувач:
{{recipient_details}}

Транспортна компанія: {{tk_company}}
Коли відправити (днів): {{dispatch_deadline_days}}
Спосіб оплати: {{payment_method}}
Платник доставки: {{delivery_payer}}
Сума страховки: {{insurance_amount}}

Опис вантажу:
{{cargo_description}}
Коментар: {{additional_comment}}

Дякую.`,
  fieldsJson: JSON.stringify([
    {
      key: 'selected_mentions',
      label: 'Кого відмітити в повідомленні',
      type: 'multi_contact_mentions',
      required: false,
      defaultMentions: [],
      helpText: 'Вибери людей з учасників обраного чату, щоб автоматично додати згадки.'
    },
    {
      key: 'tk_chat_message',
      label: 'Супровідний текст в чат',
      type: 'textarea',
      required: false,
      placeholder: 'Короткий коментар перед заявкою'
    },
    { key: 'project_name', label: 'Проєкт', type: 'text', required: true, placeholder: 'Назва проєкту' },
    { key: 'manager_name', label: 'Менеджер', type: 'text', required: true, placeholder: 'ПІБ' },
    {
      key: 'recipient_details',
      label: 'Отримувач',
      type: 'textarea',
      required: true,
      placeholder: 'НІКОІНТЕРМ ПВНП\nКод ЄДРПОУ 32508277\nАдресна доставка: м. Київ, вул. Соломянська, 17.\n0 (67) 468 65 01\nОлексій Мазепа'
    },
    {
      key: 'tk_company',
      label: 'Обрати ТК',
      type: 'select',
      required: true,
      defaultValue: 'Нова Пошта',
      options: [
        { value: 'Нова Пошта', label: 'Нова Пошта' },
        { value: 'SAT', label: 'SAT' },
        { value: 'Автолюкс', label: 'Автолюкс' },
        { value: 'Інші', label: 'Інші' }
      ]
    },
    { key: 'dispatch_deadline_days', label: 'Дата відправки', type: 'text', required: true, placeholder: 'відправка 1-2 дні' },
    {
      key: 'payment_method',
      label: 'Спосіб оплати',
      type: 'select',
      required: true,
      defaultValue: 'Нал',
      options: [
        { value: 'Нал', label: 'Нал' },
        { value: 'Безготівка', label: 'Безготівка' }
      ]
    },
    {
      key: 'delivery_payer',
      label: 'Хто платник доставки',
      type: 'select',
      required: true,
      defaultValue: 'Ми',
      options: [
        { value: 'Ми', label: 'Ми' },
        { value: 'Отримувач', label: 'Отримувач' }
      ]
    },
    { key: 'insurance_amount', label: 'Сума страховки', type: 'text', required: false, placeholder: '0' },
    { key: 'cargo_description', label: 'Опис вантажу', type: 'textarea', required: true, placeholder: 'Що саме їде' },
    { key: 'additional_comment', label: 'Додатковий коментар', type: 'textarea', required: false, placeholder: 'Додаткові умови, документи, оплата' }
  ])
});

ensureRequestTemplate({
  code: 'warehouse_issue_request',
  title: 'Видача склад',
  description: 'Заявка для складу з відмітками людей, режимом броні або видачі і стандартною групою відправки.',
  bodyTemplate: `{{mentions_line}}

Доброго дня. Прошу зібрати товар:
"{{items_list}}"

{{mode_block}}
{{comment_block}}
Дякую.`,
  fieldsJson: JSON.stringify([
    {
      key: 'selected_mentions',
      label: 'Кого відмітити',
      type: 'multi_contact_mentions',
      required: false,
      defaultMentions: [],
      helpText: 'Можна вибрати учасників чату для автоматичних відміток у повідомленні.'
    },
    {
      key: 'items_list',
      label: 'Товар і кількість',
      type: 'textarea',
      required: true,
      placeholder: 'Кабель - 10 шт\nІнвертор - 2 шт'
    },
    {
      key: 'request_mode',
      label: 'Режим',
      type: 'select',
      required: true,
      defaultValue: 'reservation',
      options: [
        { value: 'reservation', label: 'Бронь' },
        { value: 'issuance', label: 'Видача' }
      ]
    },
    {
      key: 'project_name',
      label: 'Проєкт',
      type: 'text',
      required: false,
      placeholder: 'Назва проєкту',
      visibleWhen: { field: 'request_mode', equals: 'reservation' }
    },
    {
      key: 'issue_recipient_type',
      label: 'Видача на',
      type: 'select',
      required: false,
      defaultValue: 'end_customer',
      visibleWhen: { field: 'request_mode', equals: 'issuance' },
      options: [
        { value: 'end_customer', label: 'Кінцевий споживач' },
        { value: 'contractor', label: 'Підрядник' }
      ]
    },
    {
      key: 'issue_recipient_name',
      label: 'Хто саме',
      type: 'text',
      required: false,
      placeholder: 'Вкажіть назву підрядника або ім’я клієнта',
      visibleWhen: { field: 'request_mode', equals: 'issuance' }
    },
    {
      key: 'additional_comment',
      label: 'Додатковий коментар',
      type: 'textarea',
      required: false,
      placeholder: 'За потреби додайте уточнення'
    }
  ])
});

ensureRequestTemplate({
  code: 'logistics_request',
  title: 'Логістика',
  description: 'Повний шаблон заявки на логістику з форматом як у DOCX, ручним вводом та збереженням шаблонів.',
  bodyTemplate: `Доброго дня. Прошу організувати логістику по заявці.

Форма заявки на замовлення транспорту для доставки вантажу

1. Загальна інформація
• Дата подачі заявки: {{submission_date}}
• Хто подає заявку (ПІБ / підрозділ): {{requester_name_division}}
• Контактний номер телефону: {{requester_phone}}

2. Інформація про вантаж
• Тип вантажу: {{cargo_type}}
• Кількість місць / упаковок: {{cargo_packages}}
• Орієнтовна вага (кг): {{cargo_weight_kg}}
• Габарити (Д×Ш×В, см): {{cargo_dimensions}}
• Детальний опис / специфікація: {{cargo_detailed_description}}
• Довжина найбільшої деталі: {{longest_part_length}}
• Чи потребує вантаж спец. умов перевезення (додаткові кріплення тощо)?
  {{special_conditions_no_line}}
  {{special_conditions_yes_line}}

3. Форма оплати за доставку
• безготівка з ПДВ/готівка: {{payment_form}}
• На яку юр особу виставляти рахунок (в разі оплати БГ): {{invoice_legal_entity}}
• Оформлення документів для оплати за надання послуг: {{payment_docs_note}}

4. Адреса завантаження, точка відправлення
• Назва об'єкта / організації: {{pickup_object_name}}
• Графік роботи: {{pickup_work_schedule}}
• Адреса: {{pickup_address}}
• Геолокація: {{pickup_geolocation}}
• Контактна особа на місці: {{pickup_contact_person}}
• Телефон для зв’язку: {{pickup_contact_phone}}
• Час готовності вантажу до завантаження: {{pickup_ready_time}}
• Яким чином можуть зробити завантаження: {{pickup_loading_method}}

5. Адреса розвантаження, точка доставки
• Назва об'єкта / організації: {{delivery_object_name}}
• Адреса (місто, вулиця, №): {{delivery_address}}
• Контактна особа на місці прийому: {{delivery_contact_person}}
• Телефон для зв’язку: {{delivery_contact_phone}}
• Бажаний час доставки: {{delivery_desired_time}}
• Яким чином можуть зробити розвантаження: {{delivery_unloading_method}}

6. Додаткові умови
• Потреба у завантаженні/розвантаженні вантажниками:
  {{need_loaders_yes_line}}
  {{need_loaders_no_line}}
• Потреба у зворотній доставці документів:
  {{need_return_docs_yes_line}}
  {{need_return_docs_no_line}}
• Інші важливі примітки / інструкції для логіста або водія:
  {{additional_notes}}

7. Пріоритет заявки
• {{priority_standard_line}}
• {{priority_urgent_line}}
• {{priority_other_line}}

{{driver_waybill_note}}

Дякую.`,
  fieldsJson: JSON.stringify([
    { key: 'submission_date', label: 'Дата подачі заявки', type: 'text', required: true, placeholder: '09.04.2026' },
    { key: 'requester_name_division', label: 'Хто подає заявку (ПІБ / підрозділ)', type: 'text', required: true, placeholder: 'ПІБ та підрозділ' },
    { key: 'requester_phone', label: 'Контактний номер телефону', type: 'text', required: true, placeholder: 'контактний номер' },
    { key: 'cargo_type', label: 'Тип вантажу', type: 'text', required: true, placeholder: 'Сонячні панелі 24шт.' },
    { key: 'cargo_packages', label: 'Кількість місць / упаковок', type: 'text', required: true, placeholder: '1 палет' },
    { key: 'cargo_weight_kg', label: 'Орієнтовна вага (кг)', type: 'text', required: true, placeholder: '900 кг.' },
    { key: 'cargo_dimensions', label: 'Габарити (Д×Ш×В, см)', type: 'text', required: true, placeholder: '2400×1200×720' },
    { key: 'cargo_detailed_description', label: 'Детальний опис / специфікація', type: 'textarea', required: false, placeholder: 'За потреби додай уточнення по місцях, маркуванню або встав опис зі специфікації.' },
    { key: 'longest_part_length', label: 'Довжина найбільшої деталі', type: 'text', required: true, placeholder: '2,4 м.' },
    {
      key: 'special_conditions_required',
      label: 'Спец. умови перевезення',
      type: 'select',
      required: true,
      defaultValue: 'no',
      options: [
        { value: 'no', label: 'Ні' },
        { value: 'yes', label: 'Так' }
      ]
    },
    { key: 'special_conditions_note', label: 'Уточнення спец. умов', type: 'text', required: false, placeholder: 'Додаткові кріплення...' },
    {
      key: 'payment_form',
      label: 'безготівка з ПДВ/готівка',
      type: 'select',
      required: true,
      defaultValue: 'cash',
      options: [
        { value: 'cash', label: 'Готівка' },
        { value: 'cashless_vat', label: 'Безготівка з ПДВ' },
        { value: 'other', label: 'Інше' }
      ]
    },
    { key: 'payment_form_other', label: 'Форма оплати: інше', type: 'text', required: false, placeholder: 'Вкажіть інший варіант' },
    { key: 'invoice_legal_entity', label: 'На яку юр особу виставляти рахунок', type: 'text', required: false, placeholder: '' },
    { key: 'payment_docs_note', label: 'Оформлення документів для оплати', type: 'text', required: false, placeholder: '' },
    {
      key: 'selected_mentions',
      label: 'Кого відмітити в повідомленні',
      type: 'multi_contact_mentions',
      required: false,
      defaultMentions: [],
      helpText: 'Вибери людей з учасників обраного чату, щоб додати згадки в текстове повідомлення.'
    },
    {
      key: 'logistics_chat_message',
      label: 'Текст повідомлення в чат',
      type: 'textarea',
      required: false,
      placeholder: 'Короткий супровідний текст до заявки...'
    },
    { key: 'pickup_template_id', label: 'Шаблон складу відправлення', type: 'logistics_warehouse', required: false },
    { key: 'pickup_object_name', label: "Назва об'єкта / організації (відправлення)", type: 'text', required: true, placeholder: 'Назва складу' },
    { key: 'pickup_work_schedule', label: 'Графік роботи (відправлення)', type: 'text', required: false, placeholder: '9:00-18:00' },
    { key: 'pickup_address', label: 'Адреса (відправлення)', type: 'text', required: true, placeholder: 'вулиця ...' },
    { key: 'pickup_geolocation', label: 'Геолокація (відправлення)', type: 'text', required: false, placeholder: 'https://maps...' },
    { key: 'pickup_contact_person', label: 'Контактна особа (відправлення)', type: 'text', required: false, placeholder: 'Контактна особа' },
    { key: 'pickup_contact_phone', label: "Телефон для зв'язку (відправлення)", type: 'text', required: false, placeholder: '+380...' },
    { key: 'pickup_ready_time', label: 'Час готовності вантажу до завантаження', type: 'text', required: false, placeholder: '10.04.2026 після 13:00' },
    { key: 'pickup_loading_method', label: 'Спосіб завантаження', type: 'text', required: false, placeholder: 'Бокове' },
    { key: 'delivery_template_id', label: 'Шаблон одержувача', type: 'logistics_recipient', required: false },
    { key: 'delivery_object_name', label: "Назва об'єкта / організації (доставка)", type: 'text', required: true, placeholder: "Назва об'єкта доставки" },
    { key: 'delivery_address', label: 'Адреса (доставка)', type: 'text', required: true, placeholder: 'місто, вулиця, №' },
    { key: 'delivery_contact_person', label: 'Контактна особа (доставка)', type: 'text', required: false, placeholder: 'Контактна особа' },
    { key: 'delivery_contact_phone', label: "Телефон для зв'язку (доставка)", type: 'text', required: false, placeholder: '+380...' },
    { key: 'delivery_desired_time', label: 'Бажаний час доставки', type: 'text', required: false, placeholder: 'Не принципово' },
    { key: 'delivery_unloading_method', label: 'Спосіб розвантаження', type: 'text', required: false, placeholder: '' },
    {
      key: 'need_loaders',
      label: 'Потрібні вантажники',
      type: 'select',
      required: true,
      defaultValue: 'no',
      options: [
        { value: 'yes', label: 'Так' },
        { value: 'no', label: 'Ні' }
      ]
    },
    {
      key: 'need_return_docs',
      label: 'Потрібна зворотня доставка документів',
      type: 'select',
      required: true,
      defaultValue: 'no',
      options: [
        { value: 'yes', label: 'Так' },
        { value: 'no', label: 'Ні' }
      ]
    },
    { key: 'additional_notes', label: 'Інші важливі примітки', type: 'textarea', required: false, placeholder: '' },
    {
      key: 'priority',
      label: 'Пріоритет',
      type: 'select',
      required: true,
      defaultValue: 'standard',
      options: [
        { value: 'standard', label: 'Стандартна доставка (3-4 дні)' },
        { value: 'urgent', label: 'Термінова доставка (1-2 дні)' },
        { value: 'other', label: 'Інше' }
      ]
    },
    { key: 'priority_other', label: 'Пріоритет: інше', type: 'text', required: false, placeholder: '' },
    { key: 'driver_waybill_note', label: 'Примітка / видаткова для водія', type: 'text', required: false, placeholder: 'Видаткова СПД...' }
  ])
  })
};

seedTemplates();

const ensureLogisticsWarehouse = (warehouse) => {
  const existing = dbInstance.prepare('SELECT id FROM logistics_warehouses WHERE name = ?').get(warehouse.name);
  if (!existing) {
    dbInstance.prepare(`
      INSERT INTO logistics_warehouses
      (name, address, work_schedule, geo_link, contact_person, contact_phone, loading_type, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      warehouse.name,
      warehouse.address || null,
      warehouse.workSchedule || null,
      warehouse.geoLink || null,
      warehouse.contactPerson || null,
      warehouse.contactPhone || null,
      warehouse.loadingType || null
    );
  }
};

const ensureLogisticsRecipient = (recipient) => {
  const existing = dbInstance.prepare('SELECT id FROM logistics_recipients WHERE name = ?').get(recipient.name);
  if (!existing) {
    dbInstance.prepare(`
      INSERT INTO logistics_recipients
      (name, recipient_type, address, contact_person, contact_phone, delivery_time_note, unloading_type, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      recipient.name,
      recipient.recipientType || null,
      recipient.address || null,
      recipient.contactPerson || null,
      recipient.contactPhone || null,
      recipient.deliveryTimeNote || null,
      recipient.unloadingType || null
    );
  }
};

const ensureLogisticsSetting = (key, value) => {
  const existing = dbInstance.prepare('SELECT value FROM logistics_settings WHERE key = ?').get(key);
  if (!existing) {
    dbInstance.prepare('INSERT INTO logistics_settings (key, value) VALUES (?, ?)').run(key, value);
  }
};

ensureLogisticsSetting('default_target_chat_id', '');
ensureLogisticsSetting('default_target_chat_name', '');


};

module.exports = dbProxy;
