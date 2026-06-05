const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_PROJECT_STAGE_TEMPLATES = [
  { name: 'Договір', tasks: ['Підготовка договору', 'Узгодження умов', 'Підписання договору'] },
  { name: 'Авансування', tasks: ['Виставлення рахунку', 'Контроль оплати', 'Підтвердження надходження'] },
  { name: 'Обстеження', tasks: ['Виїзд на обʼєкт', 'Заміри', 'Фотофіксація'] },
  { name: 'Проєктування специфікація', tasks: ['Підготовка ТЗ', 'Схема проєкту', 'Специфікація'] },
  { name: 'Закупки, постачання', tasks: ['Закупка панелей', 'Закупка інверторів', 'Закупка комплектуючих'] },
  { name: 'Логістика, спецтехніка', tasks: ['План доставки', 'Замовлення спецтехніки', 'Погодження вікна доставки'] },
  { name: 'Монтаж', tasks: ['Монтаж конструкцій', 'Монтаж основного обладнання', 'Фото-звіт по монтажу'] },
  { name: 'Підключення, навчання', tasks: ['Пусконалагоджувальні роботи', 'Тест системи', 'Навчання клієнта'] },
  { name: 'Виконавчі документи, Паспорт', tasks: ['Підготовка техпаспорту', 'Підготовка актів', 'Передача комплекту документів'] },
  { name: 'Перевиставлення рахунків', tasks: ['Фінальні рахунки', 'Контроль оплат', 'Фінальне закриття'] }
];

const PROJECT_FIELD_MAP = {
  number: 'number',
  title: 'title',
  clientName: 'client_name',
  type: 'project_type',
  powerKw: 'power_kw',
  owner: 'owner_name',
  status: 'status',
  planStart: 'plan_start',
  planEnd: 'plan_end',
  factStart: 'fact_start',
  factEnd: 'fact_end',
  delayReason: 'delay_reason',
  projectValue: 'project_value',
  projectValueCurrency: 'project_value_currency',
  budgetPlan: 'budget_plan',
  paidAmount: 'paid_amount',
  expensesFact: 'expenses_fact'
};

const STAGE_FIELD_MAP = {
  name: 'name',
  orderIndex: 'order_index',
  status: 'status',
  planStart: 'plan_start',
  planEnd: 'plan_end',
  factStart: 'fact_start',
  factEnd: 'fact_end',
  planDate: 'plan_date',
  factDate: 'fact_date',
  planNotes: 'plan_notes',
  factNotes: 'fact_notes',
  stageTasks: 'stage_tasks_json'
};

const getProjectFinanceEntries = (projectId) => (
  db.central.prepare(`
    SELECT id, project_id, entry_type, amount, currency, usd_rate, payment_date, note, created_by_user_id, created_at, updated_at
    FROM project_finance_entries
    WHERE project_id = ?
    ORDER BY COALESCE(payment_date, '') DESC, id DESC
  `).all(projectId).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    type: row.entry_type,
    amount: row.amount || '',
    currency: String(row.currency || 'UAH').toUpperCase() === 'USD' ? 'USD' : 'UAH',
    usdRate: row.usd_rate || '',
    paymentDate: row.payment_date || '',
    note: row.note || '',
    createdByUserId: row.created_by_user_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }))
);

const toProjectDto = (row, stages, members, financeEntries) => ({
  id: row.id,
  number: row.number || '',
  title: row.title || '',
  clientName: row.client_name || '',
  type: row.project_type || 'private',
  powerKw: row.power_kw || '',
  owner: row.owner_name || row.created_by_username || '',
  status: row.status || 'planning',
  planStart: row.plan_start || '',
  planEnd: row.plan_end || '',
  factStart: row.fact_start || '',
  factEnd: row.fact_end || '',
  delayReason: row.delay_reason || '',
  projectValue: row.project_value || '',
  projectValueCurrency: String(row.project_value_currency || 'UAH').toUpperCase() === 'USD' ? 'USD' : 'UAH',
  budgetPlan: row.budget_plan || '',
  paidAmount: row.paid_amount || '',
  expensesFact: row.expenses_fact || '',
  financeEntries: Array.isArray(financeEntries) ? financeEntries : [],
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
  stages: Array.isArray(stages) ? stages : [],
  members: Array.isArray(members) ? members : []
});

