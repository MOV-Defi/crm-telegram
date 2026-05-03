const express = require('express');
const db = require('../db');

const router = express.Router();

const getOwnerUsername = () => String(process.env.DOC_TEMPLATES_OWNER || '').trim().toLowerCase();
const isOwner = (req) => {
  const owner = getOwnerUsername();
  const current = String(req.username || '').trim().toLowerCase();
  if (!owner) return req.userRole === 'admin';
  return current === owner;
};

const restrictToOwner = (req, res, next) => {
  if (!isOwner(req)) {
    return res.status(403).json({ error: 'Тільки власник бібліотеки може редагувати шаблони' });
  }
  next();
};

router.get('/permissions', (req, res) => {
  res.json({ canManage: isOwner(req) });
});

const normalizeSortOrder = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const normalizeUrl = (value) => String(value || '').trim();

router.get('/categories', (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '') === '1';
    const rows = includeInactive
      ? db.central.prepare(`
          SELECT id, name, sort_order, is_active, created_at
          FROM document_template_categories
          ORDER BY sort_order ASC, id ASC
        `).all()
      : db.central.prepare(`
          SELECT id, name, sort_order, is_active, created_at
          FROM document_template_categories
          WHERE is_active = 1
          ORDER BY sort_order ASC, id ASC
        `).all();

    res.json(rows.map((row) => ({
      ...row,
      is_active: Number(row.is_active) === 1
    })));
  } catch (error) {
    console.error('documents/categories GET error:', error);
    res.status(500).json({ error: 'Не вдалося отримати категорії документів' });
  }
});

