const express = require('express');
const db = require('../db');
const runtimePaths = require('../runtime-paths');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { parseWarehouseItemsFromFile } = require('../warehouse-file-items');

const router = express.Router();
const upload = multer({ dest: runtimePaths.mediaDir });

const VIEW_KEY = 'can_view_warehouse_orders';
const EDIT_KEY = 'can_edit_warehouse_orders';
const LEGACY_MANAGE_KEY = 'can_manage_warehouse_orders';
const STATUS_SET = new Set(['new', 'in_progress', 'ready', 'issued', 'rejected']);
const REQUEST_TYPE_SET = new Set(['reservation', 'issuance']);
const ITEM_STATUS_SET = new Set(['pending', 'available', 'missing', 'partial', 'replacement']);
const PROJECT_RE = /про(?:е|є)кт\s*[:\-]?\s*["«]?([^"\n»]+)["»]?/i;
const TEXT_QTY_UNIT_PATTERN = 'шт\\.?|штук|м\\.?\\s*п\\.?|мп|м²|м2|пог\\.?\\s*м\\.?|м|кг|компл\\.?|упак\\.?|pcs';

const normalizeTextUnit = (unit) => String(unit || '').replace(/\s+/g, '').trim();

const parseWarehouseTextItemLine = (line, id = '') => {
  const cleaned = String(line || '')
    .replace(/^\d+[\).\s-]+/, '')
    .replace(/^[-•]\s*/, '')
    .replace(/^["'“”„«»]+/, '')
    .replace(/["'“”„«»]+$/, '')
    .trim();

  const parts = cleaned.split(/\s*[|;\t]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return {
      id,
      name: parts[0],
      code: parts[1],
      requestedQty: parts[2],
      unit: normalizeTextUnit(parts[3] || '')
    };
  }

  const dashQtyMatch = cleaned.match(new RegExp(`^(.+?)\\s*[-–—]\\s*(\\d+(?:[,.]\\d+)?)\\s*(${TEXT_QTY_UNIT_PATTERN})?(?:\\b|\\s|$)(?:.*)?$`, 'i'));
  const endQtyMatch = cleaned.match(new RegExp(`^(.+?)\\s+(\\d+(?:[,.]\\d+)?)\\s*(${TEXT_QTY_UNIT_PATTERN})\\s*$`, 'i'));
  const qtyMatch = dashQtyMatch || endQtyMatch;
  const name = qtyMatch?.[1]?.trim() || cleaned;

  return {
    id,
    name: name.replace(/\s*[-–—]\s*$/, '').trim(),
    requestedQty: qtyMatch?.[2] || '',
    unit: normalizeTextUnit(qtyMatch?.[3] || '')
  };
};

const decodeMultipartFileName = (name) => {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (!/[ÐÑ]/.test(raw)) return raw;
  try {
    const repaired = Buffer.from(raw, 'latin1').toString('utf8').trim();
    if (!repaired) return raw;
    if (/[\p{Script=Cyrillic}\p{L}\p{N}]/u.test(repaired)) return repaired;
    return raw;
  } catch (_) {
    return raw;
  }
};

const mediaPublicPathToFilePath = (mediaPath) => {
  const value = String(mediaPath || '').trim();
  const prefix = '/uploads/media/';
  if (!value.startsWith(prefix)) return '';
  const fileName = path.basename(value.slice(prefix.length));
  return path.join(runtimePaths.mediaDir, fileName);
};

const normalizeOrderRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  let items = [];
  try {
    const parsed = JSON.parse(String(row.items_json || '[]'));
    items = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    items = [];
  }
  const hasLegacyFlatItems = items.some((item) => (
    String(item?.name || '').includes(' | ') &&
    !String(item?.code || '').trim() &&
    !String(item?.requestedQty || item?.qty || '').trim()
  ));
  if (items.length === 0 || hasLegacyFlatItems) {
    const fileItems = parseWarehouseItemsFromFile(mediaPublicPathToFilePath(row.media_path), row.media_name);
    const parsedItems = fileItems.length > 0
      ? normalizeOrderItems(fileItems.map((item, index) => ({ id: `item-${index + 1}`, ...item })))
      : parseOrderItemsFromText(extractWarehouseItemsText(row.message_text || ''));
    items = items.length > 0 ? mergeOrderItems(items, parsedItems) : parsedItems;
  }
  return {
    ...row,
    media_name: decodeMultipartFileName(row.media_name),
    object_name: row.object_name || row.project_name || '',
    manager_name: row.manager_name || '',
    request_type: REQUEST_TYPE_SET.has(String(row.request_type || '').trim()) ? String(row.request_type).trim() : 'issuance',
    items
  };
};

const normalizeOrderItems = (items = []) => (
  (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const rawName = String(item?.name || item?.text || item?.itemName || '').trim();
      const parsedName = parseWarehouseTextItemLine(rawName, String(item?.id || `item-${index + 1}`));
      const requestedQty = String(item?.requestedQty || item?.qty || parsedName.requestedQty || '').trim();
      const unit = String(item?.unit || parsedName.unit || '').trim();
      const name = requestedQty && parsedName.requestedQty ? parsedName.name : rawName;
      if (!name) return null;
      const status = ITEM_STATUS_SET.has(String(item?.status || '').trim()) ? String(item.status).trim() : 'available';
      return {
        id: String(item?.id || `item-${index + 1}`),
        name,
        code: String(item?.code || item?.sku || item?.article || '').trim(),
        unit,
        requestedQty,
        status,
        comment: String(item?.comment || '').trim()
      };
    })
    .filter(Boolean)
);

const parseOrderItemsFromText = (text) => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return normalizeOrderItems(lines.map((line, index) => {
    return parseWarehouseTextItemLine(line, `item-${index + 1}`);
  }));
};

const extractWarehouseItemsText = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const marker = 'Прошу зібрати товар:';
  const markerIndex = raw.toLowerCase().indexOf(marker.toLowerCase());
  const body = markerIndex >= 0 ? raw.slice(markerIndex + marker.length) : raw;
  const itemLines = [];

  for (const sourceLine of body.split(/\r?\n/)) {
    const line = sourceLine
      .trim()
      .replace(/^["'“”„«»]+/, '')
      .replace(/["'“”„«»]+$/, '')
      .trim();

    if (!line) {
      if (itemLines.length > 0) break;
      continue;
    }

    if (
      /^(прошу\s|проєкт:|проект:|тип:|видача на:|хто саме:|додатковий коментар:|дякую\.?$)/i.test(line) ||
      line.startsWith('@')
    ) {
      if (itemLines.length > 0) break;
      continue;
    }

    itemLines.push(line);
  }

  return itemLines.join('\n');
};

const mergeOrderItems = (currentItems, nextItems) => {
  const currentById = new Map(normalizeOrderItems(currentItems).map((item) => [String(item.id), item]));
  return normalizeOrderItems(nextItems).map((item, index) => {
    const previous = currentById.get(String(item.id));
    return {
      ...item,
      id: String(item.id || `item-${index + 1}`),
      code: String(item.code ?? previous?.code ?? '').trim(),
      unit: String(item.unit ?? previous?.unit ?? '').trim(),
      requestedQty: String(item.requestedQty ?? previous?.requestedQty ?? '').trim(),
      status: previous?.status || (ITEM_STATUS_SET.has(String(item.status || '').trim())
        ? String(item.status).trim()
        : 'available'),
      comment: String(previous?.comment ?? item.comment ?? '').trim()
    };
  });
};

const buildItemsFromTextOrFile = (text, mediaPath = '', mediaName = '') => {
  const fileItems = parseWarehouseItemsFromFile(mediaPublicPathToFilePath(mediaPath), mediaName);
  if (fileItems.length > 0) {
    return normalizeOrderItems(fileItems.map((item, index) => ({ id: `item-${index + 1}`, ...item })));
  }
  return parseOrderItemsFromText(text);
};

const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const safeFileNameSegment = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80);

const buildWarehouseOrderExportFileName = (order, id) => {
  const project = safeFileNameSegment(order.object_name || order.project_name || `Замовлення ${id}`);
  const manager = safeFileNameSegment(order.manager_name || '');
  return [project, 'Замовлення на склад', manager]
    .filter(Boolean)
    .join(' - ') + '.xlsx';
};

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

const warehouseItemXlsxStyleId = (status) => {
  const key = String(status || '').trim();
  if (key === 'missing') return 1;
  if (key === 'replacement') return 2;
  return 0;
};

const buildWarehouseOrderXlsx = (order) => {
  const normalized = normalizeOrderRow(order);
  const items = normalizeOrderItems(normalized.items);
  const statusLabels = {
    pending: 'Не перевірено',
    available: 'Є в наявності',
    missing: 'Немає',
    partial: 'Частково',
    replacement: 'Заміна'
  };
  const rows = [
    { values: ['Заявка складу', `#${normalized.id || ''}`] },
    { values: ['Обʼєкт', normalized.object_name || normalized.project_name || ''] },
    { values: ['Менеджер', normalized.manager_name || ''] },
    { values: ['Заявник', normalized.requester_name || normalized.created_by_username || ''] },
    { values: ['Тип заявки', normalized.request_type === 'reservation' ? 'Бронь' : 'Видача'] },
    { values: [] },
    { values: ['№', 'Назва', 'Код / марка', 'Запитана кількість', 'Од.', 'Статус складу', 'Коментар складу'], styleId: 3 }
  ];
  items.forEach((item, index) => {
    rows.push({
      values: [
        String(index + 1),
        item.name,
        item.code,
        item.requestedQty,
        item.unit,
        statusLabels[item.status] || item.status,
        item.comment
      ],
      styleId: warehouseItemXlsxStyleId(item.status)
    });
  });
  if (items.length === 0) rows.push({ values: ['', 'Позиції не розпізнані', '', '', '', '', ''] });

  const sheetData = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const values = Array.isArray(row) ? row : row.values;
    const styleId = Array.isArray(row) ? 0 : Number(row.styleId || 0);
    return `<row r="${rowNumber}">${values.map((value, colIndex) => xlsxCell(rowNumber, colIndex, value, styleId)).join('')}</row>`;
  }).join('');

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Склад" sheetId="1" r:id="rId1"/></sheets>
</workbook>`));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`));
  zip.addFile('xl/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFD6D6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFill="1" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="8" customWidth="1"/>
    <col min="2" max="2" width="48" customWidth="1"/>
    <col min="3" max="3" width="18" customWidth="1"/>
    <col min="3" max="3" width="26" customWidth="1"/>
    <col min="4" max="4" width="18" customWidth="1"/>
    <col min="5" max="5" width="10" customWidth="1"/>
    <col min="6" max="6" width="20" customWidth="1"/>
    <col min="7" max="7" width="22" customWidth="1"/>
    <col min="8" max="8" width="34" customWidth="1"/>
  </cols>
  <sheetData>${sheetData}</sheetData>
</worksheet>`));
  return zip.toBuffer();
};

const getPermissionValue = (userId, permissionKey) => {
  const row = db.central.prepare(`
    SELECT is_allowed FROM user_permissions WHERE user_id = ? AND permission_key = ?
  `).get(userId, permissionKey);
  return Number(row?.is_allowed || 0) === 1;
};

const canEditOrders = (req) => {
  if (req.userRole === 'admin') return true;
  return getPermissionValue(req.userId, EDIT_KEY) || getPermissionValue(req.userId, LEGACY_MANAGE_KEY);
};

const canViewOrders = (req) => {
  if (req.userRole === 'admin') return true;
  return getPermissionValue(req.userId, VIEW_KEY) || canEditOrders(req);
};

router.get('/permissions', (req, res) => {
  try {
    const canEdit = canEditOrders(req);
    const canView = canViewOrders(req);
    res.json({ canView, canEdit, canManage: canEdit });
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', (req, res) => {
  try {
    if (!canViewOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const rows = db.central.prepare(`
      SELECT *
      FROM warehouse_orders
      ORDER BY id DESC
      LIMIT 500
    `).all();
    res.json(rows.map(normalizeOrderRow));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', upload.single('file'), (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const chatId = String(req.body?.chatId || '').trim();
    const chatName = String(req.body?.chatName || '').trim();
    const messageId = Number.parseInt(req.body?.messageId, 10);
    const messageText = String(req.body?.messageText || '').trim();
    let objectName = String(req.body?.objectName || req.body?.projectName || '').trim();
    const managerName = String(req.body?.managerName || '').trim();
    const requesterName = String(req.body?.requesterName || '').trim();
    const requestTypeRaw = String(req.body?.requestType || '').trim();
    const requestType = REQUEST_TYPE_SET.has(requestTypeRaw) ? requestTypeRaw : 'issuance';
    let mediaPath = String(req.body?.mediaPath || '').trim();
    let mediaName = decodeMultipartFileName(String(req.body?.mediaName || '').trim());

    if (req.file) {
      const normalizedOriginalName = decodeMultipartFileName(req.file.originalname || '');
      const ext = path.extname(normalizedOriginalName || '') || '.bin';
      const safeBase = String(path.basename(normalizedOriginalName || 'file', ext))
        .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
        .trim()
        .slice(0, 80) || 'file';
      const finalName = `${safeBase}_${crypto.randomBytes(3).toString('hex')}${ext.toLowerCase()}`;
      const finalPath = path.join(runtimePaths.mediaDir, finalName);
      fs.renameSync(req.file.path, finalPath);
      mediaPath = `/uploads/media/${finalName}`;
      mediaName = normalizedOriginalName || finalName;
    }

    if (!messageText && !mediaPath) {
      return res.status(400).json({ error: 'Додайте опис або файл замовлення' });
    }
    if (!objectName && messageText) {
      const m = messageText.match(PROJECT_RE);
      if (m?.[1]) objectName = String(m[1]).trim().slice(0, 255);
    }
    const info = db.central.prepare(`
      INSERT INTO warehouse_orders (
        chat_id, chat_name, message_id, message_text, media_path, media_name, project_name, object_name, manager_name, requester_name, request_type, status,
        created_by_user_id, created_by_username, status_updated_at, status_updated_by_user_id, status_updated_by_username, items_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
    `).run(
      chatId,
      chatName,
      Number.isFinite(messageId) ? messageId : null,
      messageText || null,
      mediaPath || null,
      mediaName || null,
      objectName || null,
      objectName || null,
      managerName || null,
      requesterName || req.username || null,
      requestType,
      req.userId,
      req.username || null,
      req.userId,
      req.username || null,
      JSON.stringify(buildItemsFromTextOrFile(messageText, mediaPath, mediaName))
    );
    const created = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(Number(info.lastInsertRowid));
    res.status(201).json(normalizeOrderRow(created));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/status', (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    const nextStatus = String(req.body?.status || '').trim();
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });
    if (!STATUS_SET.has(nextStatus)) return res.status(400).json({ error: 'Некоректний статус' });
    const current = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Замовлення не знайдено' });
    db.central.prepare(`
      UPDATE warehouse_orders
      SET status = ?,
          updated_at = CURRENT_TIMESTAMP,
          status_updated_at = CURRENT_TIMESTAMP,
          status_updated_by_user_id = ?,
          status_updated_by_username = ?,
          assigned_to_user_id = COALESCE(assigned_to_user_id, ?),
          assigned_to_username = COALESCE(assigned_to_username, ?)
      WHERE id = ?
    `).run(nextStatus, req.userId, req.username || null, req.userId, req.username || null, id);
    const updated = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    res.json(normalizeOrderRow(updated));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', upload.single('file'), (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });

    const current = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Замовлення не знайдено' });

    const messageText = String(req.body?.messageText || current.message_text || '').trim();
    const objectName = String(req.body?.objectName || req.body?.projectName || current.object_name || current.project_name || '').trim();
    const managerName = String(req.body?.managerName || current.manager_name || '').trim();
    const requesterName = String(req.body?.requesterName || current.requester_name || '').trim();
    const requestTypeRaw = String(req.body?.requestType || current.request_type || '').trim();
    const requestType = REQUEST_TYPE_SET.has(requestTypeRaw) ? requestTypeRaw : 'issuance';

    let mediaPath = String(current.media_path || '');
    let mediaName = String(current.media_name || '');

    if (req.file) {
      const normalizedOriginalName = decodeMultipartFileName(req.file.originalname || '');
      const ext = path.extname(normalizedOriginalName || '') || '.bin';
      const safeBase = String(path.basename(normalizedOriginalName || 'file', ext))
        .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
        .trim()
        .slice(0, 80) || 'file';
      const finalName = `${safeBase}_${crypto.randomBytes(3).toString('hex')}${ext.toLowerCase()}`;
      const finalPath = path.join(runtimePaths.mediaDir, finalName);
      fs.renameSync(req.file.path, finalPath);
      mediaPath = `/uploads/media/${finalName}`;
      mediaName = normalizedOriginalName || finalName;
    }

    const currentItems = normalizeOrderItems(normalizeOrderRow(current).items);
    const parsedItems = buildItemsFromTextOrFile(messageText, mediaPath, mediaName);
    const nextItems = req.file
      ? parsedItems
      : (currentItems.length > 0 ? mergeOrderItems(currentItems, parsedItems) : parsedItems);

    db.central.prepare(`
      UPDATE warehouse_orders
      SET message_text = ?,
          project_name = ?,
          object_name = ?,
          manager_name = ?,
          requester_name = ?,
          request_type = ?,
          media_path = ?,
          media_name = ?,
          items_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      messageText || null,
      objectName || null,
      objectName || null,
      managerName || null,
      requesterName || null,
      requestType,
      mediaPath || null,
      mediaName || null,
      JSON.stringify(nextItems),
      id
    );

    const updated = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    res.json(normalizeOrderRow(updated));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/items/:itemId', (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    const itemId = String(req.params.itemId || '').trim();
    if (!Number.isFinite(id) || !itemId) return res.status(400).json({ error: 'Некоректні параметри' });
    const current = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Замовлення не знайдено' });

    let found = false;
    const currentItems = normalizeOrderItems(normalizeOrderRow(current).items);
    const nextItems = currentItems.map((item) => {
      if (String(item.id) !== itemId) return item;
      found = true;
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
        const status = String(req.body.status || '').trim();
        if (!ITEM_STATUS_SET.has(status)) throw new Error('Некоректний статус позиції');
        patch.status = status;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'comment')) {
        patch.comment = String(req.body.comment || '').trim();
      }
      return { ...item, ...patch };
    });
    if (!found) return res.status(404).json({ error: 'Позицію не знайдено' });

    db.central.prepare(`
      UPDATE warehouse_orders
      SET items_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(nextItems), id);
    const updated = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    res.json(normalizeOrderRow(updated));
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Не вдалося зберегти позицію' });
  }
});

router.patch('/:id/items', (req, res) => {
  try {
    if (!canEditOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });
    const current = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!current) return res.status(404).json({ error: 'Замовлення не знайдено' });
    const nextItems = normalizeOrderItems(req.body?.items);
    db.central.prepare(`
      UPDATE warehouse_orders
      SET items_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(nextItems), id);
    const updated = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    res.json(normalizeOrderRow(updated));
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/export.xlsx', (req, res) => {
  try {
    if (!canViewOrders(req)) return res.status(403).json({ error: 'Недостатньо прав' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некоректний ID' });
    const order = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Замовлення не знайдено' });
    const buffer = buildWarehouseOrderXlsx(order);
    const fileName = buildWarehouseOrderExportFileName(order, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buffer);
  } catch (_) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
