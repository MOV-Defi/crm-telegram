const express = require('express');
const db = require('../db');

const router = express.Router();

const DEPARTMENT_TASK_STATUSES = new Set(['plan', 'in_progress', 'waiting', 'done']);
const DEPARTMENT_TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const normalizeDate = (value) => String(value || '').trim().slice(0, 32);
const normalizeStatus = (value) => {
  const status = String(value || '').trim();
  return DEPARTMENT_TASK_STATUSES.has(status) ? status : 'plan';
};
const normalizePriority = (value) => {
  const priority = String(value || '').trim();
  return DEPARTMENT_TASK_PRIORITIES.has(priority) ? priority : 'normal';
};
const normalizeColor = (value) => {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb';
};
const parseOptionalId = (value) => {
  const id = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const toUserDto = (row) => row ? ({ id: row.id, username: row.username || '', role: row.role || 'user' }) : null;
const toDepartmentDto = (row) => ({
  id: row.id, name: row.name || '', description: row.description || '', color: row.color || '#2563eb',
  leadUserId: row.lead_user_id || null, leadUsername: row.lead_username || '',
  isActive: Number(row.is_active || 0) === 1, createdByUserId: row.created_by_user_id || null,
  createdAt: row.created_at || null, updatedAt: row.updated_at || null, members: [], tasks: []
});
const toMemberDto = (row) => ({ userId: row.user_id, username: row.username || '', role: row.member_role || 'member', createdAt: row.created_at || null });
const toTaskDto = (row) => ({
  id: row.id, departmentId: row.department_id, projectId: row.project_id || null, projectTitle: row.project_title || '',
  title: row.title || '', description: row.description || '', status: normalizeStatus(row.status), priority: normalizePriority(row.priority),
  startAt: row.start_at || '', dueAt: row.due_at || '', assignedUserId: row.assigned_user_id || null, assignedUsername: row.assigned_username || '',
  createdByUserId: row.created_by_user_id || null, createdByUsername: row.created_by_username || '', completedAt: row.completed_at || '',
  createdAt: row.created_at || null, updatedAt: row.updated_at || null
});

const getUsers = () => db.central.prepare('SELECT id, username, role FROM users ORDER BY lower(username) ASC').all().map(toUserDto);
const getProjects = () => db.central.prepare('SELECT id, number, title, client_name FROM projects ORDER BY updated_at DESC, id DESC').all().map((row) => ({ id: row.id, number: row.number || '', title: row.title || '', clientName: row.client_name || '' }));

const loadDepartments = () => {
  const departments = db.central.prepare("SELECT d.*, lu.username AS lead_username FROM departments d LEFT JOIN users lu ON lu.id = d.lead_user_id WHERE d.is_active = 1 ORDER BY lower(d.name) ASC, d.id ASC").all().map(toDepartmentDto);
  const byId = new Map(departments.map((item) => [item.id, item]));
  db.central.prepare("SELECT dm.department_id, dm.user_id, dm.role AS member_role, dm.created_at, u.username FROM department_members dm LEFT JOIN users u ON u.id = dm.user_id ORDER BY lower(u.username) ASC").all().forEach((row) => {
    const department = byId.get(row.department_id);
    if (department) department.members.push(toMemberDto(row));
  });
  db.central.prepare("SELECT dt.*, au.username AS assigned_username, cu.username AS created_by_username, p.title AS project_title FROM department_tasks dt LEFT JOIN users au ON au.id = dt.assigned_user_id LEFT JOIN users cu ON cu.id = dt.created_by_user_id LEFT JOIN projects p ON p.id = dt.project_id ORDER BY CASE dt.status WHEN 'plan' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 WHEN 'done' THEN 3 ELSE 4 END ASC, COALESCE(dt.due_at, '') ASC, dt.id DESC").all().forEach((row) => {
    const department = byId.get(row.department_id);
    if (department) department.tasks.push(toTaskDto(row));
  });
  return departments;
};
const sendState = (res) => res.json({ departments: loadDepartments(), users: getUsers(), projects: getProjects() });

router.get('/', (req, res) => {
  try { return sendState(res); } catch (error) { console.error('departments list error:', error); return res.status(500).json({ error: 'Не вдалося завантажити відділи' }); }
});

router.post('/', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Назва відділу обовʼязкова' });
    const leadUserId = parseOptionalId(req.body?.leadUserId);
    const result = db.central.prepare("INSERT INTO departments (name, description, color, lead_user_id, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(name, String(req.body?.description || '').trim() || null, normalizeColor(req.body?.color), leadUserId, req.userId);
    if (leadUserId) db.central.prepare('INSERT OR IGNORE INTO department_members (department_id, user_id, role) VALUES (?, ?, ?)').run(result.lastInsertRowid, leadUserId, 'lead');
    return sendState(res);
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Такий відділ вже існує' });
    console.error('departments create error:', error); return res.status(500).json({ error: 'Не вдалося створити відділ' });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const departmentId = parseOptionalId(req.params.id);
    if (!departmentId) return res.status(400).json({ error: 'Некоректний ID відділу' });
    const existing = db.central.prepare('SELECT id FROM departments WHERE id = ? AND is_active = 1').get(departmentId);
    if (!existing) return res.status(404).json({ error: 'Відділ не знайдено' });
    const sets = []; const values = [];
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) { sets.push('name = ?'); values.push(String(req.body?.name || '').trim()); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) { sets.push('description = ?'); values.push(String(req.body?.description || '').trim() || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'color')) { sets.push('color = ?'); values.push(normalizeColor(req.body?.color)); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'leadUserId')) { sets.push('lead_user_id = ?'); values.push(parseOptionalId(req.body?.leadUserId)); }
    if (!sets.length) return sendState(res);
    sets.push('updated_at = CURRENT_TIMESTAMP'); values.push(departmentId);
    db.central.prepare('UPDATE departments SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    return sendState(res);
  } catch (error) { console.error('departments update error:', error); return res.status(500).json({ error: 'Не вдалося оновити відділ' }); }
});

