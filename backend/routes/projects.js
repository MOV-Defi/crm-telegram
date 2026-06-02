const express = require('express');
const db = require('../db');

const router = express.Router();

const DEFAULT_PROJECT_STAGES = [
  'Договір',
  'Авансування',
  'Обстеження',
  'Проєктування специфікація',
  'Закупки, постачання',
  'Логістика, спецтехніка',
  'Монтаж',
  'Підключення, навчання',
  'Виконавчі документи, Паспорт',
  'Перевиставлення рахунків'
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
  stageTasks: 'stage_tasks_json',
  planNotes: 'plan_notes',
  factNotes: 'fact_notes'
};

const toProjectDto = (row, stages, members) => ({
  id: row.id,
  number: row.number || '',
  title: row.title || '',
  clientName: row.client_name || '',
  type: row.project_type || 'private',
  powerKw: row.power_kw || '',
  owner: row.owner_name || '',
  status: row.status || 'planning',
  planStart: row.plan_start || '',
  planEnd: row.plan_end || '',
  factStart: row.fact_start || '',
  factEnd: row.fact_end || '',
  delayReason: row.delay_reason || '',
  budgetPlan: row.budget_plan || '',
  paidAmount: row.paid_amount || '',
  expensesFact: row.expenses_fact || '',
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
  stages: Array.isArray(stages) ? stages : [],
  members: Array.isArray(members) ? members : []
});

const getAccessibleProjectRow = (projectId, userId) => (
  db.central.prepare(`
    SELECT p.*
    FROM projects p
    INNER JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ? AND pm.user_id = ?
    LIMIT 1
  `).get(projectId, userId)
);

const getProjectStages = (projectId) => (
  db.central.prepare(`
    SELECT id, name, order_index, status, plan_start, plan_end, fact_start, fact_end, stage_tasks_json, plan_notes, fact_notes, created_at, updated_at
    FROM project_stages
    WHERE project_id = ?
    ORDER BY order_index ASC, id ASC
  `).all(projectId).map((row) => ({
    id: row.id,
    name: row.name || '',
    orderIndex: Number(row.order_index || 0),
    status: row.status || 'pending',
    planStart: row.plan_start || '',
    planEnd: row.plan_end || '',
    factStart: row.fact_start || '',
    factEnd: row.fact_end || '',
    stageTasks: (() => {
      try {
        const parsed = JSON.parse(String(row.stage_tasks_json || '[]'));
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    })(),
    planNotes: row.plan_notes || '',
    factNotes: row.fact_notes || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }))
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
  return toProjectDto(row, getProjectStages(projectId), getProjectMembers(projectId));
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
      SELECT DISTINCT p.*
      FROM projects p
      INNER JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = ?
      ORDER BY p.updated_at DESC, p.id DESC
    `).all(req.userId);
    const projects = rows.map((row) => toProjectDto(row, getProjectStages(row.id), getProjectMembers(row.id)));
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
    const numberInput = String(req.body?.number || '').trim();
    const countRow = db.central.prepare('SELECT COUNT(*) AS count FROM projects').get();
    const fallbackNumber = `${new Date().getFullYear()}-${String(Number(countRow?.count || 0) + 1).padStart(3, '0')}`;
    const number = numberInput || fallbackNumber;
    const projectType = String(req.body?.type || 'private').trim() || 'private';
    const creator = db.central.prepare('SELECT username FROM users WHERE id = ? LIMIT 1').get(req.userId);
    const ownerName = String(creator?.username || req.body?.owner || '').trim() || null;

    const projectInfo = db.central.prepare(`
      INSERT INTO projects (
        number, title, client_name, project_type, power_kw, owner_name, status,
        plan_start, plan_end, fact_start, fact_end, delay_reason,
        budget_plan, paid_amount, expenses_fact, created_by_user_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      title,
      String(req.body?.clientName || '').trim() || null,
      projectType,
      String(req.body?.powerKw || '').trim() || null,
      ownerName,
      String(req.body?.status || 'planning').trim() || 'planning',
      String(req.body?.planStart || '').trim() || null,
      String(req.body?.planEnd || '').trim() || null,
      String(req.body?.factStart || '').trim() || null,
      String(req.body?.factEnd || '').trim() || null,
      String(req.body?.delayReason || '').trim() || null,
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
      : DEFAULT_PROJECT_STAGES.map((name, index) => ({ name, orderIndex: index, status: 'pending' }));
    const insertStage = db.central.prepare(`
      INSERT INTO project_stages (
        project_id, name, order_index, status, plan_start, plan_end, fact_start, fact_end, stage_tasks_json, plan_notes, fact_notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        String(stage.planEnd || '').trim() || null,
        String(stage.factStart || '').trim() || null,
        String(stage.factEnd || '').trim() || null,
        JSON.stringify(Array.isArray(stage.stageTasks) ? stage.stageTasks : []),
        String(stage.planNotes || '').trim() || null,
        String(stage.factNotes || '').trim() || null,
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
      if (inputKey === 'stageTasks') {
        sets.push(`${columnName} = ?`);
        values.push(JSON.stringify(Array.isArray(raw) ? raw : []));
        continue;
      }
      if (inputKey === 'orderIndex') {
        const orderValue = Number.parseInt(String(raw), 10);
        sets.push(`${columnName} = ?`);
        values.push(Number.isFinite(orderValue) ? orderValue : 0);
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
