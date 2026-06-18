const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const db = require('../db');
const runtimePaths = require('../runtime-paths');
const { parseXlsxRows } = require('../warehouse-file-items');

const router = express.Router();
const upload = multer({ dest: runtimePaths.mediaDir });

const normalizeUploadPublicPath = (value) => {
  const publicPath = String(value || '').trim();
  if (!publicPath.startsWith('/uploads/')) return null;
  const relativePath = publicPath.replace(/^\/uploads\//, '');
  if (!relativePath || relativePath.includes('..')) return null;
  const diskPath = path.resolve(runtimePaths.uploadsDir, relativePath);
  const uploadsRoot = path.resolve(runtimePaths.uploadsDir);
  if (diskPath !== uploadsRoot && !diskPath.startsWith(uploadsRoot + path.sep)) return null;
  return { publicPath, diskPath };
};

const sanitizeStoredFileName = (name) => {
  const safe = String(name || 'invoice.bin')
    .replace(/[\/\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || 'invoice.bin';
};

const getProjectInvoiceDir = (projectId) => {
  const invoiceDir = path.join(runtimePaths.projectsDir, String(projectId), 'invoices');
  runtimePaths.ensureDir(invoiceDir);
  return invoiceDir;
};

const buildProjectInvoiceFileTarget = (projectId, originalName) => {
  const safeOriginal = sanitizeStoredFileName(originalName);
  const ext = path.extname(safeOriginal) || '.bin';
  const base = path.basename(safeOriginal, ext).slice(0, 80).trim() || 'invoice';
  const storedName = base + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  const invoiceDir = getProjectInvoiceDir(projectId);
  return {
    storedName,
    diskPath: path.join(invoiceDir, storedName),
    publicPath: '/uploads/projects/' + projectId + '/invoices/' + encodeURIComponent(storedName).replace(/%2F/gi, '/')
  };
};

const saveProjectInvoiceRecord = ({ projectId, fileName, filePath, comment, isPaid, paidBy, paidAt, userId }) => {
  db.central.prepare(`
      INSERT INTO project_invoices (project_id, file_name, file_path, comment, is_paid, paid_by, paid_at, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(projectId, fileName, filePath, comment || null, isPaid ? 1 : 0, paidBy || null, paidAt || null, userId);
  db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
};

const deletePublicUploadFile = (publicPath) => {
  const resolved = normalizeUploadPublicPath(publicPath);
  if (!resolved) return;
  try { if (fs.existsSync(resolved.diskPath)) fs.unlinkSync(resolved.diskPath); } catch (_) {}
};

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

const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const decodeMultipartFileName = (value) => {
  const raw = String(value || '');
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    return /[�]/.test(decoded) ? raw : decoded;
  } catch (_) {
    return raw;
  }
};

const safeFileNameSegment = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80);

const columnName = (index) => {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const xlsxCell = (rowNumber, colIndex, value, styleId = 0) => {
  const ref = `${columnName(colIndex)}${rowNumber}`;
  const styleAttr = styleId ? ` s="${styleId}"` : '';
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
};

const toIsoDate = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const dmY = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmY) return `${dmY[3]}-${dmY[2]}-${dmY[1]}`;
  return '';
};

const diffDaysSigned = (from, to) => {
  const a = toIsoDate(from);
  const b = toIsoDate(to);
  if (!a || !b) return 0;
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000);
};

const normalizeStageTasksForExport = (tasks) => {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task) => {
    if (typeof task === 'string') {
      return { text: task, plannedDate: '', completedAt: '', planStart: '', planEnd: '', factStart: '', factEnd: '', done: false };
    }
    const planStart = String(task?.planStart || task?.plannedDate || task?.startDate || '');
    const planEnd = String(task?.planEnd || task?.plannedEnd || task?.plannedDate || '');
    const factStart = String(task?.factStart || task?.actualStart || '');
    const factEnd = String(task?.factEnd || task?.completedAt || task?.endDate || '');
    return {
      text: String(task?.text || ''),
      plannedDate: planStart,
      completedAt: factEnd,
      planStart,
      planEnd,
      factStart,
      factEnd,
      done: !!task?.done
    };
  });
};

const getDeadlineExportLabel = (plannedRaw, actualRaw, label = 'Стан') => {
  const planned = toIsoDate(plannedRaw);
  const actual = toIsoDate(actualRaw);
  if (!planned) return `${label}: без дедлайну`;
  if (actual) {
    const diff = diffDaysSigned(planned, actual);
    if (diff < 0) return `${label}: з опереженням на ${Math.abs(diff)} дн.`;
    if (diff > 0) return `${label}: пізніше на ${diff} дн.`;
    return `${label}: день у день`;
  }
  const today = new Date().toISOString().slice(0, 10);
  const until = diffDaysSigned(today, planned);
  if (until < 0) return `${label}: прострочено на ${Math.abs(until)} дн.`;
  if (until === 0) return `${label}: дедлайн сьогодні`;
  return `${label}: залишилось ${until} дн.`;
};

const getProjectTaskTimingExportLabel = (task) => getDeadlineExportLabel(task?.dueAt, task?.completedAt, 'Задача');

const parseNumberString = (value) => {
  const raw = String(value || '').replace(/\s+/g, '').replace(',', '.').trim();
  const num = Number.parseFloat(raw);
  return Number.isFinite(num) ? String(num) : '';
};

const getSpecCell = (row, index) => String(row?.[index] || '').replace(/\s+/g, ' ').trim();

const isSpecQtyValue = (value) => /^\d+(?:[.,]\d+)?$/.test(String(value || '').replace(/\s+/g, '').trim());

const normalizeSpecificationItem = (item, index = 0) => {
  const currencyRaw = String(item?.currency || 'UAH').trim().toUpperCase();
  const sourceRaw = String(item?.source || '').trim().toLowerCase();
  const statusRaw = String(item?.status || '').trim().toLowerCase();
  const id = String(item?.id || ('spec_' + Date.now() + '_' + index + '_' + Math.random().toString(36).slice(2, 7))).trim();
  return {
    id,
    name: String(item?.name || '').trim().slice(0, 500),
    typeMark: String(item?.typeMark || '').trim().slice(0, 240),
    code: String(item?.code || '').trim().slice(0, 160),
    manufacturer: String(item?.manufacturer || '').trim().slice(0, 180),
    country: String(item?.country || '').trim().slice(0, 120),
    unit: String(item?.unit || '').trim().slice(0, 60),
    qty: parseNumberString(item?.qty),
    source: sourceRaw === 'stock' || sourceRaw === 'order' ? sourceRaw : '',
    orderEntity: String(item?.orderEntity || '').trim().slice(0, 240),
    currency: currencyRaw === 'USD' || currencyRaw === 'EUR' ? currencyRaw : 'UAH',
    unitPrice: parseNumberString(item?.unitPrice),
    exchangeRate: parseNumberString(item?.exchangeRate),
    vat: item?.vat === true || String(item?.vat || '').toLowerCase() === 'true',
    reinvoice: item?.reinvoice === true || String(item?.reinvoice || '').toLowerCase() === 'true',
    note: String(item?.note || '').trim().slice(0, 500),
    status: ['new', 'ordered', 'received', 'stock'].includes(statusRaw) ? statusRaw : 'new'
  };
};

const normalizeSpecificationItems = (items) => (
  (Array.isArray(items) ? items : [])
    .map((item, index) => normalizeSpecificationItem(item, index))
    .filter((item) => item.name || item.typeMark || item.code)
    .slice(0, 1000)
);

const parseSpecificationItemsFromXlsx = (filePath) => {
  const rows = parseXlsxRows(filePath);
  const items = [];
  rows.forEach((row, index) => {
    const name = getSpecCell(row, 2);
    const typeMark = getSpecCell(row, 3);
    const code = getSpecCell(row, 4);
    const manufacturer = getSpecCell(row, 5);
    const country = getSpecCell(row, 6);
    const unit = getSpecCell(row, 7);
    const qty = getSpecCell(row, 8);
    const note = getSpecCell(row, 10) || getSpecCell(row, 9);
    const unitPrice = getSpecCell(row, 11);
    const joined = row.map((cell) => String(cell || '').toLowerCase()).join(' ');
    if (!name || !isSpecQtyValue(qty)) return;
    if (/найменування|обладнання, матеріалу|к-сть|позиція/.test(joined)) return;
    if (/^(всього|итого|разом|total)\b/i.test(name)) return;
    items.push(normalizeSpecificationItem({
      id: 'spec_' + Date.now() + '_' + index,
      name, typeMark, code, manufacturer, country, unit, qty,
      source: '', orderEntity: '', currency: 'UAH', unitPrice, exchangeRate: '',
      vat: false, reinvoice: false, note, status: 'new'
    }, index));
  });
  return items.slice(0, 1000);
};

const getProjectSpecificationItems = (row) => {
  try {
    const parsed = JSON.parse(String(row?.specification_items_json || '[]'));
    return normalizeSpecificationItems(parsed);
  } catch (_) {
    return [];
  }
};

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
const PROJECT_WARNING_DAYS = 3;

const getDateDiffFromToday = (dateValue) => {
  const iso = toIsoDate(dateValue);
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso + 'T00:00:00');
  if (!Number.isFinite(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
};

const hasProjectNotificationToday = ({ projectId, userId, eventType, title, body = '', taskId = null, stageId = null }) => {
  const row = db.central.prepare(`
    SELECT 1
    FROM project_notifications
    WHERE project_id = ?
      AND user_id = ?
      AND event_type = ?
      AND title = ?
      AND COALESCE(body, '') = ?
      AND COALESCE(related_task_id, 0) = ?
      AND COALESCE(related_stage_id, 0) = ?
      AND DATE(created_at) = DATE('now')
    LIMIT 1
  `).get(
    Number(projectId),
    Number(userId),
    String(eventType || ''),
    String(title || ''),
    String(body || ''),
    Number.isFinite(Number(taskId)) ? Number(taskId) : 0,
    Number.isFinite(Number(stageId)) ? Number(stageId) : 0
  );
  return !!row;
};

const createProjectNotificationOnceToday = (payload) => {
  if (hasProjectNotificationToday(payload)) return;
  createProjectNotification(payload);
};

const buildDeadlineAlert = ({ project, userId, scopeTitle, dueDate, done, taskId = null, stageId = null }) => {
  if (done) return null;
  const daysLeft = getDateDiffFromToday(dueDate);
  if (daysLeft == null) return null;
  const projectName = project.title || project.number || ('Проєкт #' + project.id);
  const dateLabel = toIsoDate(dueDate) || String(dueDate || '');
  if (daysLeft < 0) {
    const title = 'Прострочено строк по проєкту';
    const body = projectName + '\n' + scopeTitle + '\nПлановий строк: ' + dateLabel + '\nПрострочено на ' + Math.abs(daysLeft) + ' дн.';
    return { projectId: project.id, userId, actorUserId: null, eventType: 'deadline_overdue', title, body, taskId, stageId };
  }
  if (daysLeft <= PROJECT_WARNING_DAYS) {
    const title = 'Скоро закінчується строк по проєкту';
    const body = projectName + '\n' + scopeTitle + '\nПлановий строк: ' + dateLabel + '\nЗалишилось ' + daysLeft + ' дн.';
    return { projectId: project.id, userId, actorUserId: null, eventType: 'deadline_soon', title, body, taskId, stageId };
  }
  return null;
};

const generateProjectDeadlineNotificationsForUser = (userId) => {
  const projects = db.central.prepare(`
    SELECT DISTINCT p.id, p.number, p.title, p.status, p.plan_end, p.fact_end
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id
    WHERE pm.user_id = ?
  `).all(userId);

  for (const project of projects) {
    const projectDone = ['done', 'cancelled'].includes(String(project.status || '').toLowerCase()) || !!project.fact_end;
    const projectAlert = buildDeadlineAlert({ project, userId, scopeTitle: 'Загальний дедлайн проєкту', dueDate: project.plan_end, done: projectDone });
    if (projectAlert) createProjectNotificationOnceToday(projectAlert);

    const stages = getProjectStages(project.id);
    for (const stage of stages) {
      const stageStatus = String(stage.status || '').toLowerCase();
      const stageDone = projectDone || stageStatus === 'done' || stageStatus === 'skipped' || !!stage.factEnd;
      const stageAlert = buildDeadlineAlert({
        project, userId, scopeTitle: 'Етап: ' + (stage.name || 'Без назви'), dueDate: stage.planEnd || stage.planDate, done: stageDone, stageId: stage.id
      });
      if (stageAlert) createProjectNotificationOnceToday(stageAlert);

      const startDaysLeft = stageDone || stage.factStart ? null : getDateDiffFromToday(stage.planStart || stage.planDate);
      if (startDaysLeft != null && startDaysLeft < 0) {
        createProjectNotificationOnceToday({
          projectId: project.id,
          userId,
          actorUserId: null,
          eventType: 'deadline_overdue',
          title: 'Прострочено старт етапу',
          body: (project.title || project.number || ('Проєкт #' + project.id)) + '\nЕтап: ' + (stage.name || 'Без назви') + '\nПлановий старт: ' + toIsoDate(stage.planStart || stage.planDate) + '\nПрострочено на ' + Math.abs(startDaysLeft) + ' дн.',
          stageId: stage.id
        });
      }

      normalizeStageTasksForExport(stage.stageTasks).forEach((task, index) => {
        const taskDone = stageDone || !!task.done || !!task.factEnd || !!task.completedAt;
        const taskName = task.text || ('Підетап #' + (index + 1));
        const taskAlert = buildDeadlineAlert({
          project, userId, scopeTitle: 'Підетап: ' + (stage.name || 'Етап') + ' / ' + taskName, dueDate: task.planEnd || task.plannedDate, done: taskDone, stageId: stage.id
        });
        if (taskAlert) createProjectNotificationOnceToday(taskAlert);
      });
    }

    const tasks = getProjectTasks(project.id);
    for (const task of tasks) {
      const taskAlert = buildDeadlineAlert({
        project, userId, scopeTitle: 'Задача: ' + (task.title || 'Без назви'), dueDate: task.dueAt, done: projectDone || task.status === 'done' || !!task.completedAt, taskId: task.id
      });
      if (taskAlert) createProjectNotificationOnceToday(taskAlert);
    }
  }
};

const getProjectFinanceEntries = (projectId) => (
  db.central.prepare(`
    SELECT id, project_id, entry_type, amount, currency, usd_rate, payment_method, payment_date, note, created_by_user_id, created_at, updated_at
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
    paymentMethod: row.payment_method || '',
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

const getProjectInvoices = (projectId) => (
  db.central.prepare(`
    SELECT pi.id, pi.project_id, pi.file_name, pi.file_path, pi.comment, pi.is_paid, pi.paid_by, pi.paid_at,
           pi.created_by_user_id, u.username AS created_by_username, pi.created_at, pi.updated_at
    FROM project_invoices pi
    LEFT JOIN users u ON u.id = pi.created_by_user_id
    WHERE pi.project_id = ?
    ORDER BY pi.created_at DESC, pi.id DESC
  `).all(projectId).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name || '',
    filePath: row.file_path || '',
    comment: row.comment || '',
    isPaid: Number(row.is_paid || 0) === 1,
    paidBy: row.paid_by || '',
    paidAt: row.paid_at || '',
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username || '',
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

const toProjectDto = (row, stages, members, financeEntries, tasks, notes, invoices = []) => ({
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
  specificationItems: getProjectSpecificationItems(row),
  specificationSourceName: row.specification_source_name || '',
  financeEntries: Array.isArray(financeEntries) ? financeEntries : [],
  tasks: Array.isArray(tasks) ? tasks : [],
  notes: Array.isArray(notes) ? notes : [],
  invoices: Array.isArray(invoices) ? invoices : [],
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
    getProjectNotes(projectId),
    getProjectInvoices(projectId)
  );
};

const buildProjectCalendarRows = (project) => {
  const rows = [];
  const add = (dateRaw, type, title, details = '') => {
    const date = toIsoDate(dateRaw);
    if (!date || !title) return;
    rows.push([date, type, title, String(details || '').trim()]);
  };
  add(project.createdAt, 'Проєкт', 'Створено проєкт', project.title);
  add(project.planStart, 'Проєкт', 'Плановий старт проєкту', project.title);
  add(project.planEnd, 'Проєкт', 'Плановий дедлайн проєкту', project.title);
  add(project.factStart, 'Проєкт', 'Фактичний старт проєкту', project.title);
  add(project.factEnd, 'Проєкт', 'Фактичне завершення проєкту', project.title);
  (project.stages || []).forEach((stage) => {
    add(stage.planStart || stage.planDate, 'Етап', `Плановий старт: ${stage.name || ''}`);
    add(stage.planEnd, 'Етап', `Плановий дедлайн: ${stage.name || ''}`);
    add(stage.factStart || stage.factDate, 'Етап', `Фактичний старт: ${stage.name || ''}`);
    add(stage.factEnd, 'Етап', `Фактичне завершення: ${stage.name || ''}`);
    normalizeStageTasksForExport(stage.stageTasks).forEach((task) => {
      const taskTitle = task.text || 'Підетап без назви';
      add(task.planStart || task.plannedDate, 'Підетап', `План старту: ${taskTitle}`, stage.name || '');
      add(task.planEnd || task.plannedDate, 'Підетап', `Дедлайн: ${taskTitle}`, getDeadlineExportLabel(task.planEnd || task.plannedDate, task.factEnd || task.completedAt));
      add(task.factStart, 'Підетап', `Фактичний старт: ${taskTitle}`, stage.name || '');
      add(task.factEnd || task.completedAt, 'Підетап', `Виконано: ${taskTitle}`, getDeadlineExportLabel(task.planEnd || task.plannedDate, task.factEnd || task.completedAt));
    });
  });
  (project.tasks || []).forEach((task) => {
    const taskTitle = task.title || 'Задача без назви';
    add(task.startAt, 'Задача', `Старт задачі: ${taskTitle}`, task.assignedUsername || '');
    add(task.dueAt, 'Задача', `Дедлайн задачі: ${taskTitle}`, getProjectTaskTimingExportLabel(task));
    add(task.completedAt, 'Задача', `Виконано задачу: ${taskTitle}`, getProjectTaskTimingExportLabel(task));
    add(task.remindAt, 'Задача', `Telegram-нагадування: ${taskTitle}`, task.assignedUsername || '');
  });
  (project.financeEntries || []).forEach((entry) => {
    add(entry.paymentDate || entry.createdAt, 'Фінанси', `${entry.type === 'expense' ? 'Витрата' : 'Дохід'}: ${entry.amount || 0} ${entry.currency || 'UAH'}`, entry.note || '');
  });
  (project.notes || []).forEach((note) => {
    add(note.createdAt, 'Нотатка', String(note.body || '').slice(0, 120), note.createdByUsername || '');
  });
  return rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
};

const buildProjectExportXlsx = (project) => {
  const safe = (value) => String(value ?? '').trim();
  const tasks = project.tasks || [];
  const stages = project.stages || [];
  const stageTaskRows = stages.flatMap((stage, stageIndex) => (
    normalizeStageTasksForExport(stage.stageTasks).map((task, taskIndex) => [
      String(stageIndex + 1),
      stage.name || '',
      String(taskIndex + 1),
      task.text || '',
      task.planStart || task.plannedDate || '',
      task.planEnd || task.plannedDate || '',
      task.factStart || '',
      task.factEnd || task.completedAt || '',
      task.done ? 'Так' : 'Ні',
      getDeadlineExportLabel(task.planEnd || task.plannedDate, task.factEnd || task.completedAt)
    ])
  ));
  const taskTimingRows = tasks.map((task, index) => [
    String(index + 1),
    task.title || '',
    task.description || '',
    task.status || '',
    task.assignedUsername || '',
    task.startAt || '',
    task.dueAt || '',
    task.completedAt || '',
    getProjectTaskTimingExportLabel(task),
    task.remindAt || '',
    task.createdByUsername || ''
  ]);
  const aheadCount = [
    ...stageTaskRows.filter((row) => String(row[9] || '').includes('опереження')),
    ...taskTimingRows.filter((row) => String(row[8] || '').includes('опереження'))
  ].length;
  const overdueCount = [
    ...stageTaskRows.filter((row) => String(row[9] || '').includes('прострочено') || String(row[9] || '').includes('пізніше')),
    ...taskTimingRows.filter((row) => String(row[8] || '').includes('прострочено') || String(row[8] || '').includes('пізніше'))
  ].length;
  const sheets = [
    {
      name: 'Проєкт',
      rows: [
        ['Поле', 'Значення'],
        ['ID', safe(project.id)],
        ['Номер', safe(project.number)],
        ['Назва', safe(project.title)],
        ['Клієнт', safe(project.clientName)],
        ['Тип', safe(project.type)],
        ['Потужність, кВт', safe(project.powerKw)],
        ['Відповідальний', safe(project.owner)],
        ['Статус', safe(project.status)],
        ['Плановий старт', safe(project.planStart)],
        ['Плановий дедлайн', safe(project.planEnd)],
        ['Фактичний старт', safe(project.factStart)],
        ['Фактичне завершення', safe(project.factEnd)],
        ['Причина затримки', safe(project.delayReason)],
        ['Створено', safe(project.createdAt)],
        ['Оновлено', safe(project.updatedAt)]
      ]
    },
    {
      name: 'Етапи',
      rows: [
        ['№', 'Назва', 'Статус', 'План старт', 'План дедлайн', 'Факт старт', 'Факт завершення', 'План нотатки', 'Факт нотатки'],
        ...stages.map((stage, index) => [
          String(index + 1), stage.name || '', stage.status || '', stage.planStart || stage.planDate || '',
          stage.planEnd || '', stage.factStart || stage.factDate || '', stage.factEnd || '', stage.planNotes || '', stage.factNotes || ''
        ])
      ]
    },
    { name: 'Підетапи', rows: [['Етап №', 'Етап', 'Підетап №', 'Назва', 'План старт', 'План дедлайн', 'Факт старт', 'Факт завершення', 'Виконано', 'Стан'], ...stageTaskRows] },
    { name: 'Календар', rows: [['Дата', 'Тип', 'Відмітка', 'Деталі'], ...buildProjectCalendarRows(project)] },
    {
      name: 'Фінанси',
      rows: [
        ['Тип', 'Сума', 'Валюта', 'Курс USD/UAH', 'Метод оплати', 'Дата', 'Примітка', 'Створено'],
        ...(project.financeEntries || []).map((entry) => [
          entry.type === 'expense' ? 'Витрата' : 'Дохід', entry.amount || '', entry.currency || 'UAH',
          entry.usdRate || '', entry.paymentMethod || '', entry.paymentDate || '', entry.note || '', entry.createdAt || ''
        ])
      ]
    },
    { name: 'Задачі', rows: [['№', 'Назва', 'Опис', 'Статус', 'Відповідальний', 'Старт', 'Дедлайн', 'Виконано', 'Стан', 'Нагадування', 'Автор'], ...taskTimingRows] },
    {
      name: 'Нотатки',
      rows: [['Дата', 'Автор', 'Нотатка'], ...(project.notes || []).map((note) => [note.createdAt || '', note.createdByUsername || '', note.body || ''])]
    },
    {
      name: 'Доступ',
      rows: [['Користувач', 'Роль', 'Додано'], ...(project.members || []).map((member) => [member.username || '', member.role || '', member.createdAt || ''])]
    },
    {
      name: 'Підсумок',
      rows: [
        ['Показник', 'Значення'],
        ['Кількість етапів', String(stages.length)],
        ['Кількість підетапів', String(stageTaskRows.length)],
        ['Кількість задач', String(tasks.length)],
        ['Прострочки / пізніше', String(overdueCount)],
        ['Виконано з опереженням', String(aheadCount)],
        ['Фінансових операцій', String((project.financeEntries || []).length)],
        ['Нотаток', String((project.notes || []).length)]
      ]
    }
  ];

  const zip = new AdmZip();
  const sheetOverrides = sheets.map((_, index) => `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n');
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetOverrides}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, index) => `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('\n')}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`));
  zip.addFile('xl/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`));
  sheets.forEach((sheet, sheetIndex) => {
    const sheetData = sheet.rows.map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const styleId = rowIndex === 0 ? 1 : 0;
      return `<row r="${rowNumber}">${row.map((value, colIndex) => xlsxCell(rowNumber, colIndex, value, styleId)).join('')}</row>`;
    }).join('');
    zip.addFile(`xl/worksheets/sheet${sheetIndex + 1}.xml`, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetData}</sheetData>
</worksheet>`));
  });
  return zip.toBuffer();
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
    generateProjectDeadlineNotificationsForUser(req.userId);
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
      getProjectNotes(row.id),
      getProjectInvoices(row.id)
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
          planStart: '',
          planEnd: '',
          factStart: '',
          factEnd: '',
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

router.post('/:id/specification/import', upload.single('file'), (req, res) => {
  let uploadedPath = req.file?.path || '';
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    if (!req.file) return res.status(400).json({ error: 'Завантажте Excel-файл специфікації' });
    const originalName = req.file.originalname || 'specification.xlsx';
    const ext = path.extname(originalName || '').toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xlsm') {
      return res.status(400).json({ error: 'Поки підтримується тільки .xlsx / .xlsm' });
    }
    const items = parseSpecificationItemsFromXlsx(req.file.path);
    db.central.prepare('UPDATE projects SET specification_items_json = ?, specification_source_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(items), originalName, projectId);
    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ project, importedCount: items.length });
  } catch (error) {
    console.error('projects specification import error:', error);
    return res.status(500).json({ error: 'Не вдалося імпортувати специфікацію' });
  } finally {
    if (uploadedPath) {
      try { fs.unlinkSync(uploadedPath); } catch (_) {}
    }
  }
});

router.patch('/:id/specification', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    const items = normalizeSpecificationItems(req.body?.items);
    const sourceName = Object.prototype.hasOwnProperty.call(req.body || {}, 'sourceName')
      ? String(req.body?.sourceName || '').trim().slice(0, 240)
      : current.specification_source_name;
    db.central.prepare('UPDATE projects SET specification_items_json = ?, specification_source_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(items), sourceName || null, projectId);
    const project = loadProjectForUser(projectId, req.userId);
    return res.json({ project });
  } catch (error) {
    console.error('projects specification patch error:', error);
    return res.status(500).json({ error: 'Не вдалося зберегти специфікацію' });
  }
});

router.get('/:id/export.xlsx', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const project = loadProjectForUser(projectId, req.userId);
    if (!project) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    const buffer = buildProjectExportXlsx(project);
    const fileName = `Проєкт ${safeFileNameSegment(project.number || project.id)} - ${safeFileNameSegment(project.title || 'експорт')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    return res.send(buffer);
  } catch (error) {
    console.error('projects export xlsx error:', error);
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
    const paymentMethodRaw = String(req.body?.paymentMethod || '').trim().toLowerCase();
    const paymentMethod = paymentMethodRaw === 'cash' || paymentMethodRaw === 'cashless' ? paymentMethodRaw : null;
    const usdRateRaw = String(req.body?.usdRate || '').trim().replace(',', '.');
    const usdRateNum = Number.parseFloat(usdRateRaw);
    const usdRate = Number.isFinite(usdRateNum) && usdRateNum > 0 ? String(usdRateNum) : null;
    const note = String(req.body?.note || '').trim();
    const now = new Date().toISOString();

    db.central.prepare(`
      INSERT INTO project_finance_entries
      (project_id, entry_type, amount, currency, usd_rate, payment_method, payment_date, note, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      type,
      String(amountNum),
      currency,
      usdRate,
      paymentMethod,
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

router.post('/:id/invoices', upload.single('file'), (req, res) => {
  let tempPath = req.file?.path || '';
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    if (!req.file) return res.status(400).json({ error: 'Завантажте файл рахунку або накладної' });

    const originalName = decodeMultipartFileName(req.file.originalname || 'invoice.bin');
    const target = buildProjectInvoiceFileTarget(projectId, originalName);
    fs.renameSync(req.file.path, target.diskPath);
    tempPath = '';
    saveProjectInvoiceRecord({
      projectId,
      fileName: originalName,
      filePath: target.publicPath,
      comment: String(req.body?.comment || '').trim(),
      isPaid: String(req.body?.isPaid || '').toLowerCase() === 'true' || String(req.body?.isPaid || '') === '1',
      paidBy: String(req.body?.paidBy || '').trim(),
      paidAt: String(req.body?.paidAt || '').trim(),
      userId: req.userId
    });
    return res.status(201).json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects invoice create error:', error);
    return res.status(500).json({ error: 'Не вдалося додати рахунок' });
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
});

router.post('/:id/invoices/from-upload', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'Некоректний ID проєкту' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });

    const sourcePath = String(req.body?.mediaPath || req.body?.filePath || '').trim();
    const source = normalizeUploadPublicPath(sourcePath);
    if (!source || !fs.existsSync(source.diskPath)) return res.status(400).json({ error: 'Файл з чату не знайдено на сервері' });

    const originalName = decodeMultipartFileName(String(req.body?.mediaName || req.body?.fileName || path.basename(source.diskPath) || 'invoice.bin'));
    const target = buildProjectInvoiceFileTarget(projectId, originalName);
    fs.copyFileSync(source.diskPath, target.diskPath);
    saveProjectInvoiceRecord({
      projectId,
      fileName: originalName,
      filePath: target.publicPath,
      comment: String(req.body?.comment || '').trim(),
      isPaid: String(req.body?.isPaid || '').toLowerCase() === 'true' || String(req.body?.isPaid || '') === '1',
      paidBy: String(req.body?.paidBy || '').trim(),
      paidAt: String(req.body?.paidAt || '').trim(),
      userId: req.userId
    });
    return res.status(201).json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects invoice from upload error:', error);
    return res.status(500).json({ error: 'Не вдалося додати файл з чату до проєкту' });
  }
});

router.patch('/:projectId/invoices/:invoiceId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const invoiceId = Number.parseInt(req.params.invoiceId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(invoiceId)) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    const existing = db.central.prepare('SELECT id FROM project_invoices WHERE id = ? AND project_id = ?').get(invoiceId, projectId);
    if (!existing) return res.status(404).json({ error: 'Рахунок не знайдено' });
    const sets = [];
    const values = [];
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'comment')) { sets.push('comment = ?'); values.push(String(req.body?.comment || '').trim() || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'isPaid')) { sets.push('is_paid = ?'); values.push(req.body?.isPaid ? 1 : 0); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'paidBy')) { sets.push('paid_by = ?'); values.push(String(req.body?.paidBy || '').trim() || null); }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'paidAt')) { sets.push('paid_at = ?'); values.push(String(req.body?.paidAt || '').trim() || null); }
    if (!sets.length) return res.json({ project: loadProjectForUser(projectId, req.userId) });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(invoiceId, projectId);
    db.central.prepare(`UPDATE project_invoices SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`).run(...values);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return res.json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects invoice patch error:', error);
    return res.status(500).json({ error: 'Не вдалося оновити рахунок' });
  }
});

router.delete('/:projectId/invoices/:invoiceId', (req, res) => {
  try {
    const projectId = Number.parseInt(req.params.projectId, 10);
    const invoiceId = Number.parseInt(req.params.invoiceId, 10);
    if (!Number.isFinite(projectId) || !Number.isFinite(invoiceId)) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = getAccessibleProjectRow(projectId, req.userId);
    if (!current) return res.status(404).json({ error: 'Проєкт не знайдено або доступ заборонено' });
    const existing = db.central.prepare('SELECT file_path FROM project_invoices WHERE id = ? AND project_id = ?').get(invoiceId, projectId);
    if (!existing) return res.status(404).json({ error: 'Рахунок не знайдено' });
    db.central.prepare('DELETE FROM project_invoices WHERE id = ? AND project_id = ?').run(invoiceId, projectId);
    db.central.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    deletePublicUploadFile(existing.file_path);
    return res.json({ project: loadProjectForUser(projectId, req.userId) });
  } catch (error) {
    console.error('projects invoice delete error:', error);
    return res.status(500).json({ error: 'Не вдалося видалити рахунок' });
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