router.delete('/:id', (req, res) => {
  try { const departmentId = parseOptionalId(req.params.id); if (!departmentId) return res.status(400).json({ error: 'Некоректний ID відділу' }); db.central.prepare('UPDATE departments SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(departmentId); return sendState(res); }
  catch (error) { console.error('departments delete error:', error); return res.status(500).json({ error: 'Не вдалося видалити відділ' }); }
});

router.post('/:id/members', (req, res) => {
  try { const departmentId = parseOptionalId(req.params.id); const userId = parseOptionalId(req.body?.userId); if (!departmentId || !userId) return res.status(400).json({ error: 'Оберіть відділ і користувача' }); const role = String(req.body?.role || 'member').trim() === 'lead' ? 'lead' : 'member'; db.central.prepare('INSERT OR REPLACE INTO department_members (department_id, user_id, role, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(departmentId, userId, role); return sendState(res); }
  catch (error) { console.error('departments member add error:', error); return res.status(500).json({ error: 'Не вдалося додати учасника' }); }
});

router.delete('/:departmentId/members/:userId', (req, res) => {
  try { const departmentId = parseOptionalId(req.params.departmentId); const userId = parseOptionalId(req.params.userId); if (!departmentId || !userId) return res.status(400).json({ error: 'Некоректні параметри' }); db.central.prepare('DELETE FROM department_members WHERE department_id = ? AND user_id = ?').run(departmentId, userId); return sendState(res); }
  catch (error) { console.error('departments member delete error:', error); return res.status(500).json({ error: 'Не вдалося прибрати учасника' }); }
});

router.post('/:id/tasks', (req, res) => {
  try {
    const departmentId = parseOptionalId(req.params.id); if (!departmentId) return res.status(400).json({ error: 'Некоректний ID відділу' });
    const title = String(req.body?.title || '').trim(); if (!title) return res.status(400).json({ error: 'Назва задачі обовʼязкова' });
    const status = normalizeStatus(req.body?.status);
    db.central.prepare("INSERT INTO department_tasks (department_id, project_id, title, description, status, priority, start_at, due_at, assigned_user_id, created_by_user_id, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(departmentId, parseOptionalId(req.body?.projectId), title, String(req.body?.description || '').trim() || null, status, normalizePriority(req.body?.priority), normalizeDate(req.body?.startAt) || null, normalizeDate(req.body?.dueAt) || null, parseOptionalId(req.body?.assignedUserId), req.userId, status === 'done' ? new Date().toISOString() : null);
    return sendState(res);
  } catch (error) { console.error('departments task create error:', error); return res.status(500).json({ error: 'Не вдалося створити задачу' }); }
});

router.patch('/:departmentId/tasks/:taskId', (req, res) => {
  try {
    const departmentId = parseOptionalId(req.params.departmentId); const taskId = parseOptionalId(req.params.taskId);
    if (!departmentId || !taskId) return res.status(400).json({ error: 'Некоректні параметри' });
    const existing = db.central.prepare('SELECT * FROM department_tasks WHERE id = ? AND department_id = ?').get(taskId, departmentId);
    if (!existing) return res.status(404).json({ error: 'Задачу не знайдено' });
    const sets = []; const values = [];
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'title')) { sets.push('title = ?'); values.push(String(req.body?.title || '').trim()); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) { sets.push('description = ?'); values.push(String(req.body?.description || '').trim() || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) { const nextStatus = normalizeStatus(req.body?.status); sets.push('status = ?'); values.push(nextStatus); sets.push('completed_at = ?'); values.push(nextStatus === 'done' ? (existing.completed_at || new Date().toISOString()) : null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'priority')) { sets.push('priority = ?'); values.push(normalizePriority(req.body?.priority)); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'startAt')) { sets.push('start_at = ?'); values.push(normalizeDate(req.body?.startAt) || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dueAt')) { sets.push('due_at = ?'); values.push(normalizeDate(req.body?.dueAt) || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'assignedUserId')) { sets.push('assigned_user_id = ?'); values.push(parseOptionalId(req.body?.assignedUserId)); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'projectId')) { sets.push('project_id = ?'); values.push(parseOptionalId(req.body?.projectId)); }
    if (!sets.length) return sendState(res);
    sets.push('updated_at = CURRENT_TIMESTAMP'); values.push(taskId, departmentId);
    db.central.prepare('UPDATE department_tasks SET ' + sets.join(', ') + ' WHERE id = ? AND department_id = ?').run(...values);
    return sendState(res);
  } catch (error) { console.error('departments task update error:', error); return res.status(500).json({ error: 'Не вдалося оновити задачу' }); }
});

router.delete('/:departmentId/tasks/:taskId', (req, res) => {
  try { const departmentId = parseOptionalId(req.params.departmentId); const taskId = parseOptionalId(req.params.taskId); if (!departmentId || !taskId) return res.status(400).json({ error: 'Некоректні параметри' }); db.central.prepare('DELETE FROM department_tasks WHERE id = ? AND department_id = ?').run(taskId, departmentId); return sendState(res); }
  catch (error) { console.error('departments task delete error:', error); return res.status(500).json({ error: 'Не вдалося видалити задачу' }); }
});

module.exports = router;
