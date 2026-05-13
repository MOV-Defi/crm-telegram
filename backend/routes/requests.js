const express = require('express');
const db = require('../db');
const context = require('../context');
const runtimePaths = require('../runtime-paths');
const { getClient } = require('../telegram');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const router = express.Router();
let requestHistoryHasProjectColumn = null;


const upload = multer({ dest: runtimePaths.mediaDir });
const MAX_FILE_BASENAME = 80;

const sanitizeFileBaseName = (name) => String(name || '')
  .normalize('NFKC')
  .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\.+/g, '.')
  .replace(/^\.*/, '')
  .slice(0, MAX_FILE_BASENAME);

const splitNameAndExt = (fileName, fallbackExt = '.bin') => {
  const input = String(fileName || '').trim();
  const extFromName = path.extname(input);
  const ext = (extFromName || fallbackExt || '.bin').slice(0, 16).toLowerCase();
  const namePart = extFromName ? input.slice(0, -extFromName.length) : input;
  const base = sanitizeFileBaseName(namePart) || 'file';
  return { base, ext: ext.startsWith('.') ? ext : `.${ext}` };
};

const buildStoredMediaFileName = ({ originalName, fallbackBase = 'file', fallbackExt = '.bin', prefix = '' }) => {
  const { base, ext } = splitNameAndExt(originalName || `${fallbackBase}${fallbackExt}`, fallbackExt);
  const prefixSafe = sanitizeFileBaseName(prefix).replace(/[ .]+/g, '_');
  const unique = Math.random().toString(16).slice(2, 8);
  const finalBase = prefixSafe ? `${prefixSafe}_${base}` : base;
  return `${finalBase}_${unique}${ext}`;
};

const parseTemplate = (row) => {
  if (!row) return null;
  let parsedFields = [];
  try {
    const raw = JSON.parse(row.fields_json || '[]');
    parsedFields = Array.isArray(raw) ? raw : [];
  } catch (_) {
    parsedFields = [];
  }
  return {
    ...row,
    fields: parsedFields
  };
};

const getFieldValue = (values, key) => {
  if (!values || typeof values !== 'object') return '';
  return values[key];
};

const isFieldVisible = (field, values) => {
  if (!field.visibleWhen) return true;
  const currentValue = getFieldValue(values, field.visibleWhen.field);
  return String(currentValue || '') === String(field.visibleWhen.equals || '');
};