router.post('/categories', restrictToOwner, (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, 0);

    if (!name) {
      return res.status(400).json({ error: 'Назва категорії обовʼязкова' });
    }

    const existing = db.central.prepare('SELECT id FROM document_template_categories WHERE lower(name) = lower(?) LIMIT 1').get(name);
    if (existing) {
      return res.status(409).json({ error: 'Категорія з такою назвою вже існує' });
    }

    const result = db.central.prepare(`
      INSERT INTO document_template_categories (name, sort_order, is_active)
      VALUES (?, ?, 1)
    `).run(name, sortOrder);

    const saved = db.central.prepare(`
      SELECT id, name, sort_order, is_active, created_at
      FROM document_template_categories
      WHERE id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ ...saved, is_active: Number(saved.is_active) === 1 });
  } catch (error) {
    console.error('documents/categories POST error:', error);
    res.status(500).json({ error: 'Не вдалося створити категорію' });
  }
});

router.put('/categories/:id', restrictToOwner, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Некоректний ID категорії' });
    }

    const current = db.central.prepare('SELECT id, name, sort_order, is_active FROM document_template_categories WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ error: 'Категорію не знайдено' });
    }

    const nextName = req.body?.name == null ? current.name : String(req.body.name).trim();
    const nextSortOrder = req.body?.sortOrder == null ? current.sort_order : normalizeSortOrder(req.body.sortOrder, current.sort_order);
    const nextActive = req.body?.isActive == null ? current.is_active : (req.body.isActive ? 1 : 0);

    if (!nextName) {
      return res.status(400).json({ error: 'Назва категорії обовʼязкова' });
    }

    const duplicate = db.central.prepare('SELECT id FROM document_template_categories WHERE lower(name) = lower(?) AND id <> ? LIMIT 1').get(nextName, id);
    if (duplicate) {
      return res.status(409).json({ error: 'Категорія з такою назвою вже існує' });
    }

    db.central.prepare(`
      UPDATE document_template_categories
      SET name = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `).run(nextName, nextSortOrder, nextActive, id);

    const saved = db.central.prepare('SELECT id, name, sort_order, is_active, created_at FROM document_template_categories WHERE id = ?').get(id);
    res.json({ ...saved, is_active: Number(saved.is_active) === 1 });
  } catch (error) {
    console.error('documents/categories PUT error:', error);
    res.status(500).json({ error: 'Не вдалося оновити категорію' });
  }
});

router.delete('/categories/:id', restrictToOwner, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Некоректний ID категорії' });
    }

    const existing = db.central.prepare('SELECT id FROM document_template_categories WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Категорію не знайдено' });
    }

    db.central.prepare('DELETE FROM document_template_categories WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    console.error('documents/categories DELETE error:', error);
    res.status(500).json({ error: 'Не вдалося видалити категорію' });
  }
});

router.get('/templates', (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || '') === '1';
    const rows = includeInactive
      ? db.central.prepare(`
          SELECT
            t.id,
            t.category_id,
            c.name AS category_name,
            t.title,
            t.description,
            t.file_url,
            t.sort_order,
            t.is_active,
            t.created_at
          FROM document_templates t
          JOIN document_template_categories c ON c.id = t.category_id
          ORDER BY c.sort_order ASC, c.id ASC, t.sort_order ASC, t.id ASC
        `).all()
      : db.central.prepare(`
          SELECT
            t.id,
            t.category_id,
            c.name AS category_name,
            t.title,
            t.description,
            t.file_url,
            t.sort_order,
            t.is_active,
            t.created_at
          FROM document_templates t
          JOIN document_template_categories c ON c.id = t.category_id
          WHERE t.is_active = 1 AND c.is_active = 1
          ORDER BY c.sort_order ASC, c.id ASC, t.sort_order ASC, t.id ASC
        `).all();

    res.json(rows.map((row) => ({
      ...row,
      is_active: Number(row.is_active) === 1
    })));
  } catch (error) {
    console.error('documents/templates GET error:', error);
    res.status(500).json({ error: 'Не вдалося отримати шаблони документів' });
  }
});

router.post('/templates', restrictToOwner, (req, res) => {
  try {
    const rawCategoryValue = String(req.body?.categoryId ?? '').trim();
    const categoryId = Number.parseInt(rawCategoryValue, 10);
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const fileUrl = normalizeUrl(req.body?.fileUrl);
    const sortOrder = normalizeSortOrder(req.body?.sortOrder, 0);

    if (!title) return res.status(400).json({ error: 'Назва шаблону обовʼязкова' });
    if (!fileUrl) return res.status(400).json({ error: 'Посилання на документ обовʼязкове' });

    let category = null;
    if (Number.isFinite(categoryId)) {
      category = db.central.prepare('SELECT id FROM document_template_categories WHERE id = ?').get(categoryId);
    }
    if (!category && rawCategoryValue) {
      category = db.central.prepare('SELECT id FROM document_template_categories WHERE lower(name) = lower(?)').get(rawCategoryValue);
    }
    if (!category) return res.status(400).json({ error: 'Вказана категорія не існує' });

    const result = db.central.prepare(`
      INSERT INTO document_templates (category_id, title, description, file_url, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(category.id, title, description || null, fileUrl, sortOrder);

    const saved = db.central.prepare(`
      SELECT
        t.id,
        t.category_id,
        c.name AS category_name,
        t.title,
        t.description,
        t.file_url,
        t.sort_order,
        t.is_active,
        t.created_at
      FROM document_templates t
      JOIN document_template_categories c ON c.id = t.category_id
      WHERE t.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ ...saved, is_active: Number(saved.is_active) === 1 });
  } catch (error) {
    console.error('documents/templates POST error:', error);
    res.status(500).json({ error: 'Не вдалося створити шаблон документа' });
  }
});

router.put('/templates/:id', restrictToOwner, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID шаблону' });

    const current = db.central.prepare('SELECT * FROM document_templates WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Шаблон не знайдено' });

    const categoryId = req.body?.categoryId == null
      ? current.category_id
      : Number.parseInt(req.body.categoryId, 10);
    const title = req.body?.title == null ? current.title : String(req.body.title || '').trim();
    const description = req.body?.description == null ? String(current.description || '') : String(req.body.description || '').trim();
    const fileUrl = req.body?.fileUrl == null ? String(current.file_url || '') : normalizeUrl(req.body.fileUrl);
    const sortOrder = req.body?.sortOrder == null ? current.sort_order : normalizeSortOrder(req.body.sortOrder, current.sort_order);
    const isActive = req.body?.isActive == null ? current.is_active : (req.body.isActive ? 1 : 0);

    if (!Number.isFinite(categoryId)) return res.status(400).json({ error: 'Оберіть категорію' });
    if (!title) return res.status(400).json({ error: 'Назва шаблону обовʼязкова' });
    if (!fileUrl) return res.status(400).json({ error: 'Посилання на документ обовʼязкове' });

    const category = db.central.prepare('SELECT id FROM document_template_categories WHERE id = ?').get(categoryId);
    if (!category) return res.status(400).json({ error: 'Вказана категорія не існує' });

    db.central.prepare(`
      UPDATE document_templates
      SET category_id = ?, title = ?, description = ?, file_url = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `).run(categoryId, title, description || null, fileUrl, sortOrder, isActive, id);

    const saved = db.central.prepare(`
      SELECT
        t.id,
        t.category_id,
        c.name AS category_name,
        t.title,
        t.description,
        t.file_url,
        t.sort_order,
        t.is_active,
        t.created_at
      FROM document_templates t
      JOIN document_template_categories c ON c.id = t.category_id
      WHERE t.id = ?
    `).get(id);

    res.json({ ...saved, is_active: Number(saved.is_active) === 1 });
  } catch (error) {
    console.error('documents/templates PUT error:', error);
    res.status(500).json({ error: 'Не вдалося оновити шаблон документа' });
  }
});

router.delete('/templates/:id', restrictToOwner, (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID шаблону' });

    const existing = db.central.prepare('SELECT id FROM document_templates WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Шаблон не знайдено' });

    db.central.prepare('DELETE FROM document_templates WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    console.error('documents/templates DELETE error:', error);
    res.status(500).json({ error: 'Не вдалося видалити шаблон документа' });
  }
});

module.exports = router;
