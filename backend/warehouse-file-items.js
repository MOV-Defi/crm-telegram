const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const decodeXml = (value) => String(value || '')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const stripTags = (value) => decodeXml(String(value || '').replace(/<[^>]*>/g, ''));

const columnIndexFromCellRef = (cellRef) => {
  const letters = String(cellRef || '').replace(/[^A-Z]/gi, '').toUpperCase();
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
};

const parseSharedStrings = (zip) => {
  const entry = zip.getEntry('xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = entry.getData().toString('utf8');
  const strings = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = siRegex.exec(xml))) {
    const textParts = [];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch;
    while ((textMatch = tRegex.exec(match[1]))) {
      textParts.push(decodeXml(textMatch[1]));
    }
    strings.push(textParts.length ? textParts.join('') : stripTags(match[1]));
  }
  return strings;
};

const parseXlsxRows = (filePath) => {
  const zip = new AdmZip(filePath);
  const sharedStrings = parseSharedStrings(zip);
  const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml')
    || zip.getEntries().find((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName));
  if (!sheetEntry) return [];

  const xml = sheetEntry.getData().toString('utf8');
  const rows = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml))) {
    const cells = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] || '';
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      const colIndex = columnIndexFromCellRef(ref);
      let value = '';

      if (type === 's') {
        const idx = Number.parseInt((body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || '', 10);
        value = Number.isFinite(idx) ? (sharedStrings[idx] || '') : '';
      } else if (type === 'inlineStr') {
        value = stripTags(body);
      } else {
        value = decodeXml((body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || stripTags(body));
      }

      cells[colIndex] = String(value || '').trim();
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
};

const parseDelimitedRows = (filePath, delimiter) => {
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.split(delimiter).map((cell) => String(cell || '').replace(/^"|"$/g, '').trim()))
    .filter((row) => row.some(Boolean));
};

const rowLooksLikeHeader = (values) => {
  const joined = values.join(' ').toLowerCase();
  if (!joined) return true;
  const headerHits = [
    /(^|\s)№(\s|$)/,
    /наймен/,
    /товар/,
    /номенк/,
    /артик/,
    /код/,
    /кільк|к-сть|кол-во|qty/,
    /од\.?|ед\.?|unit/,
    /ціна|цена|price/,
    /сума|сумма|total/
  ].filter((regex) => regex.test(joined)).length;
  return headerHits >= 2 || /специфікац|спецификация/.test(joined);
};

const getCell = (row, index) => String(row?.[index] || '').replace(/\s+/g, ' ').trim();

const isQtyValue = (value) => /^\d+([.,]\d+)?$/.test(String(value || '').trim());

const findWarehouseHeaderMap = (rows) => {
  for (const row of rows) {
    const cells = row.map((cell) => String(cell || '').replace(/\s+/g, ' ').trim().toLowerCase());
    const hasName = cells.some((cell) => /наймен|товар|номенк/.test(cell));
    const hasCode = cells.some((cell) => /тип|марка|код|артик/.test(cell));
    const hasQty = cells.some((cell) => /к-сть|кільк|кол-во|qty/.test(cell));
    if (!hasName || !hasQty) continue;

    if (
      /наймен/.test(cells[2] || '') &&
      (/тип/.test(cells[3] || '') || /марка/.test(cells[3] || '')) &&
      /к-сть|кільк|кол-во|qty/.test(cells[8] || '')
    ) {
      return {
        nameIndex: 2,
        codeIndex: 3,
        materialCodeIndex: 4,
        unitIndex: 7,
        qtyIndex: 8
      };
    }

    const findIndex = (regex, fallback) => {
      const index = cells.findIndex((cell) => regex.test(cell));
      return index >= 0 ? index : fallback;
    };

    return {
      nameIndex: findIndex(/наймен|товар|номенк/, 2),
      codeIndex: findIndex(/тип|марка|артик/, 3),
      materialCodeIndex: findIndex(/код обладнання|код матеріал/, 4),
      unitIndex: findIndex(/од\.\s*вим|одиниц|ед\.\s*изм|unit/, 7),
      qtyIndex: findIndex(/к-сть|кільк|кол-во|qty/, 8)
    };
  }

  return null;
};

const normalizeRowsToWarehouseItems = (rows) => {
  const headerMap = findWarehouseHeaderMap(rows);
  if (headerMap) {
    const items = [];
    for (const rawRow of rows) {
      const rawValues = rawRow.map((cell) => String(cell || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (rawValues.length === 0) continue;
      if (rowLooksLikeHeader(rawValues)) continue;

      const qty = getCell(rawRow, headerMap.qtyIndex);
      const unit = getCell(rawRow, headerMap.unitIndex);
      const nameCell = getCell(rawRow, headerMap.nameIndex);
      const codeCell = getCell(rawRow, headerMap.codeIndex);
      const name = nameCell || codeCell;
      const code = codeCell;

      if (!name || !isQtyValue(qty)) continue;
      if (/^(всього|итого|разом|total)\b/i.test(name)) continue;
      items.push({
        name,
        code,
        requestedQty: qty,
        unit
      });
      if (items.length >= 300) break;
    }
    return items;
  }

  const items = [];
  for (const rawRow of rows) {
    let values = rawRow
      .map((cell) => String(cell || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (values.length === 0) continue;
    if (values.length === 1 && /^\d+([.,]\d+)?$/.test(values[0])) continue;
    if (/^(всього|итого|разом|total)\b/i.test(values[0])) continue;
    if (rowLooksLikeHeader(values)) continue;
    if (values.length > 1 && /^\d+([.,]\d+)?$/.test(values[0])) values = values.slice(1);

    const name = values[0] || '';
    const code = values[1] || '';
    const requestedQty = [...values].reverse().find(isQtyValue) || '';
    if (name.length < 2) continue;
    items.push({ name, code, requestedQty, unit: '' });
    if (items.length >= 300) break;
  }
  return items;
};

const parseWarehouseItemsFromFile = (filePath, originalName = '') => {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    if (ext === '.xlsx' || ext === '.xlsm') {
      return normalizeRowsToWarehouseItems(parseXlsxRows(filePath));
    }
    if (ext === '.csv') {
      const text = fs.readFileSync(filePath, 'utf8');
      const firstLine = text.split(/\r?\n/).find(Boolean) || '';
      const delimiter = firstLine.includes(';') ? ';' : ',';
      return normalizeRowsToWarehouseItems(parseDelimitedRows(filePath, delimiter));
    }
    if (ext === '.tsv') {
      return normalizeRowsToWarehouseItems(parseDelimitedRows(filePath, '\t'));
    }
    if (ext === '.txt') {
      return normalizeRowsToWarehouseItems(parseDelimitedRows(filePath, '\n'));
    }
  } catch (error) {
    console.warn('warehouse file parse failed:', error?.message || error);
  }
  return [];
};

const parseWarehouseItemNamesFromFile = (filePath, originalName = '') => (
  parseWarehouseItemsFromFile(filePath, originalName).map((item) => (
    [item.name, item.code, item.requestedQty].filter(Boolean).join(' | ')
  ))
);

module.exports = {
  parseXlsxRows,
  parseWarehouseItemNamesFromFile,
  parseWarehouseItemsFromFile
};