const normalizeMention = (mention) => {
  const trimmed = String(mention || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@')) return trimmed;
  // Add @ only for username-like tokens; keep full names/plain text as is.
  if (/^[a-zA-Z0-9_]{3,}$/.test(trimmed)) return `@${trimmed}`;
  return trimmed;
};

const collectTemplateMentions = (template, values = {}) => {
  const mentionField = (template.fields || []).find((field) => field.key === 'selected_mentions');
  const defaultMentions = Array.isArray(mentionField?.defaultMentions) ? mentionField.defaultMentions : [];
  const selectedMentionsRaw = getFieldValue(values, 'selected_mentions');
  const selectedMentions = Array.isArray(selectedMentionsRaw)
    ? selectedMentionsRaw
    : String(selectedMentionsRaw || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  return [...defaultMentions, ...selectedMentions]
    .map(normalizeMention)
    .filter(Boolean)
    .filter((mention, index, arr) => arr.indexOf(mention) === index);
};

const collectTemplateChatIntro = (template, values = {}) => {
  const mentions = collectTemplateMentions(template, values);
  const baseChatMessageKeys = [
    'chat_message',
    'tk_chat_message',
    'purchase_chat_message',
    'logistics_chat_message'
  ];

  // Support custom/legacy template keys for chat intro text so greeting lines are not lost.
  const dynamicKeys = Array.from(new Set(
    (template.fields || [])
      .filter((field) => {
        const key = String(field?.key || '').toLowerCase();
        const label = String(field?.label || '').toLowerCase();
        return key.includes('chat_message') || key.endsWith('_message') || label.includes('повідомлення в чат') || label.includes('message in chat');
      })
      .map((field) => String(field.key || '').trim())
      .filter(Boolean)
  ));

  const chatMessageRaw = [...baseChatMessageKeys, ...dynamicKeys]
    .map((key) => String(getFieldValue(values, key) || '').trim())
    .find(Boolean) || '';

  return [mentions.join(' '), chatMessageRaw].filter(Boolean).join('\n').trim();
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

const isWarehouseIssueTemplate = (template) => {
  const code = String(template?.code || '').trim().toLowerCase();
  const title = String(template?.title || '').trim().toLowerCase();
  return code === 'warehouse_issue_request' || title.includes('видача склад');
};

const getLogisticsMeta = () => {
  const warehouses = db.prepare(`
    SELECT id, name, address, work_schedule, geo_link, contact_person, contact_phone, loading_type
    FROM logistics_warehouses
    WHERE is_active = 1
    ORDER BY name COLLATE NOCASE ASC
  `).all();

  const recipients = db.prepare(`
    SELECT id, name, recipient_type, address, contact_person, contact_phone, delivery_time_note, unloading_type
    FROM logistics_recipients
    WHERE is_active = 1
    ORDER BY name COLLATE NOCASE ASC
  `).all();

  return {
    warehouses,
    recipients,
    warehouseMap: new Map(warehouses.map(item => [String(item.id), item])),
    recipientMap: new Map(recipients.map(item => [String(item.id), item]))
  };
};

const toWarehouseOption = (item) => ({
  value: String(item.id),
  label: item.name || '',
  workSchedule: item.work_schedule || '',
  address: item.address || '',
  geoLink: item.geo_link || '',
  contactPerson: item.contact_person || '',
  contactPhone: item.contact_phone || '',
  loadingType: item.loading_type || ''
});

const toRecipientOption = (item) => ({
  value: String(item.id),
  label: item.name || '',
  address: item.address || '',
  contactPerson: item.contact_person || '',
  contactPhone: item.contact_phone || '',
  deliveryTimeNote: item.delivery_time_note || '',
  unloadingType: item.unloading_type || ''
});

const hydrateTemplateFields = (template) => {
  if (template.code !== 'logistics_request') return template;
  const logistics = getLogisticsMeta();

  return {
    ...template,
    fields: (template.fields || []).map((field) => {
      if (field.type === 'logistics_warehouse') {
        return {
          ...field,
          type: 'select',
          options: logistics.warehouses.map(toWarehouseOption)
        };
      }
      if (field.type === 'logistics_recipient') {
        return {
          ...field,
          type: 'select',
          options: logistics.recipients.map(toRecipientOption)
        };
      }
      return field;
    })
  };
};

const checkboxLine = (label, checked) => `${checked ? '☑' : '☐'} ${label}`;

const formatPurchaseValues = (values = {}) => {
  const paymentFormRaw = String(getFieldValue(values, 'payment_form') || '').trim();
  const deliveryPaymentRaw = String(getFieldValue(values, 'delivery_payment') || '').trim();
  const paymentFormMap = {
    pdv: 'ПДВ',
    fop: 'ФОП',
    cash: 'Готівка',
    other: String(getFieldValue(values, 'payment_form_other') || '').trim() || 'Інше'
  };
  const deliveryPaymentMap = {
    cashless: 'Безнал',
    cash: 'Готівка',
    other: String(getFieldValue(values, 'delivery_payment_other') || '').trim() || 'Інше'
  };

  return {
    ...values,
    payment_form: paymentFormMap[paymentFormRaw] || paymentFormRaw,
    delivery_payment: deliveryPaymentMap[deliveryPaymentRaw] || deliveryPaymentRaw
  };
};

const formatLogisticsValues = (values = {}) => {
  const logistics = getLogisticsMeta();
  const pickupTemplate = logistics.warehouseMap.get(String(getFieldValue(values, 'pickup_template_id') || '')) || null;
  const deliveryTemplate = logistics.recipientMap.get(String(getFieldValue(values, 'delivery_template_id') || '')) || null;

  const specialConditions = String(getFieldValue(values, 'special_conditions_required') || 'no') === 'yes';
  const specialConditionsNote = String(getFieldValue(values, 'special_conditions_note') || '').trim();
  const needLoaders = String(getFieldValue(values, 'need_loaders') || 'no') === 'yes';
  const needReturnDocs = String(getFieldValue(values, 'need_return_docs') || 'no') === 'yes';
  const priority = String(getFieldValue(values, 'priority') || 'standard');
  const priorityOther = String(getFieldValue(values, 'priority_other') || '').trim();
  const paymentForm = String(getFieldValue(values, 'payment_form') || 'cash');
  const paymentFormOther = String(getFieldValue(values, 'payment_form_other') || '').trim();
  const paymentFormLabel = paymentForm === 'cash'
    ? 'готівка'
    : paymentForm === 'cashless_vat'
      ? 'безготівка з ПДВ'
      : paymentForm === 'other'
        ? paymentFormOther
        : paymentForm;
  const placeCountRaw = Number.parseInt(String(getFieldValue(values, 'place_count') || '1'), 10);
  const placeCount = Number.isFinite(placeCountRaw) ? Math.min(10, Math.max(1, placeCountRaw)) : 1;
  const placeDimensions = Array.isArray(getFieldValue(values, 'place_dimensions'))
    ? getFieldValue(values, 'place_dimensions').slice(0, placeCount).map(item => String(item || '').trim())
    : [];
  while (placeDimensions.length < placeCount) {
    placeDimensions.push('');
  }
  const placeDimensionsText = placeDimensions
    .map((dimension, index) => `Місце ${index + 1}: ${dimension || '—'}`)
    .join('\n');
  const cargoPackagesValue = String(getFieldValue(values, 'cargo_packages') || '').trim() || String(placeCount);
  const cargoDimensionsValue = String(getFieldValue(values, 'cargo_dimensions') || '').trim() || placeDimensionsText;

  const valueOrTemplate = (valueKey, templateObj, templateKey) => {
    const value = String(getFieldValue(values, valueKey) || '').trim();
    if (value) return value;
    return String(templateObj?.[templateKey] || '').trim();
  };

  return {
    ...values,
    submission_date: String(getFieldValue(values, 'submission_date') || '').trim(),
    requester_name_division: String(getFieldValue(values, 'requester_name_division') || '').trim(),
    requester_phone: String(getFieldValue(values, 'requester_phone') || '').trim(),
    cargo_type: String(getFieldValue(values, 'cargo_type') || '').trim(),
    cargo_packages: cargoPackagesValue,
    cargo_weight_kg: String(getFieldValue(values, 'cargo_weight_kg') || '').trim(),
    cargo_dimensions: cargoDimensionsValue,
    longest_part_length: String(getFieldValue(values, 'longest_part_length') || '').trim(),
    payment_form: String(paymentFormLabel || '').trim(),
    invoice_legal_entity: String(getFieldValue(values, 'invoice_legal_entity') || '').trim(),
    payment_docs_note: String(getFieldValue(values, 'payment_docs_note') || '').trim(),
    pickup_object_name: valueOrTemplate('pickup_object_name', pickupTemplate, 'name'),
    pickup_work_schedule: valueOrTemplate('pickup_work_schedule', pickupTemplate, 'work_schedule'),
    pickup_address: valueOrTemplate('pickup_address', pickupTemplate, 'address'),
    pickup_geolocation: valueOrTemplate('pickup_geolocation', pickupTemplate, 'geo_link'),
    pickup_contact_person: valueOrTemplate('pickup_contact_person', pickupTemplate, 'contact_person'),
    pickup_contact_phone: valueOrTemplate('pickup_contact_phone', pickupTemplate, 'contact_phone'),
    pickup_ready_time: String(getFieldValue(values, 'pickup_ready_time') || '').trim(),
    pickup_loading_method: valueOrTemplate('pickup_loading_method', pickupTemplate, 'loading_type'),
    delivery_object_name: valueOrTemplate('delivery_object_name', deliveryTemplate, 'name'),
    delivery_address: valueOrTemplate('delivery_address', deliveryTemplate, 'address'),
    delivery_contact_person: valueOrTemplate('delivery_contact_person', deliveryTemplate, 'contact_person'),
    delivery_contact_phone: valueOrTemplate('delivery_contact_phone', deliveryTemplate, 'contact_phone'),
    delivery_desired_time: valueOrTemplate('delivery_desired_time', deliveryTemplate, 'delivery_time_note'),
    delivery_unloading_method: valueOrTemplate('delivery_unloading_method', deliveryTemplate, 'unloading_type'),
    additional_notes: String(getFieldValue(values, 'additional_notes') || '').trim(),
    driver_waybill_note: String(getFieldValue(values, 'driver_waybill_note') || '').trim(),
    special_conditions_no_line: checkboxLine('Ні', !specialConditions),
    special_conditions_yes_line: checkboxLine(`Так (уточнити: ${specialConditionsNote || '_______________________'})`, specialConditions),
    need_loaders_yes_line: checkboxLine('Так', needLoaders),
    need_loaders_no_line: checkboxLine('Ні', !needLoaders),
    need_return_docs_yes_line: checkboxLine('Так', needReturnDocs),
    need_return_docs_no_line: checkboxLine('Ні', !needReturnDocs),
    priority_standard_line: checkboxLine('Стандартна доставка (в межах 3-4 днів)', priority === 'standard'),
    priority_urgent_line: checkboxLine('Термінова доставка (в межах 1-2 дня)', priority === 'urgent'),
    priority_other_line: checkboxLine(`Інше: ${priorityOther || '_____________________'}`, priority === 'other')
  };
};

const renderWarehouseIssueRequest = (template, values = {}) => {
  const mentionField = template.fields.find((field) => field.key === 'selected_mentions');
  const defaultMentions = Array.isArray(mentionField?.defaultMentions) ? mentionField.defaultMentions : [];
  const selectedMentionsRaw = getFieldValue(values, 'selected_mentions');
  const selectedMentions = Array.isArray(selectedMentionsRaw)
    ? selectedMentionsRaw
    : String(selectedMentionsRaw || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  const normalizedMentions = [...defaultMentions, ...selectedMentions]
    .map(normalizeMention)
    .filter(Boolean)
    .filter((mention, index, arr) => arr.indexOf(mention) === index);

  const mode = String(getFieldValue(values, 'request_mode') || 'reservation');
  let modeBlock = '';

  if (mode === 'reservation') {
    const projectName = String(getFieldValue(values, 'project_name') || '').trim();
    modeBlock = `Прошу забронювати.${projectName ? `\nПроєкт: "${projectName}"` : ''}`;
  } else {
    const recipientType = String(getFieldValue(values, 'issue_recipient_type') || '');
    const recipientLabel = recipientType === 'contractor' ? 'Підрядник' : 'Кінцевий споживач';
    const recipientName = String(getFieldValue(values, 'issue_recipient_name') || '').trim();
    modeBlock = `Тип: "Видача"\nВидача на: "${recipientLabel}"${recipientName ? `\nХто саме: "${recipientName}"` : ''}`;
  }

  const additionalComment = String(getFieldValue(values, 'additional_comment') || '').trim();
  const commentBlock = additionalComment ? `\nДодатковий коментар:\n"${additionalComment}"\n` : '';

  return template.body_template
    .replace('{{mentions_line}}', normalizedMentions.join(' '))
    .replace('{{items_list}}', String(getFieldValue(values, 'items_list') || '').trim())
    .replace('{{mode_block}}', modeBlock)
    .replace('{{comment_block}}', commentBlock);
};

const renderTemplate = (template, values = {}) => {
  if (template.code === 'warehouse_issue_request') {
    return renderWarehouseIssueRequest(template, values);
  }

  const formattedValues = template.code === 'logistics_request'
    ? formatLogisticsValues(values)
    : template.code === 'purchase_request'
      ? formatPurchaseValues(values)
      : values;
  return template.body_template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = formattedValues[key];
    return value == null ? '' : String(value);
  });
};

const cleanupRenderedMessage = (text) => {
  const source = String(text || '').replace(/\r/g, '');
  const lines = source.split('\n');
  const cleaned = [];
  const isLikelyFieldLabel = (labelTextRaw) => {
    const labelText = String(labelTextRaw || '').trim();
    if (!labelText) return false;
    if (labelText.length > 80) return false;
    if (labelText.includes('://')) return false;
    // Real field labels are typically short and without sentence punctuation.
    if (/[.!?]/.test(labelText)) return false;
    return true;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const nextLine = lines[i + 1];
    const nextTrimmed = (nextLine || '').trim();

    // Remove empty placeholder lines like "", "—", ":" leftovers.
    if (trimmed === '""' || trimmed === "''" || trimmed === '—' || trimmed === '-') {
      continue;
    }

    // Remove field lines with empty values: "Поле: """, "Поле:", "Поле: "
    if (/:/.test(trimmed)) {
      const [labelPart = '', valuePart = ''] = trimmed.split(/:(.*)/);
      const isFieldLike = isLikelyFieldLabel(labelPart);
      const normalizedValue = valuePart.trim().replace(/^["']|["']$/g, '');
      if (isFieldLike && !normalizedValue) {
        // Also skip the next line if it's just an empty quoted value.
        if (nextTrimmed === '""' || nextTrimmed === "''") {
          i += 1;
        }
        continue;
      }
    }

    // Remove orphan labels if next line is empty quoted placeholder.
    if (trimmed.endsWith(':') && isLikelyFieldLabel(trimmed.slice(0, -1)) && (nextTrimmed === '""' || nextTrimmed === "''")) {
      i += 1;
      continue;
    }

    cleaned.push(line);
  }

  // Collapse multiple blank lines to a single blank line and trim edges.
  const compact = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    if (!line.trim()) {
      if (compact.length === 0 || !compact[compact.length - 1].trim()) continue;
      compact.push('');
    } else {
      compact.push(line);
    }
  }

  while (compact.length > 0 && !compact[0].trim()) compact.shift();
  while (compact.length > 0 && !compact[compact.length - 1].trim()) compact.pop();

  return compact.join('\n');
};

const buildFileRequestText = (chatIntro, message) => {
  const intro = String(chatIntro || '').trim();
  const body = String(message || '').trim();
  if (!intro) return body;
  if (!body) return intro;
  if (body.includes(intro)) return body;
  return `${intro}\n\n${body}`;
};

const buildLogisticsCaption = (chatIntro, message) => {
  const intro = String(chatIntro || '').trim();
  const body = String(message || '').trim();
  if (!intro) return body;
  if (!body) return intro;

  // Place the chat text after the first "Доброго дня/Добрий день" greeting, if present.
  const greetingRegex = /(?:доброго\s+дня|добрий\s+день)[.!]?/iu;
  const match = body.match(greetingRegex);
  if (match && Number.isFinite(match.index)) {
    const insertAt = match.index + match[0].length;
    const before = body.slice(0, insertAt).trimEnd();
    const after = body.slice(insertAt).trimStart();
    return [before, intro, after].filter(Boolean).join('\n\n').trim();
  }

  // Fallback: append chat text after the base body.
  return `${body}\n\n${intro}`.trim();
};

const trimTelegramCaption = (text, limit = 1024) => {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.length <= limit) return raw;
  const suffix = '…';
  return `${raw.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
};

const buildLogisticsStandardCaption = (chatIntro) => {
  const introBody = String(chatIntro || '').trim();
  const parts = [
    'Доброго дня. Прошу організувати логістику по заявці.',
    introBody,
    'Дякую'
  ].filter(Boolean);
  return parts.join('\n');
};

const buildPurchaseStandardCaption = (chatIntro) => {
  const introBody = String(chatIntro || '').trim();
  const parts = [
    'Доброго дня. Прошу обробити заявку на закупку.',
    introBody,
    'Дякую'
  ].filter(Boolean);
  return parts.join('\n');
};

const validateTemplate = (template, values = {}) => {
  const visibleFields = template.fields.filter((field) => isFieldVisible(field, values));
  const missingRequiredField = visibleFields.find((field) => {
    if (!field.required) return false;

    const fieldValue = getFieldValue(values, field.key);
    if (Array.isArray(fieldValue)) return fieldValue.length === 0;
    return !String(fieldValue || '').trim();
  });

  if (missingRequiredField) {
    return `Поле "${missingRequiredField.label}" обов'язкове`;
  }

  if (template.code === 'warehouse_issue_request') {
    const mode = String(getFieldValue(values, 'request_mode') || '');
    if (mode === 'reservation' && !String(getFieldValue(values, 'project_name') || '').trim()) {
      return 'Поле "Проєкт" обовʼязкове для режиму "Бронь"';
    }
    if (mode === 'issuance' && !String(getFieldValue(values, 'issue_recipient_type') || '').trim()) {
      return 'Поле "Видача на" обовʼязкове для режиму "Видача"';
    }
    if (mode === 'issuance' && !String(getFieldValue(values, 'issue_recipient_name') || '').trim()) {
      return 'Поле "Хто саме" обовʼязкове для режиму "Видача"';
    }
  }

  if (template.code === 'logistics_request') {
    const placeCountRaw = Number.parseInt(String(getFieldValue(values, 'place_count') || '1'), 10);
    const placeCount = Number.isFinite(placeCountRaw) ? Math.min(10, Math.max(1, placeCountRaw)) : 1;
    const placeDimensions = Array.isArray(getFieldValue(values, 'place_dimensions'))
      ? getFieldValue(values, 'place_dimensions').slice(0, placeCount).map(item => String(item || '').trim())
      : [];
    const hasEmptyPlaceDimension = Array.from({ length: placeCount }, (_, index) => placeDimensions[index] || '').some(item => !item);
    if (hasEmptyPlaceDimension) {
      return 'Заповни габарити для кожного місця';
    }

    const paymentForm = String(getFieldValue(values, 'payment_form') || 'cash');
    if (paymentForm === 'other' && !String(getFieldValue(values, 'payment_form_other') || '').trim()) {
      return 'Заповни поле "Форма оплати: інше"';
    }

    const priority = String(getFieldValue(values, 'priority') || 'standard');
    if (priority === 'other' && !String(getFieldValue(values, 'priority_other') || '').trim()) {
      return 'Заповни поле "Пріоритет: інше"';
    }
    const special = String(getFieldValue(values, 'special_conditions_required') || 'no');
    if (special === 'yes' && !String(getFieldValue(values, 'special_conditions_note') || '').trim()) {
      return 'Додай уточнення для спец. умов перевезення';
    }
  }

  return null;
};

const normalizeSentMessage = (sentResult) => {
  if (Array.isArray(sentResult)) return sentResult[0] || null;
  return sentResult || null;
};

const saveRequestHistory = ({
  template,
  messageId,
  messageText,
  values,
  req
}) => {
  if (requestHistoryHasProjectColumn === null) {
    const columns = db.central.prepare(`PRAGMA table_info(request_history)`).all();
    requestHistoryHasProjectColumn = columns.some((column) => column.name === 'project_name');
  }
  const projectName = String(
    getFieldValue(values, 'project_name')
      || getFieldValue(values, 'object_name')
      || getFieldValue(values, 'project')
      || ''
  ).trim() || null;
  if (requestHistoryHasProjectColumn) {
    db.central.prepare(`
      INSERT INTO request_history (
        template_id, template_code, template_title,
        chat_id, chat_name, message_id, message_text, project_name,
        created_by_user_id, created_by_username
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(template?.id) || null,
      String(template?.code || '').trim() || null,
      String(template?.title || '').trim() || null,
      String(template?.target_chat_id || '').trim() || null,
      String(template?.target_chat_name || '').trim() || null,
      Number.isFinite(Number(messageId)) ? Number(messageId) : null,
      String(messageText || '').slice(0, 4000),
      projectName,
      req.userId || null,
      req.username || null
    );
    return;
  }
  db.central.prepare(`
    INSERT INTO request_history (
      template_id, template_code, template_title,
      chat_id, chat_name, message_id, message_text,
      created_by_user_id, created_by_username
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(template?.id) || null,
    String(template?.code || '').trim() || null,
    String(template?.title || '').trim() || null,
    String(template?.target_chat_id || '').trim() || null,
    String(template?.target_chat_name || '').trim() || null,
    Number.isFinite(Number(messageId)) ? Number(messageId) : null,
    String(messageText || '').slice(0, 4000),
    req.userId || null,
    req.username || null
  );
};

const extractProjectNameFromMessageText = (text = '') => {
  const raw = String(text || '');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const markers = ['проєкт:', 'проект:', 'об\'єкт:', "об’єкт:"];
  for (const line of lines) {
    const lower = line.toLowerCase();
    const marker = markers.find((m) => lower.includes(m));
    if (!marker) continue;
    const idx = lower.indexOf(marker);
    const value = line.slice(idx + marker.length).trim();
    if (value) return value;
  }
  return null;
};

const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const generateDocxXmlFromRuns = (runs) => {
  const paragraphs = [];
  let currentRuns = [];

  runs.forEach((run) => {
    const text = String(run?.text || '').replace(/\r/g, '');
    const chunks = text.split('\n');

    chunks.forEach((chunk, idx) => {
      if (chunk.length > 0) {
        currentRuns.push({ text: chunk, bold: !!run.bold });
      }
      if (idx < chunks.length - 1) {
        paragraphs.push(currentRuns);
        currentRuns = [];
      }
    });
  });

  paragraphs.push(currentRuns);

  const paragraphsXml = paragraphs.map((paragraphRuns) => {
    if (!paragraphRuns.length) return '<w:p/>';
    const runsXml = paragraphRuns.map((run) => (
      `<w:r>${run.bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`
    )).join('');
    return `<w:p>${runsXml}</w:p>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14">
  <w:body>
    ${paragraphsXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
      <w:cols w:space="708"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>`;
};

const generateDocxXmlFromBodyContent = (bodyContentXml) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14">
  <w:body>
    ${bodyContentXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
      <w:cols w:space="708"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const buildTemplateRuns = (templateText, values) => {
  const text = String(templateText || '');
  const resultRuns = [];
  const re = /\{\{(\w+)\}\}/g;
  let lastIndex = 0;
  let match = re.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      resultRuns.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    const key = match[1];
    const value = values[key] == null ? '' : String(values[key]);
    resultRuns.push({ text: value, bold: true });
    lastIndex = match.index + match[0].length;
    match = re.exec(text);
  }

  if (lastIndex < text.length) {
    resultRuns.push({ text: text.slice(lastIndex), bold: false });
  }

  return resultRuns;
};

const packDocxFromContentDir = (contentDir, docxPath) => {
  if (process.platform === 'win32') {
    // Use a script block (& { ... }) so that arguments are correctly passed into $args.
    const psScript = `& {
      $ErrorActionPreference = "Stop";
      $items = Get-ChildItem -LiteralPath $args[0] -Force | ForEach-Object { $_.FullName };
      if (-not $items -or $items.Count -eq 0) { throw "No files to archive" };
      Compress-Archive -LiteralPath $items -DestinationPath $args[1] -Force
    }`;
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript, contentDir, docxPath],
      { stdio: 'pipe' }
    );
    return;
  }
  const zip = new AdmZip();
  zip.addLocalFolder(contentDir);
  zip.writeZip(docxPath);
};

const writeDocxFromTemplate = (templateText, values, fileNameBase = 'logistics-request') => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-logistics-'));
  const contentDir = path.join(tempRoot, 'content');
  const relsDir = path.join(contentDir, '_rels');
  const wordDir = path.join(contentDir, 'word');

  fs.mkdirSync(relsDir, { recursive: true });
  fs.mkdirSync(wordDir, { recursive: true });

  fs.writeFileSync(path.join(contentDir, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  fs.writeFileSync(path.join(relsDir, '.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  const runs = buildTemplateRuns(templateText, values);
  fs.writeFileSync(path.join(wordDir, 'document.xml'), generateDocxXmlFromRuns(runs));

  const safeName = String(fileNameBase || 'logistics-request')
    .normalize('NFKC')
    .replace(/[/:*?"<>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '') || 'document';
  const docxPath = path.join(tempRoot, `${safeName}.docx`);

  packDocxFromContentDir(contentDir, docxPath);

  return { docxPath, tempRoot };
};

const parsePurchaseItemsRows = (values = {}) => {
  const fromJson = (() => {
    try {
      const parsed = JSON.parse(String(getFieldValue(values, 'purchase_items_json') || '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  })();

  if (fromJson.length > 0) {
    return fromJson.map((row, index) => ({
      rowNumber: index + 1,
      itemName: String(row.itemName || '').trim(),
      equipmentCode: String(row.equipmentCode || '').trim(),
      plant: String(row.plant || '').trim(),
      unit: String(row.unit || '').trim(),
      qty: String(row.qty || '').trim(),
      notes: String(row.notes || '').trim()
    }));
  }

  const lines = String(getFieldValue(values, 'items_list') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => ({
    rowNumber: index + 1,
    itemName: line.replace(/^\d+\.\s*/, ''),
    equipmentCode: '',
    plant: '',
    unit: '',
    qty: '',
    notes: ''
  }));
};

const paragraphXml = (text, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${escapeXml(String(text || ''))}</w:t></w:r></w:p>`;

const tableCellXml = (text, widthTwips, bold = false) => (
  `<w:tc>
    <w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/></w:tcPr>
    <w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${escapeXml(String(text || ''))}</w:t></w:r></w:p>
  </w:tc>`
);

const buildPurchaseTableXml = (rows = []) => {
  const header = ['№', 'Найменування', 'Код обладнання, виробу', 'Завод', 'Од.вимір.', 'К-сть', 'Примітки'];
  const colWidths = [500, 2600, 1700, 1000, 900, 700, 1700];
  const totalWidth = colWidths.reduce((sum, value) => sum + value, 0);
  const rowXml = rows.map((row, index) => (
    `<w:tr>
      ${tableCellXml(String(index + 1), colWidths[0])}
      ${tableCellXml(row.itemName, colWidths[1])}
      ${tableCellXml(row.equipmentCode, colWidths[2])}
      ${tableCellXml(row.plant, colWidths[3])}
      ${tableCellXml(row.unit, colWidths[4])}
      ${tableCellXml(row.qty, colWidths[5])}
      ${tableCellXml(row.notes, colWidths[6])}
    </w:tr>`
  )).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${totalWidth}" w:type="dxa"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="6" w:space="0" w:color="auto"/>
        <w:left w:val="single" w:sz="6" w:space="0" w:color="auto"/>
        <w:bottom w:val="single" w:sz="6" w:space="0" w:color="auto"/>
        <w:right w:val="single" w:sz="6" w:space="0" w:color="auto"/>
        <w:insideH w:val="single" w:sz="6" w:space="0" w:color="auto"/>
        <w:insideV w:val="single" w:sz="6" w:space="0" w:color="auto"/>
      </w:tblBorders>
    </w:tblPr>
    <w:tblGrid>${colWidths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>
    <w:tr>${header.map((h, index) => tableCellXml(h, colWidths[index], true)).join('')}</w:tr>
    ${rowXml}
  </w:tbl>`;
};

const writePurchaseDocx = (values, fileNameBase = 'purchase-request') => {
  const formatted = formatPurchaseValues(values);
  const rows = parsePurchaseItemsRows(values);

  const body = [
    paragraphXml('Доброго дня. Прошу обробити заявку на закупку.'),
    paragraphXml(''),
    paragraphXml(`Дата: ${formatted.request_date || ''}`),
    paragraphXml(`Проект: ${formatted.project_name || ''}`),
    paragraphXml(`Менеджер: ${formatted.manager_name || ''}`),
    paragraphXml(''),
    buildPurchaseTableXml(rows),
    paragraphXml(''),
    paragraphXml(`Реквізити: ${formatted.requisites || ''}`),
    paragraphXml(`Форма оплати: ${formatted.payment_form || ''}`),
    paragraphXml(`Терміни: ${formatted.terms || ''}`),
    paragraphXml(`Адреса доставки: ${formatted.delivery_address || ''}`),
    paragraphXml(`Оплата доставки: ${formatted.delivery_payment || ''}`),
    paragraphXml(`Додатковий коментар: ${formatted.additional_comment || ''}`)
  ].join('');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-purchase-'));
  const contentDir = path.join(tempRoot, 'content');
  const relsDir = path.join(contentDir, '_rels');
  const wordDir = path.join(contentDir, 'word');

  fs.mkdirSync(relsDir, { recursive: true });
  fs.mkdirSync(wordDir, { recursive: true });

  fs.writeFileSync(path.join(contentDir, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  fs.writeFileSync(path.join(relsDir, '.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  fs.writeFileSync(path.join(wordDir, 'document.xml'), generateDocxXmlFromBodyContent(body));

  const safeName = String(fileNameBase || 'purchase-request')
    .normalize('NFKC')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'document';
  const docxPath = path.join(tempRoot, `${safeName}.docx`);

  packDocxFromContentDir(contentDir, docxPath);

  return { docxPath, tempRoot };
};

router.get('/logistics/options', (req, res) => {
  try {
    const logistics = getLogisticsMeta();
    res.json({
      warehouses: logistics.warehouses.map(toWarehouseOption),
      recipients: logistics.recipients.map(toRecipientOption)
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/purchase/options', (req, res) => {
  try {
    const managers = db.prepare(`
      SELECT id, name
      FROM purchase_manager_templates
      WHERE is_active = 1
      ORDER BY name COLLATE NOCASE ASC
    `).all();

    const addresses = db.prepare(`
      SELECT id, title, address
      FROM purchase_address_templates
      WHERE is_active = 1
      ORDER BY title COLLATE NOCASE ASC
    `).all();

    res.json({
      managers: managers.map((item) => ({ value: String(item.id), label: item.name || '' })),
      addresses: addresses.map((item) => ({ value: String(item.id), label: item.title || '', address: item.address || '' }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/purchase/manager', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Імʼя менеджера обовʼязкове' });
  }
  try {
    const existing = db.prepare('SELECT id FROM purchase_manager_templates WHERE name = ?').get(name);
    if (existing) {
      db.prepare('UPDATE purchase_manager_templates SET is_active = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare('INSERT INTO purchase_manager_templates (name, is_active) VALUES (?, 1)').run(name);
    }
    const saved = db.prepare('SELECT id, name FROM purchase_manager_templates WHERE name = ?').get(name);
    res.json({ success: true, manager: { value: String(saved.id), label: saved.name || '' } });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/purchase/address', (req, res) => {
  const title = String(req.body?.title || '').trim();
  const address = String(req.body?.address || '').trim();
  if (!title) {
    return res.status(400).json({ error: 'Назва шаблону адреси обовʼязкова' });
  }
  if (!address) {
    return res.status(400).json({ error: 'Адреса обовʼязкова' });
  }
  try {
    const existing = db.prepare('SELECT id FROM purchase_address_templates WHERE title = ?').get(title);
    if (existing) {
      db.prepare('UPDATE purchase_address_templates SET address = ?, is_active = 1 WHERE id = ?').run(address, existing.id);
    } else {
      db.prepare('INSERT INTO purchase_address_templates (title, address, is_active) VALUES (?, ?, 1)').run(title, address);
    }
    const saved = db.prepare('SELECT id, title, address FROM purchase_address_templates WHERE title = ?').get(title);
    res.json({ success: true, address: { value: String(saved.id), label: saved.title || '', address: saved.address || '' } });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/tk/options', (req, res) => {
  try {
    const managers = db.prepare(`
      SELECT id, name
      FROM tk_manager_templates
      WHERE is_active = 1
      ORDER BY name COLLATE NOCASE ASC
    `).all();
    const recipients = db.prepare(`
      SELECT id, title, details
      FROM tk_recipient_templates
      WHERE is_active = 1
      ORDER BY title COLLATE NOCASE ASC
    `).all();

    res.json({
      managers: managers.map((item) => ({ value: String(item.id), label: item.name || '' })),
      recipients: recipients.map((item) => ({ value: String(item.id), label: item.title || '', details: item.details || '' }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/tk/manager', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Імʼя менеджера обовʼязкове' });
  }

  try {
    const existing = db.prepare('SELECT id FROM tk_manager_templates WHERE name = ?').get(name);
    if (existing) {
      db.prepare('UPDATE tk_manager_templates SET is_active = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare('INSERT INTO tk_manager_templates (name, is_active) VALUES (?, 1)').run(name);
    }
    const saved = db.prepare('SELECT id, name FROM tk_manager_templates WHERE name = ?').get(name);
    res.json({ success: true, manager: { value: String(saved.id), label: saved.name || '' } });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/tk/recipient', (req, res) => {
  const title = String(req.body?.title || '').trim();
  const details = String(req.body?.details || '').trim();
  if (!title) {
    return res.status(400).json({ error: 'Назва шаблону отримувача обовʼязкова' });
  }
  if (!details) {
    return res.status(400).json({ error: 'Деталі отримувача обовʼязкові' });
  }

  try {
    const existing = db.prepare('SELECT id FROM tk_recipient_templates WHERE title = ?').get(title);
    if (existing) {
      db.prepare('UPDATE tk_recipient_templates SET details = ?, is_active = 1 WHERE id = ?').run(details, existing.id);
    } else {
      db.prepare('INSERT INTO tk_recipient_templates (title, details, is_active) VALUES (?, ?, 1)').run(title, details);
    }
    const saved = db.prepare('SELECT id, title, details FROM tk_recipient_templates WHERE title = ?').get(title);
    res.json({ success: true, recipient: { value: String(saved.id), label: saved.title || '', details: saved.details || '' } });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logistics/warehouse', (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Назва складу обовʼязкова' });
  }

  try {
    const existing = db.prepare('SELECT id FROM logistics_warehouses WHERE name = ?').get(name);
    if (existing) {
      db.prepare(`
        UPDATE logistics_warehouses
        SET address = ?, work_schedule = ?, geo_link = ?, contact_person = ?, contact_phone = ?, loading_type = ?, is_active = 1
        WHERE id = ?
      `).run(
        String(payload.address || '').trim() || null,
        String(payload.workSchedule || '').trim() || null,
        String(payload.geoLink || '').trim() || null,
        String(payload.contactPerson || '').trim() || null,
        String(payload.contactPhone || '').trim() || null,
        String(payload.loadingType || '').trim() || null,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO logistics_warehouses
        (name, address, work_schedule, geo_link, contact_person, contact_phone, loading_type, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        name,
        String(payload.address || '').trim() || null,
        String(payload.workSchedule || '').trim() || null,
        String(payload.geoLink || '').trim() || null,
        String(payload.contactPerson || '').trim() || null,
        String(payload.contactPhone || '').trim() || null,
        String(payload.loadingType || '').trim() || null
      );
    }

    const saved = db.prepare(`
      SELECT id, name, address, work_schedule, geo_link, contact_person, contact_phone, loading_type
      FROM logistics_warehouses
      WHERE name = ?
    `).get(name);

    res.json({ success: true, warehouse: toWarehouseOption(saved) });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logistics/recipient', (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Назва одержувача обовʼязкова' });
  }

  try {
    const existing = db.prepare('SELECT id FROM logistics_recipients WHERE name = ?').get(name);
    if (existing) {
      db.prepare(`
        UPDATE logistics_recipients
        SET recipient_type = ?, address = ?, contact_person = ?, contact_phone = ?, delivery_time_note = ?, unloading_type = ?, is_active = 1
        WHERE id = ?
      `).run(
        String(payload.recipientType || 'Одержувач').trim() || null,
        String(payload.address || '').trim() || null,
        String(payload.contactPerson || '').trim() || null,
        String(payload.contactPhone || '').trim() || null,
        String(payload.deliveryTimeNote || '').trim() || null,
        String(payload.unloadingType || '').trim() || null,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO logistics_recipients
        (name, recipient_type, address, contact_person, contact_phone, delivery_time_note, unloading_type, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        name,
        String(payload.recipientType || 'Одержувач').trim() || null,
        String(payload.address || '').trim() || null,
        String(payload.contactPerson || '').trim() || null,
        String(payload.contactPhone || '').trim() || null,
        String(payload.deliveryTimeNote || '').trim() || null,
        String(payload.unloadingType || '').trim() || null
      );
    }

    const saved = db.prepare(`
      SELECT id, name, recipient_type, address, contact_person, contact_phone, delivery_time_note, unloading_type
      FROM logistics_recipients
      WHERE name = ?
    `).get(name);

    res.json({ success: true, recipient: toRecipientOption(saved) });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/templates', (req, res) => {
  try {
    const rows = db.central.prepare(`
      SELECT id, code, title, description, target_chat_id, target_chat_name, body_template, fields_json, is_active
      FROM request_templates
      WHERE is_active = 1
      ORDER BY id ASC
    `).all();

    res.json(rows.map(parseTemplate).filter(Boolean).map(hydrateTemplateFields));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/templates/:id', (req, res) => {
  const { targetChatId, targetChatName } = req.body;

  try {
    db.central.prepare(`
      UPDATE request_templates
      SET target_chat_id = ?, target_chat_name = ?
      WHERE id = ?
    `).run(
      targetChatId ? String(targetChatId) : null,
      targetChatName ? String(targetChatName) : null,
      req.params.id
    );

    const row = db.central.prepare(`
      SELECT id, code, title, description, target_chat_id, target_chat_name, body_template, fields_json, is_active
      FROM request_templates
      WHERE id = ?
    `).get(req.params.id);

    const parsed = parseTemplate(row);
    if (!parsed) {
      return res.status(404).json({ error: 'Шаблон не знайдено' });
    }
    res.json(hydrateTemplateFields(parsed));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/send', upload.single('file'), (req, res, next) => {
  // Multer loses context, restore it from req.userId
  const userId = req.userId || context.getUserId();
  if (userId) {
    context.runWithContext({ userId }, next);
  } else {
    next();
  }
}, async (req, res) => {
  const templateId = req.body.templateId;
  let values = req.body.values;

  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch (error) {
      values = {};
    }
  }

  let tempDocxRoot = null;
  let uploadedFilePath = null;
  let uploadedMediaPublicPath = null;
  let uploadedOriginalName = null;
  let createdWarehouseOrder = null;

  try {
    const template = db.central.prepare(`
      SELECT id, code, title, description, target_chat_id, target_chat_name, body_template, fields_json, is_active
      FROM request_templates
      WHERE id = ? AND is_active = 1
    `).get(templateId);

    if (!template) {
      return res.status(404).json({ error: 'Шаблон не знайдено' });
    }

    if (!template.target_chat_id) {
      return res.status(400).json({ error: 'Для цієї заяви не вибрано чат призначення' });
    }

    const client = getClient();
    if (!client || !client.connected) {
      return res.status(503).json({ error: 'Telegram клієнт не підключений' });
    }

    const templateWithFields = hydrateTemplateFields(parseTemplate(template));
    if (!templateWithFields) {
      return res.status(500).json({ error: 'Не вдалося прочитати шаблон заявки' });
    }
    const validationError = validateTemplate(templateWithFields, values);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (req.file) {
      uploadedOriginalName = decodeMultipartFileName(req.file.originalname || '');
      const ext = path.extname(uploadedOriginalName) || '';
      const nameParts = splitNameAndExt(uploadedOriginalName, ext || '.bin');
      let storedName = `${nameParts.base}${nameParts.ext}`;
      const candidatePath = path.join(runtimePaths.mediaDir, storedName);
      if (fs.existsSync(candidatePath)) {
        storedName = `${nameParts.base}_${crypto.randomBytes(3).toString('hex')}${nameParts.ext}`;
      }
      uploadedFilePath = path.join(runtimePaths.mediaDir, storedName);
      uploadedMediaPublicPath = `/uploads/media/${storedName}`;
      fs.renameSync(req.file.path, uploadedFilePath);
    }

    const message = cleanupRenderedMessage(renderTemplate(templateWithFields, values)).trim();
    const chatIntro = collectTemplateChatIntro(templateWithFields, values);

    if (template.code === 'logistics_request') {
      const fileDate = String(getFieldValue(values, 'submission_date') || '').replace(/[^\d.]/g, '').replace(/\./g, '-');
      const projectName = String(getFieldValue(values, 'project_name') || '').trim();
      const formattedValues = formatLogisticsValues(values);
      const logisticsFileBase = [
        'Заява на логістику',
        projectName ? `"${projectName}"` : '',
        fileDate || String(Date.now())
      ].filter(Boolean).join(' ');
      const generated = writeDocxFromTemplate(templateWithFields.body_template, formattedValues, logisticsFileBase);
      tempDocxRoot = generated.tempRoot;
      const caption = trimTelegramCaption(buildLogisticsStandardCaption(chatIntro));

      const sent = await client.sendFile(template.target_chat_id, {
        file: generated.docxPath,
        caption
      });
      const sentMessage = normalizeSentMessage(sent);
      saveRequestHistory({
        template,
        messageId: sentMessage?.id,
        messageText: caption || message,
        values,
        req
      });
      return res.json({ success: true, message });
    }

    if (template.code === 'purchase_request') {
      const fileDate = String(getFieldValue(values, 'request_date') || '').replace(/[^\d.]/g, '').replace(/\./g, '-');
      const projectName = String(getFieldValue(values, 'project_name') || '').trim();
      const purchaseFileBase = [
        'Заявка на закупку',
        projectName ? `"${projectName}"` : '',
        fileDate || String(Date.now())
      ].filter(Boolean).join(' ');
      const generated = writePurchaseDocx(values, purchaseFileBase);
      tempDocxRoot = generated.tempRoot;
      const caption = trimTelegramCaption(buildPurchaseStandardCaption(chatIntro));

      const sent = await client.sendFile(template.target_chat_id, {
        file: generated.docxPath,
        caption
      });
      const sentMessage = normalizeSentMessage(sent);
      saveRequestHistory({
        template,
        messageId: sentMessage?.id,
        messageText: caption || message,
        values,
        req
      });
      return res.json({ success: true, message });
    }

    const isWarehouseIssue = isWarehouseIssueTemplate(template);
    const includeIntroInBody = !isWarehouseIssue;
    const requestMode = String(getFieldValue(values, 'request_mode') || '').trim();
    const initialOrderStatus = 'new';
    const initialRequestType = requestMode === 'reservation' ? 'reservation' : 'issuance';
    const outgoingMessage = [
      includeIntroInBody ? chatIntro : '',
      message
    ].filter(Boolean).join('\n\n').trim();

    const createWarehouseOrder = ({
      sentMessageId = null,
      mediaPath = null,
      mediaName = null
    }) => {
      const info = db.central.prepare(`
        INSERT INTO warehouse_orders (
          chat_id, chat_name, message_id, message_text, media_path, media_name, project_name, requester_name, request_type, status,
          created_by_user_id, created_by_username,
          status_updated_at, status_updated_by_user_id, status_updated_by_username
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
      `).run(
        String(template.target_chat_id || ''),
        String(template.target_chat_name || ''),
        Number.isFinite(Number(sentMessageId)) ? Number(sentMessageId) : null,
        String(outgoingMessage || '').slice(0, 4000),
        mediaPath || null,
        mediaName || null,
        String(getFieldValue(values, 'project_name') || '').trim() || null,
        String(getFieldValue(values, 'manager_name') || req.username || '').trim() || null,
        initialRequestType,
        initialOrderStatus,
        req.userId || null,
        req.username || null,
        req.userId || null,
        req.username || null
      );
      createdWarehouseOrder = db.central.prepare(`SELECT * FROM warehouse_orders WHERE id = ?`).get(Number(info.lastInsertRowid)) || null;
    };

    if (uploadedFilePath) {
      const sent = await client.sendFile(template.target_chat_id, {
        file: uploadedFilePath,
        caption: outgoingMessage
      });
      const sentMessage = normalizeSentMessage(sent);
      saveRequestHistory({
        template,
        messageId: sentMessage?.id,
        messageText: outgoingMessage,
        values,
        req
      });
      if (isWarehouseIssue) {
        createWarehouseOrder({
          sentMessageId: Number(sentMessage?.id),
          mediaPath: uploadedMediaPublicPath,
          mediaName: uploadedOriginalName || null
        });
      }
    } else {
      const sent = await client.sendMessage(template.target_chat_id, { message: outgoingMessage });
      saveRequestHistory({
        template,
        messageId: sent?.id,
        messageText: outgoingMessage,
        values,
        req
      });
      if (isWarehouseIssue) {
        createWarehouseOrder({
          sentMessageId: Number(sent?.id),
          mediaPath: null,
          mediaName: null
        });
      }
    }

    res.json({ success: true, message, warehouseOrder: createdWarehouseOrder });
  } catch (error) {
    console.error('requests/send error:', {
      templateId,
      templateCode: String(req.body?.templateCode || ''),
      userId: req.userId || null,
      username: req.username || null,
      message: error?.message || String(error),
      stack: error?.stack || null
    });
    const rawMessage = String(error?.message || '').trim();
    const safeMessage = rawMessage && !/^internal server error$/i.test(rawMessage)
      ? rawMessage
      : 'Помилка відправки заяви. Перевірте підключення Telegram і шаблон.';
    res.status(500).json({ error: safeMessage });
  } finally {
    if (tempDocxRoot) {
      fs.rmSync(tempDocxRoot, { recursive: true, force: true });
    }
  }
});

router.get('/history', (req, res) => {
  try {
    if (requestHistoryHasProjectColumn === null) {
      const columns = db.central.prepare(`PRAGMA table_info(request_history)`).all();
      requestHistoryHasProjectColumn = columns.some((column) => column.name === 'project_name');
    }
    const limitRaw = Number.parseInt(String(req.query.limit || '100'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    const offsetRaw = Number.parseInt(String(req.query.offset || '0'), 10);
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const rows = db.central.prepare(
      requestHistoryHasProjectColumn
        ? `
          SELECT
            id,
            template_id,
            template_code,
            template_title,
            chat_id,
            chat_name,
            message_id,
            message_text,
            project_name,
            created_by_user_id,
            created_by_username,
            created_at
          FROM request_history
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ? OFFSET ?
        `
        : `
          SELECT
            id,
            template_id,
            template_code,
            template_title,
            chat_id,
            chat_name,
            message_id,
            message_text,
            created_by_user_id,
            created_by_username,
            created_at
          FROM request_history
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ? OFFSET ?
        `
    ).all(limit, offset).map((row) => ({
      ...row,
      project_name: row.project_name || extractProjectNameFromMessageText(row.message_text)
    }));

    const totalRow = db.central.prepare(`SELECT COUNT(*) AS total FROM request_history`).get();
    const total = Number(totalRow?.total || 0);
    return res.json({
      items: rows,
      total,
      limit,
      offset,
      hasMore: (offset + rows.length) < total
    });
  } catch (error) {
    console.error('requests/history GET error:', error);
    return res.status(500).json({ error: 'Не вдалося завантажити історію заяв' });
  }
});

module.exports = router;
