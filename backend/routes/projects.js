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

const PROJECT_TASK_STATUS_VALUES = new Set(['new', 'in_progress', 'done']);

const normalizeProjectTaskStatus = (value) => {
  const status = String(value || '').trim();
  return PROJECT_TASK_STATUS_VALUES.has(status) ? status : 'new';
};

const getProjectMemberIds = (projectId) => (
  db.central.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(projectId)
    .map((row) => Number(row.user_id))
    .filter((id) => Number.isFinite(id) && id > 0)
);

const createProjectNotification = ({ projectId, userId, actorUserId, eventType, title, body = '', taskId = null, stageId = null }) => {
  if (!Number.isFinite(Number(projectId)) || !Number.isFinite(Number(userId))) return;
  db.central.prepare(`
    INSERT INTO project_notifications (
      project_id, user_id, actor_user_id, event_type, title, body, related_task_id, related_stage_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    Number(projectId),
    Number(userId),
    Number.isFinite(Number(actorUserId)) ? Number(actorUserId) : null,
    String(eventType || 'project').trim() || 'project',
    String(title || '').trim() || 'Сповіщення по проєкту',
    String(body || '').trim() || null,
    Number.isFinite(Number(taskId)) ? Number(taskId) : null,
    Number.isFinite(Number(stageId)) ? Number(stageId) : null
  );
};

const notifyProjectMembers = (projectId, actorUserId, payload, options = {}) => {
  const onlyUserId = Number(options.onlyUserId || 0);
  const includeActor = options.includeActor === true;
  const recipients = onlyUserId ? [onlyUserId] : getProjectMemberIds(projectId);
  for (const userId of recipients) {
    if (!includeActor && Number(userId) === Number(actorUserId)) continue;
    createProjectNotification({
      projectId,
      userId,
      actorUserId,
      eventType: payload.eventType,
      title: payload.title,
      body: payload.body,
      taskId: payload.taskId,
      stageId: payload.stageId
    });
  }
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

const getProjectTasks = (projectId) => (
  db.central.prepare(`
    SELECT
      pt.id, pt.project_id, pt.title, pt.description, pt.status, pt.start_at, pt.due_at, pt.remind_at,
      pt.assigned_user_id, au.username AS assigned_username,
      pt.created_by_user_id, cu.username AS created_by_username,
      pt.completed_at, pt.reminder_sent_at, pt.created_at, pt.updated_at
    FROM project_tasks pt
    LEFT JOIN users au ON au.id = pt.assigned_user_id
    LEFT JOIN users cu ON cu.id = pt.created_by_user_id
    WHERE pt.project_id = ?
    ORDER BY
      CASE pt.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END ASC,
      COALESCE(pt.due_at, '') ASC,
      pt.id DESC
  `).all(projectId).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title || '',
    description: row.description || '',
    status: normalizeProjectTaskStatus(row.status),
    startAt: row.start_at || '',
    dueAt: row.due_at || '',
    remindAt: row.remind_at || '',
    assignedUserId: row.assigned_user_id || null,
    assignedUsername: row.assigned_username || '',
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username || '',
    completedAt: row.completed_at || '',
    reminderSentAt: row.reminder_sent_at || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }))
);

const getProjectNotes = (projectId) => (
  db.central.prepare(`
    SELECT pn.id, pn.project_id, pn.body, pn.created_by_user_id, u.username AS created_by_username, pn.created_at, pn.updated_at
    FROM project_notes pn
    LEFT JOIN users u ON u.id = pn.created_by_user_id
    WHERE pn.project_id = ?
    ORDER BY pn.created_at DESC, pn.id DESC
  `).all(projectId).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    body: row.body || '',
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }))
);

const getProjectNotificationRows = (userId, limit = 80) => (
  db.central.prepare(`
    SELECT pn.id, pn.project_id, p.number AS project_number, p.title AS project_title,
           pn.user_id, pn.actor_user_id, au.username AS actor_username,
           pn.event_type, pn.title, pn.body, pn.related_task_id, pn.related_stage_id,
           pn.is_read, pn.created_at, pn.read_at
    FROM project_notifications pn
    LEFT JOIN projects p ON p.id = pn.project_id
    LEFT JOIN users au ON au.id = pn.actor_user_id
    WHERE pn.user_id = ?
    ORDER BY pn.is_read ASC, pn.created_at DESC, pn.id DESC
    LIMIT ?
  `).all(userId, limit).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectNumber: row.project_number || '',
    projectTitle: row.project_title || '',
    userId: row.user_id,
    actorUserId: row.actor_user_id || null,
    actorUsername: row.actor_username || '',
    eventType: row.event_type || 'project',
    title: row.title || '',
    body: row.body || '',
    relatedTaskId: row.related_task_id || null,
    relatedStageId: row.related_stage_id || null,
    isRead: Number(row.is_read || 0) === 1,
    createdAt: row.created_at || null,
    readAt: row.read_at || null
  }))
);

const toProjectDto = (row, stages, members, financeEntries, tasks, notes) => ({
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
  tasks: Array.isArray(tasks) ? tasks : [],
  notes: Array.isArray(notes) ? notes : [],
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
  return toProjectDto(
    row,
    getProjectStages(projectId),
    getProjectMembers(projectId),
    getProjectFinanceEntries(projectId),
    getProjectTasks(projectId),
    getProjectNotes(projectId)
  );
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

router.get('/notifications', (req, res) => {
  try {
    const notifications = getProjectNotificationRows(req.userId, 80);
    const unreadCount = db.central.prepare('SELECT COUNT(*) AS count FROM project_notifications WHERE user_id = ? AND is_read = 0')
      .get(req.userId)?.count || 0;
    return res.json({ notifications, unreadCount: Number(unreadCount || 0) });
  } catch (error) {
    console.error('projects notifications list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/notifications/read', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) : [];
    if (ids.length) {
      const update = db.central.prepare('UPDATE project_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?');
      for (const id of ids) update.run(id, req.userId);
    } else {
      db.central.prepare('UPDATE project_notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0')
        .run(req.userId);
    }
    const notifications = getProjectNotificationRows(req.userId, 80);
    const unreadCount = db.central.prepare('SELECT COUNT(*) AS count FROM project_notifications WHERE user_id = ? AND is_read = 0')
      .get(req.userId)?.count || 0;
    return res.json({ notifications, unreadCount: Number(unreadCount || 0) });
  } catch (error) {
    console.error('projects notifications read error:', error);
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
    const projects = rows.map((row) => toProjectDto(
      row,
      getProjectStages(row.id),
      getProjectMembers(row.id),
      getProjectFinanceEntries(row.id),
      getProjectTasks(row.id),
      getProjectNotes(row.id)
    ));
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

    const stagesToInsert = DEFAULT_PROJECT_STAGE_TEMPLATES.map((stageTemplate, index) => ({
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
    const usdRate = Number.isFinite(usdRateNum) && usdRateNum > 0 ? String(usdRateNum) : null;
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

router.post('/:id/tasks', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Назва задачі обовʼязкова' });

    const assignedUserIdRaw = req.body?.assignedUserId == null || req.body.assignedUserId === ''
      ? null
      : Number.parseInt(String(req.body.assignedUserId), 10);
    const assignedUserId = Number.isFinite(assignedUserIdRaw) && assignedUserIdRaw > 0 ? assignedUserIdRaw : null;
    if (assignedUserId) {
      const member = db.central.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, assignedUserId);
      if (!member) return res.status(400).json({ error: 'Відповідальний має бути учасником проєкту' });
    }

    const status = normalizeProjectTaskStatus(req.body?.status);
    const now = new Date().toISOString();
    const completedAt = status === 'done' ? now : null;

    const taskInfo = db.central.prepare(`
      INSERT INTO project_tasks (
        project_id, title, description, status, start_at, due_at, remind_at,
        assigned_user_id, created_by_user_id, completed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      title,
      String(req.body?.description || '').trim() || null,
      status,
      String(req.body?.startAt || '').trim() || null,
      String(req.body?.dueAt || '').trim() || null,
      String(req.body?.remindAt || '').trim() || null,
      assignedUserId,
      req.userId,
      completedAt,
      now,
      now
    );
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.status(201).json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects task create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:projectId/tasks/:taskId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const taskId = Number.parseInt(req.params.taskId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const existing = db.central.prepare('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?').get(taskId, projectId);
    if (!existing) return res.status(404).json({ error: 'Задачу не знайдено' });

    const sets = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'title')) {
      const title = String(req.body?.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Назва задачі обовʼязкова' });
      sets.push('title = ?');
      values.push(title);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) {
      sets.push('description = ?');
      values.push(String(req.body?.description || '').trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
      const nextStatus = normalizeProjectTaskStatus(req.body?.status);
      sets.push('status = ?');
      values.push(nextStatus);
      sets.push('completed_at = ?');
      values.push(nextStatus === 'done' ? (existing.completed_at || new Date().toISOString()) : null);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'startAt')) {
      sets.push('start_at = ?');
      values.push(String(req.body?.startAt || '').trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dueAt')) {
      sets.push('due_at = ?');
      values.push(String(req.body?.dueAt || '').trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'remindAt')) {
      sets.push('remind_at = ?');
      values.push(String(req.body?.remindAt || '').trim() || null);
      sets.push('reminder_sent_at = NULL');
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'assignedUserId')) {
      const assignedUserIdRaw = req.body?.assignedUserId == null || req.body.assignedUserId === ''
        ? null
        : Number.parseInt(String(req.body.assignedUserId), 10);
      const assignedUserId = Number.isFinite(assignedUserIdRaw) && assignedUserIdRaw > 0 ? assignedUserIdRaw : null;
      if (assignedUserId) {
        const member = db.central.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, assignedUserId);
        if (!member) return res.status(400).json({ error: 'Відповідальний має бути учасником проєкту' });
      }
      sets.push('assigned_user_id = ?');
      values.push(assignedUserId);
    }

    if (!sets.length) return res.json({ project: loadProjectForUser(projectId, req.userId) });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(taskId, projectId);
    db.central.prepare(`UPDATE project_tasks SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`).run(...values);
    const nextAssignedUserId = Object.prototype.hasOwnProperty.call(req.body || {}, 'assignedUserId')
      ? values[sets.findIndex((set) => set === 'assigned_user_id = ?')]
      : existing.assigned_user_id;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'assignedUserId') && nextAssignedUserId && Number(nextAssignedUserId) !== Number(existing.assigned_user_id)) {
      notifyProjectMembers(projectId, req.userId, {
        eventType: 'task_assigned',
        title: 'Вам призначено задачу',
        body: `Проєкт: ${current.title || current.number || projectId}
Задача: ${existing.title || 'Без назви'}`,
        taskId
      }, { onlyUserId: nextAssignedUserId, includeActor: Number(nextAssignedUserId) === Number(req.userId) });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
      notifyProjectMembers(projectId, req.userId, {
        eventType: 'task_status_changed',
        title: 'Змінено статус задачі',
        body: `Проєкт: ${current.title || current.number || projectId}
Задача: ${existing.title || 'Без назви'}
Статус: ${normalizeProjectTaskStatus(req.body?.status)}`,
        taskId
      });
    }
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects task patch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:projectId/tasks/:taskId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const taskId = Number.parseInt(req.params.taskId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    db.central.prepare('DELETE FROM project_tasks WHERE id = ? AND project_id = ?').run(taskId, projectId);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects task delete error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/notes', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Текст нотатки обовʼязковий' });
    const now = new Date().toISOString();

    db.central.prepare(`
      INSERT INTO project_notes (project_id, body, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, body, req.userId, now, now);
    notifyProjectMembers(projectId, req.userId, {
      eventType: 'note_created',
      title: 'Нова нотатка по проєкту',
      body: `Проєкт: ${current.title || current.number || projectId}
${body.slice(0, 180)}`,
    });
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.status(201).json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects note create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:projectId/notes/:noteId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const noteId = Number.parseInt(req.params.noteId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(noteId)) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Текст нотатки обовʼязковий' });

    db.central.prepare('UPDATE project_notes SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?')
      .run(body, noteId, projectId);
    notifyProjectMembers(projectId, req.userId, {
      eventType: 'note_updated',
      title: 'Оновлено нотатку по проєкту',
      body: `Проєкт: ${current.title || current.number || projectId}`,
    });
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects note patch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:projectId/notes/:noteId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const noteId = Number.parseInt(req.params.noteId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(noteId)) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    db.central.prepare('DELETE FROM project_notes WHERE id = ? AND project_id = ?').run(noteId, projectId);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects note delete error:', error);
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