const getAccessibleProjectRow = (projectId, userId) => (
  db.central.prepare(`
    SELECT p.*, cu.username AS created_by_username
    FROM projects p
    LEFT JOIN users cu ON cu.id = p.created_by_user_id
    INNER JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ? AND pm.user_id = ?
    LIMIT 1
  `).get(projectId, userId)
);

const getProjectStages = (projectId) => (
  db.central.prepare(`
    SELECT id, name, order_index, status, plan_start, plan_end, fact_start, fact_end, plan_date, fact_date, plan_notes, fact_notes, stage_tasks_json, created_at, updated_at
    FROM project_stages
    WHERE project_id = ?
    ORDER BY order_index ASC, id ASC
  `).all(projectId).map((row) => ({
    stageTasks: (() => {
      try {
        const parsed = JSON.parse(String(row.stage_tasks_json || '[]'));
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    })(),
    id: row.id,
    name: row.name || '',
    orderIndex: Number(row.order_index || 0),
    status: row.status || 'pending',
    planStart: row.plan_start || '',
    planEnd: row.plan_end || '',
    factStart: row.fact_start || '',
    factEnd: row.fact_end || '',
    planDate: row.plan_date || '',
    factDate: row.fact_date || '',
    planNotes: row.plan_notes || '',
    factNotes: row.fact_notes || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  })).filter((stage) => String(stage.name || '').trim().toLowerCase() !== 'гарантія')
);

const getProjectMembers = (projectId) => (
  db.central.prepare(`
    SELECT pm.user_id, pm.added_by_user_id, pm.created_at, u.username, u.role
    FROM project_members pm
    INNER JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY lower(u.username) ASC
  `).all(projectId).map((row) => ({
    userId: row.user_id,
    username: row.username || '',
    role: row.role || 'user',
    addedByUserId: row.added_by_user_id,
    createdAt: row.created_at || null
  }))
);

const loadProjectForUser = (projectId, userId) => {
  const row = getAccessibleProjectRow(projectId, userId);
  if (!row) return null;
  return toProjectDto(row, getProjectStages(projectId), getProjectMembers(projectId), getProjectFinanceEntries(projectId));
};

router.get('/users', (req, res) => {
  try {
    const query = String(req.query?.q || '').trim();
    const rows = query
      ? db.central.prepare(`
          SELECT id, username, role
          FROM users
          WHERE lower(username) LIKE lower(?)
          ORDER BY lower(username) ASC
          LIMIT 50
        `).all(`%${query}%`)
      : db.central.prepare(`
          SELECT id, username, role
          FROM users
          ORDER BY lower(username) ASC
          LIMIT 50
        `).all();
    return res.json({
      users: rows.map((row) => ({
        id: row.id,
        username: row.username || '',
        role: row.role || 'user'
      }))
    });
  } catch (error) {
    console.error('projects users list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', (req, res) => {
  try {
    const rows = db.central.prepare(`
      SELECT DISTINCT p.*, cu.username AS created_by_username
      FROM projects p
      LEFT JOIN users cu ON cu.id = p.created_by_user_id
      INNER JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = ?
      ORDER BY p.updated_at DESC, p.id DESC
    `).all(req.userId);
    const projects = rows.map((row) => toProjectDto(row, getProjectStages(row.id), getProjectMembers(row.id), getProjectFinanceEntries(row.id)));
    return res.json({ projects });
  } catch (error) {
    console.error('projects list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


router.post('/', (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Назва проєкту обовʼязкова' });

    const now = new Date().toISOString();
    const seqRow = db.central.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next_seq FROM projects').get();
    const number = String(seqRow?.next_seq || 1);
    const projectType = String(req.body?.type || 'private').trim() || 'private';
    const ownerName = String(req.username || '').trim();

    const projectInfo = db.central.prepare(`
      INSERT INTO projects (
        number, title, client_name, project_type, power_kw, owner_name, status,
        plan_start, plan_end, fact_start, fact_end, delay_reason, project_value, project_value_currency,
        budget_plan, paid_amount, expenses_fact, created_by_user_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      title,
      String(req.body?.clientName || '').trim() || null,
      projectType,
      String(req.body?.powerKw || '').trim() || null,
      ownerName || null,
      String(req.body?.status || 'planning').trim() || 'planning',
      String(req.body?.planStart || '').trim() || null,
      String(req.body?.planEnd || '').trim() || null,
      String(req.body?.factStart || '').trim() || null,
      String(req.body?.factEnd || '').trim() || null,
      String(req.body?.delayReason || '').trim() || null,
      String(req.body?.projectValue || '').trim() || null,
      String(req.body?.projectValueCurrency || 'UAH').trim().toUpperCase() === 'USD' ? 'USD' : 'UAH',
      String(req.body?.budgetPlan || '').trim() || null,
      String(req.body?.paidAmount || '').trim() || null,
      String(req.body?.expensesFact || '').trim() || null,
      req.userId,
      now,
      now
    );

    const projectId = Number(projectInfo.lastInsertRowid);
    db.central.prepare(`
      INSERT OR IGNORE INTO project_members (project_id, user_id, added_by_user_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(projectId, req.userId, req.userId, now);

    const incomingStages = Array.isArray(req.body?.stages) ? req.body.stages : [];
    const stagesToInsert = incomingStages.length > 0
      ? incomingStages
      : DEFAULT_PROJECT_STAGE_TEMPLATES.map((stageTemplate, index) => ({
        name: stageTemplate.name,
        orderIndex: index,
        status: 'pending',
        stageTasks: (stageTemplate.tasks || []).map((taskText) => ({
          text: taskText,
          plannedDate: '',
          completedAt: '',
          done: false
        }))
      }));
    const insertStage = db.central.prepare(`
      INSERT INTO project_stages (
        project_id, name, order_index, status, plan_start, plan_end, fact_start, fact_end, plan_date, fact_date, plan_notes, fact_notes, stage_tasks_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < stagesToInsert.length; i += 1) {
      const stage = stagesToInsert[i] || {};
      const name = String(stage.name || '').trim();
      if (!name) continue;
      insertStage.run(
        projectId,
        name,
        Number.isFinite(Number(stage.orderIndex)) ? Number(stage.orderIndex) : i,
        String(stage.status || 'pending').trim() || 'pending',
        String(stage.planStart || '').trim() || null,
        String(stage.planEnd || '').trim() || String(stage.planDate || '').trim() || null,
        String(stage.factStart || '').trim() || null,
        String(stage.factEnd || '').trim() || String(stage.factDate || '').trim() || null,
        String(stage.planDate || '').trim() || null,
        String(stage.factDate || '').trim() || null,
        String(stage.planNotes || '').trim() || null,
        String(stage.factNotes || '').trim() || null,
        JSON.stringify(Array.isArray(stage.stageTasks) ? stage.stageTasks : []),
        now,
        now
      );
    }

    const project = loadProjectForUser(projectId, req.userId);
    return res.status(201).json({ project });
  } catch (error) {
    console.error('projects create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const project = loadProjectForUser(projectId, req.userId);
    if (!project) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    return res.json({ project });
  } catch (error) {
    console.error('projects get error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const sets = [];
    const values = [];
    for (const [inputKey, columnName] of Object.entries(PROJECT_FIELD_MAP)) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, inputKey)) continue;
      const raw = req.body?.[inputKey];
      const nextValue = raw == null ? null : String(raw).trim();
      if ((inputKey === 'title' || inputKey === 'number') && !nextValue) {
        return res.status(400).json({ error: `Поле "${inputKey}" не може бути порожнім` });
      }
      sets.push(`${columnName} = ?`);
      values.push(nextValue || null);
    }
    if (sets.length === 0) {
      const projectNoChanges = loadProjectForUser(projectId, req.userId);
      return res.json({ project: projectNoChanges });
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(projectId);
    db.central.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ project });
  } catch (error) {
    console.error('projects patch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:projectId/stages/:stageId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const stageId = Number.parseInt(req.params.stageId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(stageId)) {
      return res.status(400).json({ error: 'Некоректний ID' });
    }
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const stageExists = db.central.prepare(`
      SELECT id
      FROM project_stages
      WHERE id = ? AND project_id = ?
      LIMIT 1
    `).get(stageId, projectId);
    if (!stageExists) return res.status(404).json({ error: 'Етап не знайдено' });

    const sets = [];
    const values = [];
    for (const [inputKey, columnName] of Object.entries(STAGE_FIELD_MAP)) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, inputKey)) continue;
      const raw = req.body?.[inputKey];
      if (inputKey === 'orderIndex') {
        const orderValue = Number.parseInt(String(raw), 10);
        sets.push(`${columnName} = ?`);
        values.push(Number.isFinite(orderValue) ? orderValue : 0);
        continue;
      }
      if (inputKey === 'stageTasks') {
        const tasks = Array.isArray(raw) ? raw : [];
        sets.push(`${columnName} = ?`);
        values.push(JSON.stringify(tasks));
        continue;
      }
      const nextValue = raw == null ? null : String(raw).trim();
      if (inputKey === 'name' && !nextValue) {
        return res.status(400).json({ error: 'Назва етапу не може бути порожньою' });
      }
      sets.push(`${columnName} = ?`);
      values.push(nextValue || null);
    }
    if (sets.length === 0) {
      const projectNoChanges = loadProjectForUser(projectId, req.userId);
      return res.json({ project: projectNoChanges });
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(stageId, projectId);
    db.central.prepare(`
      UPDATE project_stages
      SET ${sets.join(', ')}
      WHERE id = ? AND project_id = ?
    `).run(...values);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);

    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ project });
  } catch (error) {
    console.error('projects stage patch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/finance', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const type = String(req.body?.type || '').trim().toLowerCase();
    if (type !== 'income' && type !== 'expense') {
      return res.status(400).json({ error: 'Некоректний тип операції' });
    }
    const amountRaw = String(req.body?.amount || '').trim().replace(',', '.');
    const amountNum = Number.parseFloat(amountRaw);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Сума має бути більше 0' });
    }
    const currencyRaw = String(req.body?.currency || 'UAH').trim().toUpperCase();
    const currency = currencyRaw === 'USD' ? 'USD' : 'UAH';
    const paymentDate = String(req.body?.paymentDate || '').trim();
    const usdRateRaw = String(req.body?.usdRate || '').trim().replace(',', '.');
    const usdRateNum = Number.parseFloat(usdRateRaw);
    const usdRate = currency === 'USD' && Number.isFinite(usdRateNum) && usdRateNum > 0 ? String(usdRateNum) : null;
    const note = String(req.body?.note || '').trim();
    const now = new Date().toISOString();

    db.central.prepare(`
      INSERT INTO project_finance_entries
      (project_id, entry_type, amount, currency, usd_rate, payment_date, note, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      type,
      String(amountNum),
      currency,
      usdRate,
      paymentDate || null,
      note || null,
      req.userId,
      now,
      now
    );
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    const project = loadProjectForUser(projectId, req.userId);
    return res.status(201).json({ project });
  } catch (error) {
    console.error('projects finance create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:projectId/finance/:financeId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const financeId = Number.parseInt(req.params.financeId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(financeId)) {
      return res.status(400).json({ error: 'Некоректні параметри' });
    }
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    db.central.prepare('DELETE FROM project_finance_entries WHERE id = ? AND project_id = ?').run(financeId, projectId);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ project });
  } catch (error) {
    console.error('projects finance delete error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/members', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    const userId = Number.parseInt(String(req.body?.userId || ''), 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Некоректний ID' });
    }
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const targetUser = db.central.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!targetUser) return res.status(404).json({ error: 'Користувача не знайдено' });

    db.central.prepare(`
      INSERT OR IGNORE INTO project_members (project_id, user_id, added_by_user_id, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(projectId, userId, req.userId);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);

    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ project });
  } catch (error) {
    console.error('projects member add error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:projectId/members/:userId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Некоректний ID' });
    }
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const countRow = db.central.prepare('SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?').get(projectId);
    if (Number(countRow?.count || 0) <= 1) {
      return res.status(400).json({ error: 'Не можна видалити останнього учасника проєкту' });
    }

    db.central.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);

    const hasAccessAfterDelete = getAccessibleProjectRow(projectId, req.userId);
    if (!hasAccessAfterDelete) return res.json({ success: true, project: null });
    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ success: true, project });
  } catch (error) {
    console.error('projects member delete error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    db.central.prepare('DELETE FROM project_stages WHERE project_id = ?').run(projectId);
    db.central.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    db.central.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return res.json({ success: true });
  } catch (error) {
    console.error('projects delete error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
