const express = require('express');
const { getClient } = require('../telegram');
const { Api } = require('telegram');
const db = require('../db');
const context = require('../context');
const runtimePaths = require('../runtime-paths');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const router = express.Router();
const upload = multer({ dest: runtimePaths.mediaDir });
const senderEntityRuntimeCache = new Map();
const SENDER_ENTITY_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BASENAME = 80;
const avatarRetryAfterByEntity = new Map();
const AVATAR_RETRY_MS = 10 * 60 * 1000;
const AVATAR_BATCH_LIMIT = 20;
const AVATAR_REQUEST_DELAY_MS = 1800;
const mediaRetryAfterByMessage = new Map();
const MEDIA_RETRY_MS = 15 * 60 * 1000;
const MEDIA_BATCH_LIMIT = 4;
const MEDIA_REQUEST_DELAY_MS = 1300;

const isAvatarTransientError = (error) => {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('timeout') || text.includes('flood') || text.includes('chatforbidden');
};

const isMediaTransientError = (error) => {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('timeout') || text.includes('flood') || text.includes('chatforbidden') || text.includes('rate');
};

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
  const unique = crypto.randomBytes(3).toString('hex');
  const finalBase = prefixSafe ? `${prefixSafe}_${base}` : base;
  return `${finalBase}_${unique}${ext}`;
};

const sanitizeDownloadName = (name, fallback = 'file.bin') => {
  const normalized = String(name || '').trim().replace(/[\/\\]/g, '_');
  if (!normalized) return fallback;
  return normalized.slice(0, 180);
};

const sendDownloadFile = (res, media, downloadName) => {
  const safeName = sanitizeDownloadName(downloadName, 'file.bin');
  const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, (ch) => (
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
    return res.sendFile(media.diskPath);
  } catch (_) {
    return res.download(media.diskPath, safeName);
  }
};

const decodeMultipartFileName = (name) => {
  const raw = String(name || '').trim();
  if (!raw) return '';
  // Typical mojibake case: UTF-8 bytes interpreted as latin1 (e.g. "ÐºÐ²...")
  if (!/[ÐÑ]/.test(raw)) return raw;
  try {
    const repaired = Buffer.from(raw, 'latin1').toString('utf8').trim();
    if (!repaired) return raw;
    // Keep repaired only if it looks like readable Cyrillic/Latin text.
    if (/[\p{Script=Cyrillic}\p{L}\p{N}]/u.test(repaired)) return repaired;
    return raw;
  } catch (_) {
    return raw;
  }
};

const repairFileNameMojibake = (name) => decodeMultipartFileName(name);

const uploadPathToDiskPath = (uploadPath) => {
  const normalized = String(uploadPath || '').trim();
  if (!normalized.startsWith('/uploads/')) return null;
  return path.join(runtimePaths.uploadsDir, normalized.replace('/uploads/', ''));
};

const uploadPathExists = (uploadPath) => {
  const diskPath = uploadPathToDiskPath(uploadPath);
  return !!diskPath && fs.existsSync(diskPath);
};

const resolveMediaMeta = (message) => {
  if (!message?.media) return { hasMedia: false, mediaType: null, ext: '.bin' };
  if (message.media.className === 'MessageMediaContact') {
    return { hasMedia: true, mediaType: 'contact', ext: '.vcf' };
  }
  if (message.media.className === 'MessageMediaPhoto') {
    return { hasMedia: true, mediaType: 'photo', ext: '.jpg' };
  }
  if (message.media.document) {
    const mime = String(message.media.document.mimeType || '').toLowerCase();
    if (mime.includes('mp4') || mime.includes('webm') || mime.includes('quicktime') || mime.includes('video')) {
      return { hasMedia: true, mediaType: 'video', ext: '.mp4' };
    }
    if (mime.includes('ogg') || mime.includes('mp3') || mime.includes('wav') || mime.includes('audio')) {
      return { hasMedia: true, mediaType: 'audio', ext: '.ogg' };
    }
    if (mime.includes('pdf')) return { hasMedia: true, mediaType: 'document', ext: '.pdf' };
    if (mime.includes('png')) return { hasMedia: true, mediaType: 'document', ext: '.png' };
    if (mime.includes('jpeg') || mime.includes('jpg')) return { hasMedia: true, mediaType: 'document', ext: '.jpg' };
    if (mime.includes('webp')) return { hasMedia: true, mediaType: 'document', ext: '.webp' };

    const filenameAttr = message.media.document.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    if (filenameAttr && filenameAttr.fileName) {
      const match = filenameAttr.fileName.match(/(\.\w+)$/);
      if (match) return {
        hasMedia: true,
        mediaType: 'document',
        ext: match[1].toLowerCase(),
        originalName: repairFileNameMojibake(filenameAttr.fileName)
      };
    }
    return { hasMedia: true, mediaType: 'document', ext: '.bin' };
  }
  return { hasMedia: true, mediaType: 'other', ext: '.bin' };
};

const extractMessageContact = (message) => {
  if (!message?.media || message.media.className !== 'MessageMediaContact') return null;
  const media = message.media;
  const firstName = String(media.firstName || '').trim();
  const lastName = String(media.lastName || '').trim();
  const phone = String(media.phoneNumber || '').trim();
  const userId = media.userId ? String(media.userId) : '';
  if (!firstName && !lastName && !phone && !userId) return null;
  return {
    firstName,
    lastName,
    phone,
    userId,
    vcard: String(media.vcard || '')
  };
};

const ensureMessageMediaCached = async ({ client, chatId, messageId }) => {
  const existing = db.prepare('SELECT media_path, media_name FROM message_media WHERE message_id = ? AND peer_id = ?').get(messageId, chatId);
  if (existing?.media_path) {
    const diskPath = path.join(runtimePaths.uploadsDir, existing.media_path.replace('/uploads/', ''));
    if (fs.existsSync(diskPath)) {
      return { mediaPath: existing.media_path, mediaName: repairFileNameMojibake(existing.media_name) || null, diskPath };
    }
  }

  let peer = chatId;
  if (/^-?\d+$/.test(peer)) peer = BigInt(peer);
  const fetched = await client.getMessages(peer, { ids: [messageId] });
  const message = Array.isArray(fetched) ? fetched[0] : fetched;
  if (!message || !message.media) {
    return null;
  }

  const mediaMeta = resolveMediaMeta(message);
  const buffer = await client.downloadMedia(message);
  if (!buffer || buffer.length === 0) {
    throw new Error('Не вдалося завантажити медіа');
  }

  const uploadDir = runtimePaths.mediaDir;
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const fileName = buildStoredMediaFileName({
    originalName: mediaMeta.originalName,
    fallbackBase: `${chatId}_${messageId}`,
    fallbackExt: mediaMeta.ext,
    prefix: 'recv'
  });
  const fullPath = path.join(uploadDir, fileName);
  fs.writeFileSync(fullPath, buffer);
  const relPath = '/uploads/media/' + fileName;
  db.prepare('INSERT OR REPLACE INTO message_media (message_id, peer_id, media_path, media_name) VALUES (?, ?, ?, ?)').run(
    messageId,
    chatId,
    relPath,
    repairFileNameMojibake(mediaMeta.originalName) || null
  );
  return { mediaPath: relPath, mediaName: repairFileNameMojibake(mediaMeta.originalName) || null, diskPath: fullPath };
};

const getCachedMessageMedia = ({ chatId, messageId }) => {
  const existing = db.prepare('SELECT media_path, media_name FROM message_media WHERE message_id = ? AND peer_id = ?').get(messageId, chatId);
  const mediaPath = String(existing?.media_path || '').trim();
  if (!mediaPath) return null;
  const diskPath = path.join(runtimePaths.uploadsDir, mediaPath.replace('/uploads/', ''));
  if (!fs.existsSync(diskPath)) return null;
  return {
    mediaPath,
    mediaName: repairFileNameMojibake(existing?.media_name) || null,
    diskPath
  };
};

const buildInputDialogPeer = async (client, peerCandidate) => {
  const inputPeer = await client.getInputEntity(peerCandidate);
  return new Api.InputDialogPeer({ peer: inputPeer });
};

router.get('/dialogs', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    // Отримуємо всі ігноровані чати
    const ignoredRows = db.prepare('SELECT chat_id FROM ignored_chats').all();
    const ignoredSet = new Set(ignoredRows.map(r => r.chat_id));

    // Отримуємо всі діалоги (якщо є limit у запиті, беремо його, інакше 2000 для першого завантаження)
    const limit = req.query.limit ? parseInt(req.query.limit) : 2000;
    const dialogs = await client.getDialogs({ limit });
    
    const avatarRows = db.prepare('SELECT entity_id, avatar_path FROM avatars').all();
    const avatarMap = new Map();
    const staleAvatarIds = [];
    for (const row of avatarRows) {
      const avatarPath = String(row.avatar_path || '').trim();
      if (!avatarPath) continue;
      if (uploadPathExists(avatarPath)) {
        avatarMap.set(row.entity_id, avatarPath);
      } else {
        staleAvatarIds.push(row.entity_id);
      }
    }
    if (staleAvatarIds.length > 0) {
      const removeAvatarStmt = db.prepare('DELETE FROM avatars WHERE entity_id = ?');
      for (const entityId of staleAvatarIds) removeAvatarStmt.run(entityId);
    }

    const currentUnix = Math.floor(Date.now() / 1000);

    const formattedDialogs = dialogs.map(d => {
        const id = d.entity?.id ? d.entity.id.toString() : null;
        const muteUntil = d.dialog?.notifySettings?.muteUntil || 0;
        return {
            id,
            name: d.name || 'Unknown',
            unreadCount: d.unreadCount,
            unreadMentionsCount: d.dialog?.unreadMentionsCount || 0,
            lastMessage: d.message?.message || '',
            isGroup: d.isGroup,
            isChannel: d.isChannel,
            isUser: d.isUser,
            isBot: d.entity?.bot || false,
            isContact: d.entity?.contact || false,
            archived: d.folderId === 1,
            isPinned: d.pinned,
            date: d.message?.date,
            isIgnored: ignoredSet.has(id),
            isMuted: muteUntil > currentUnix,
            avatarPath: id ? avatarMap.get(id) : null
        };
    }).filter(d => d.id !== null && !(d.isChannel && !d.isGroup));

    res.json(formattedDialogs);

    const userId = context.getUserId();
    setTimeout(() => {
        context.runWithContext({ userId }, async () => {
            const uploadDir = runtimePaths.avatarsDir;
            if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, {recursive: true});

            // Ліниве завантаження: обмежений батч, щоб не навантажувати Telegram API.
            let processed = 0;
            for (const dialog of dialogs) {
                if (processed >= AVATAR_BATCH_LIMIT) break;
                const id = dialog.entity?.id ? dialog.entity.id.toString() : null;
                if (id && dialog.entity && !avatarMap.has(id)) {
                    const blockedUntil = avatarRetryAfterByEntity.get(id) || 0;
                    if (Date.now() < blockedUntil) continue;
                    try {
                        // isBig: false завантажує малу версію дуже швидко (відвертає зависання)
                        const buffer = await Promise.race([
                            client.downloadProfilePhoto(dialog.entity, { isBig: false }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                        ]);

                        if (buffer && buffer.length > 0) {
                            const fileName = id + '_' + crypto.randomBytes(4).toString('hex') + '.jpg';
                            const fullPath = path.join(uploadDir, fileName);
                            fs.writeFileSync(fullPath, buffer);
                            const relPath = '/uploads/avatars/' + fileName;
                            db.prepare('INSERT OR REPLACE INTO avatars (entity_id, avatar_path) VALUES (?, ?)').run(id, relPath);
                            avatarMap.set(id, relPath);
                        } else {
                            db.prepare('INSERT OR REPLACE INTO avatars (entity_id, avatar_path) VALUES (?, ?)').run(id, '');
                            avatarMap.set(id, '');
                        }
                    } catch (e) {
                       if (isAvatarTransientError(e)) {
                         avatarRetryAfterByEntity.set(id, Date.now() + AVATAR_RETRY_MS);
                         console.warn(`[User ${userId}] Пропускаю аватар ${id} на 10 хв: ${e.message}`);
                       } else {
                         console.error(`[User ${userId}] Помилка аватару ${id}:`, e.message);
                       }
                    }
                    
                    processed += 1;
                    await new Promise(r => setTimeout(r, AVATAR_REQUEST_DELAY_MS));
                }
            }
        });
    }, 100);

  } catch (error) {
    console.error('Помилка отримання діалогів:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/topics', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    const rawPeerId = String(req.params.id || '').trim();
    if (!rawPeerId) return res.status(400).json({ error: 'Некоректний ID' });
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 30));

    let peerCandidate = rawPeerId;
    if (/^-?\d+$/.test(rawPeerId)) {
      peerCandidate = BigInt(rawPeerId);
    }

    const channel = await client.getInputEntity(peerCandidate);
    const result = await client.invoke(new Api.channels.GetForumTopics({
      channel,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit,
      q: ''
    }));

    const topics = Array.isArray(result?.topics) ? result.topics : [];
    const mapped = topics
      .filter((topic) => topic && typeof topic.id === 'number')
      .map((topic) => ({
        id: topic.id,
        title: String(topic.title || '').trim() || `Topic ${topic.id}`,
        topMessage: Number(topic.topMessage || 0),
        unreadCount: Number(topic.unreadCount || 0),
        unreadMentionsCount: Number(topic.unreadMentionsCount || 0),
        closed: Boolean(topic.closed),
        hidden: Boolean(topic.hidden)
      }));

    return res.json({ topics: mapped });
  } catch (error) {
    const message = String(error?.message || '');
    if (/TOPIC|FORUM|CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID|CHAT_ID_INVALID/i.test(message)) {
      return res.json({ topics: [] });
    }
    console.error('topics GET error:', error);
    return res.status(500).json({ error: 'Не вдалося завантажити гілки' });
  }
});

// Керування ігноруванням
router.post('/ignore', (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Відсутній chatId' });
  try {
      db.prepare('INSERT OR IGNORE INTO ignored_chats (chat_id) VALUES (?)').run(String(chatId));
      res.json({ success: true, ignored: true });
  } catch (e) {
      res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/unignore', (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Відсутній chatId' });
  try {
      db.prepare('DELETE FROM ignored_chats WHERE chat_id = ?').run(String(chatId));
      res.json({ success: true, ignored: false });
  } catch (e) {
      res.status(500).json({ error: 'Internal server error' });
  }
});


router.get('/folders', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    const folders = await client.invoke(new Api.messages.GetDialogFilters());

    let filtersList = [];
    if (Array.isArray(folders)) filtersList = folders;
    else if (folders && Array.isArray(folders.filters)) filtersList = folders.filters;
    else if (folders && Array.isArray(folders.dialogFilters)) filtersList = folders.dialogFilters;

    const extractTitle = (t) => {
        if (!t) return 'Папка';
        if (typeof t === 'string') return t;
        if (t.text) return t.text;
        return 'Папка';
    };

    const validFilters = filtersList.filter(f => f.id !== undefined);

    const extractId = (p) => p.userId ? p.userId.toString() : (p.chatId ? p.chatId.toString() : (p.channelId ? p.channelId.toString() : null));
    const formattedFolders = validFilters.map(f => ({
        id: f.id,
        title: extractTitle(f.title),
        emoticon: f.emoticon || '',
        contacts: f.contacts || false,
        nonContacts: f.nonContacts || false,
        groups: f.groups || false,
        broadcasts: f.broadcasts || false,
        bots: f.bots || false,
        excludeMuted: f.excludeMuted || false,
        excludeRead: f.excludeRead || false,
        excludeArchived: f.excludeArchived || false,
        includePeers: (f.includePeers || []).map(extractId).filter(Boolean),
        excludePeers: (f.excludePeers || []).map(extractId).filter(Boolean)
    }));

    res.json(formattedFolders);
  } catch (error) {
      console.error('Помилка отримання папок:', error);
      res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/folders', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    
    const { Api } = require('telegram');
    const { id, title, contacts, nonContacts, groups, broadcasts, bots, excludeMuted, includePeers } = req.body;
    
    const includedInputs = [];
    if (includePeers && Array.isArray(includePeers)) {
       for (const p of includePeers) {
          try {
             const ent = await client.getInputEntity(p);
             includedInputs.push(ent);
          } catch(e) {}
       }
    }

    const filterObj = new Api.DialogFilter({
        id: parseInt(id, 10),
        title: new Api.TextWithEntities({ text: String(title || 'Папка').substring(0, 12), entities: [] }),
        contacts: !!contacts,
        nonContacts: !!nonContacts,
        groups: !!groups,
        broadcasts: !!broadcasts,
        bots: !!bots,
        excludeMuted: !!excludeMuted,
        excludeRead: false,
        excludeArchived: false,
        includePeers: includedInputs,
        excludePeers: [],
        pinnedPeers: []
    });

    await client.invoke(
        new Api.messages.UpdateDialogFilter({
            id: parseInt(id, 10),
            filter: filterObj
        })
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Помилка POST /folders:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/folders/:id', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    
    const { Api } = require('telegram');
    const folderId = parseInt(req.params.id, 10);
    
    await client.invoke(
        new Api.messages.UpdateDialogFilter({
            id: folderId,
            filter: undefined
        })
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Помилка DELETE /folders:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/messages/:id', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    const rawPeerId = String(req.params.id);
    const dialogType = String(req.query.dialogType || '').toLowerCase();
    let peerLookup = rawPeerId;
    if (/^-?\d+$/.test(rawPeerId)) {
        peerLookup = BigInt(rawPeerId);
    }

    const peerCandidates = [];
    const seenPeerKeys = new Set();
    const peerKey = (value) => {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'bigint') return `bigint:${value.toString()}`;
        if (typeof value === 'string') return `string:${value}`;
        if (typeof value === 'number') return `number:${value}`;
        const cls = value.className || value.constructor?.name || 'object';
        const id = value.id?.toString?.() || '';
        const userId = value.userId?.toString?.() || '';
        const chatId = value.chatId?.toString?.() || '';
        const channelId = value.channelId?.toString?.() || '';
        return `${cls}:${id}:${userId}:${chatId}:${channelId}`;
    };
    const addPeerCandidate = (candidate) => {
        if (!candidate) return;
        const key = peerKey(candidate);
        if (seenPeerKeys.has(key)) return;
        seenPeerKeys.add(key);
        peerCandidates.push(candidate);
    };

    addPeerCandidate(peerLookup);
    
    // Важкий fallback через dialogs підвантажуємо тільки коли базовий кандидат не дав історію
    let dialogCandidatesResolved = false;
    const ensureDialogCandidates = async () => {
        if (dialogCandidatesResolved) return;
        dialogCandidatesResolved = true;
        try {
            const inputPeer = await client.getInputEntity(peerLookup);
            addPeerCandidate(inputPeer);
        } catch (_) {
            // noop
        }
        try {
            const dialogs = await client.getDialogs({ limit: 2000 });
            const typeMatches = (dialog) => {
                if (!dialogType) return true;
                if (dialogType === 'channel') return !!dialog.isChannel;
                if (dialogType === 'group') return !!dialog.isGroup;
                if (dialogType === 'user') return !!dialog.isUser;
                return true;
            };

            let matchingDialogs = dialogs.filter((dialog) => (
                dialog?.entity?.id?.toString?.() === rawPeerId && typeMatches(dialog)
            ));
            if (matchingDialogs.length === 0) {
                matchingDialogs = dialogs.filter((dialog) => dialog?.entity?.id?.toString?.() === rawPeerId);
            }
            for (const dialog of matchingDialogs) {
                addPeerCandidate(dialog.inputEntity || dialog.entity || null);
            }
        } catch (_) {
            // noop
        }
    };

    // Відмічаємо всі повідомлення прочитаними при відкритті
    try {
        await client.markAsRead(peerLookup);
    } catch(e) { console.error("Помилка markAsRead", e.message); }

    const focusMessageId = Number.parseInt(req.query.focusMessageId, 10);
    const topicTopMessageId = Number.parseInt(req.query.topicTopMessageId, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(500, Math.max(1, requestedLimit))
      : 50;
    const requestedOffsetId = Number.parseInt(req.query.offsetId, 10);
    const offsetId = Number.isFinite(requestedOffsetId) && requestedOffsetId > 0
      ? requestedOffsetId
      : 0;
    const autoDownloadVideo = String(req.query.autoDownloadVideo || '0') !== '0';
    let messages;
    let usedPeer = peerLookup;

    if (Number.isFinite(focusMessageId) && focusMessageId > 0) {
        const focusIds = [];
        for (let currentId = focusMessageId - 3; currentId <= focusMessageId + 3; currentId++) {
            if (currentId > 0) {
                focusIds.push(currentId);
            }
        }

        let focusedSlice = [];
        for (const candidate of peerCandidates) {
            try {
                const focusedMessages = await client.getMessages(candidate, { ids: focusIds });
                const slice = (Array.isArray(focusedMessages) ? focusedMessages : [focusedMessages])
                    .filter(message => message && message.id);
                if (slice.length > 0) {
                    focusedSlice = slice;
                    usedPeer = candidate;
                    break;
                }
            } catch (_) {}
        }
        if (focusedSlice.length === 0) {
            await ensureDialogCandidates();
            for (const candidate of peerCandidates) {
                try {
                    const focusedMessages = await client.getMessages(candidate, { ids: focusIds });
                    const slice = (Array.isArray(focusedMessages) ? focusedMessages : [focusedMessages])
                        .filter(message => message && message.id);
                    if (slice.length > 0) {
                        focusedSlice = slice;
                        usedPeer = candidate;
                        break;
                    }
                } catch (_) {}
            }
        }

        if (focusedSlice.some(message => message.id === focusMessageId)) {
            messages = focusedSlice.sort((a, b) => a.id - b.id);
        }
    }

    if (!messages) {
        const queryOptions = { limit };
        if (offsetId > 0) {
            queryOptions.offsetId = offsetId;
        }
        for (const candidate of peerCandidates) {
            try {
                const fetched = await client.getMessages(candidate, queryOptions);
                const normalized = Array.isArray(fetched) ? fetched : [];
                if (normalized.length > 0) {
                    messages = normalized;
                    usedPeer = candidate;
                    break;
                }
                if (!messages) {
                    messages = normalized;
                }
            } catch (_) {}
        }
        if (!messages || messages.length === 0) {
            await ensureDialogCandidates();
            for (const candidate of peerCandidates) {
                try {
                    const fetched = await client.getMessages(candidate, queryOptions);
                    const normalized = Array.isArray(fetched) ? fetched : [];
                    if (normalized.length > 0) {
                        messages = normalized;
                        usedPeer = candidate;
                        break;
                    }
                    if (!messages) {
                        messages = normalized;
                    }
                } catch (_) {}
            }
        }
        if (!messages) {
            messages = [];
        }
    }
    
    const mediaRows = db.prepare('SELECT message_id, media_path, media_name FROM message_media WHERE peer_id = ?').all(rawPeerId);
    const mediaMap = new Map();
    const staleMediaKeys = [];
    for (const row of mediaRows) {
      const mediaPath = String(row.media_path || '').trim();
      if (!mediaPath) continue;
      if (uploadPathExists(mediaPath)) {
        mediaMap.set(row.message_id, {
          path: mediaPath,
          name: row.media_name ? repairFileNameMojibake(String(row.media_name)) : null
        });
      } else {
        staleMediaKeys.push({ messageId: row.message_id, peerId: rawPeerId });
      }
    }
    if (staleMediaKeys.length > 0) {
      const removeMediaStmt = db.prepare('DELETE FROM message_media WHERE message_id = ? AND peer_id = ?');
      for (const stale of staleMediaKeys) removeMediaStmt.run(stale.messageId, stale.peerId);
    }

    const avatarRows = db.prepare('SELECT entity_id, avatar_path FROM avatars').all();
    const avatarMap = new Map();
    const staleAvatarIds = [];
    for (const row of avatarRows) {
      const avatarPath = String(row.avatar_path || '').trim();
      if (!avatarPath) continue;
      if (uploadPathExists(avatarPath)) {
        avatarMap.set(row.entity_id, avatarPath);
      } else {
        staleAvatarIds.push(row.entity_id);
      }
    }
    if (staleAvatarIds.length > 0) {
      const removeAvatarStmt = db.prepare('DELETE FROM avatars WHERE entity_id = ?');
      for (const entityId of staleAvatarIds) removeAvatarStmt.run(entityId);
    }

    const nowTs = Date.now();
    const senderIds = [...new Set(messages.map(m => m.senderId ? m.senderId.toString() : null).filter(Boolean))];
    const entityCache = {};
    const senderEntities = {};
    for (const sid of senderIds) {
        const cached = senderEntityRuntimeCache.get(sid);
        if (cached && (nowTs - cached.ts) < SENDER_ENTITY_TTL_MS) {
            if (cached.entity) senderEntities[sid] = cached.entity;
            if (cached.name) entityCache[sid] = cached.name;
            continue;
        }
        try {
            const ent = await client.getEntity(sid);
            const name = ent.firstName
                ? (ent.lastName ? `${ent.firstName} ${ent.lastName}` : ent.firstName)
                : (ent.title || 'Користувач');
            senderEntities[sid] = ent;
            entityCache[sid] = name;
            senderEntityRuntimeCache.set(sid, { entity: ent, name, ts: nowTs });
        } catch (e) {
            // Ігноруємо помилки отримання сутності
        }
    }

    let readOutboxMaxId = 0;
    try {
        const inputDialogPeer = await buildInputDialogPeer(client, usedPeer);
        const dialogData = await client.invoke(new Api.messages.GetPeerDialogs({
            peers: [inputDialogPeer]
        }));
        if (dialogData.dialogs && dialogData.dialogs.length > 0) {
            readOutboxMaxId = dialogData.dialogs[0].readOutboxMaxId;
        }
    } catch (e) {
        console.error("Error fetching outbox read status:", e.message);
    }

    const topicFilteredMessages = Number.isFinite(topicTopMessageId) && topicTopMessageId > 0
      ? messages.filter((m) => {
          const replyTopId = Number(
            m?.replyTo?.replyToTopId ||
            m?.replyTo?.replyToMsgId ||
            m?.replyToMsgId ||
            0
          );
          return Number(m?.id || 0) === topicTopMessageId || replyTopId === topicTopMessageId;
        })
      : messages;

    const formattedMessages = topicFilteredMessages.map(m => ({
        id: m.id,
        senderId: m.senderId ? m.senderId.toString() : null,
        senderName: m.senderId ? (entityCache[m.senderId.toString()] || 'Відправник') : null,
        senderAvatarPath: m.senderId ? (avatarMap.get(m.senderId.toString()) || null) : null,
        text: m.message || '',
        date: m.date,
        out: m.out,
        isRead: m.out ? (m.id <= readOutboxMaxId) : true,
        replyTo: m.replyToMsgId,
        mediaPath: mediaMap.get(m.id)?.path || null,
        mediaName: mediaMap.get(m.id)?.name || repairFileNameMojibake(resolveMediaMeta(m).originalName) || null,
        hasMedia: !!m.media,
        mediaType: resolveMediaMeta(m).mediaType,
        contact: extractMessageContact(m)
    }));

    res.json(formattedMessages.reverse()); // Щоб старі були зверху
    
    const userIdMessages = context.getUserId();
    setTimeout(() => {
        context.runWithContext({ userId: userIdMessages }, async () => {
            const avatarUploadDir = runtimePaths.avatarsDir;
            if(!fs.existsSync(avatarUploadDir)) fs.mkdirSync(avatarUploadDir, {recursive: true});

            let processedSenders = 0;
            for (const sid of senderIds) {
                if (processedSenders >= AVATAR_BATCH_LIMIT) break;
                const entity = senderEntities[sid];
                if (!entity || avatarMap.has(sid)) continue;
                const blockedUntil = avatarRetryAfterByEntity.get(sid) || 0;
                if (Date.now() < blockedUntil) continue;

                try {
                    const avatarBuffer = await Promise.race([
                        client.downloadProfilePhoto(entity, { isBig: false }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                    ]);

                    if (avatarBuffer && avatarBuffer.length > 0) {
                        const avatarFileName = sid + '_' + crypto.randomBytes(4).toString('hex') + '.jpg';
                        const avatarFullPath = path.join(avatarUploadDir, avatarFileName);
                        fs.writeFileSync(avatarFullPath, avatarBuffer);
                        const avatarRelPath = '/uploads/avatars/' + avatarFileName;
                        db.prepare('INSERT OR REPLACE INTO avatars (entity_id, avatar_path) VALUES (?, ?)').run(sid, avatarRelPath);
                        avatarMap.set(sid, avatarRelPath);
                    }
                } catch (e) {
                    if (isAvatarTransientError(e)) {
                      avatarRetryAfterByEntity.set(sid, Date.now() + AVATAR_RETRY_MS);
                      console.warn(`[User ${userIdMessages}] Пропускаю аватар відправника ${sid} на 10 хв: ${e.message}`);
                    } else {
                      console.error(`[User ${userIdMessages}] Помилка аватару відправника ${sid}:`, e.message);
                    }
                }

                processedSenders += 1;
                await new Promise(r => setTimeout(r, AVATAR_REQUEST_DELAY_MS));
            }

            const uploadDir = runtimePaths.mediaDir;
            if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, {recursive: true});
            
            let processedMedia = 0;
            for (const m of messages) {
                if (m.media && !mediaMap.has(m.id)) {
                    if (processedMedia >= MEDIA_BATCH_LIMIT) break;
                    const retryKey = `${rawPeerId}:${m.id}`;
                    const blockedUntil = mediaRetryAfterByMessage.get(retryKey) || 0;
                    if (Date.now() < blockedUntil) continue;
                    try {
                        const mediaMeta = resolveMediaMeta(m);
                        if (mediaMeta.mediaType === 'video' && !autoDownloadVideo) {
                            continue;
                        }
                        const buffer = await Promise.race([
                            client.downloadMedia(m),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
                        ]);
                        
                        if (buffer && buffer.length > 0) {
                            const fileName = buildStoredMediaFileName({
                              originalName: mediaMeta.originalName,
                              fallbackBase: `${rawPeerId}_${m.id}`,
                              fallbackExt: mediaMeta.ext,
                              prefix: 'recv'
                            });
                            const fullPath = path.join(uploadDir, fileName);
                            fs.writeFileSync(fullPath, buffer);
                            const relPath = '/uploads/media/' + fileName;
                            db.prepare('INSERT OR REPLACE INTO message_media (message_id, peer_id, media_path, media_name) VALUES (?, ?, ?, ?)').run(
                              m.id,
                              rawPeerId,
                              relPath,
                              repairFileNameMojibake(mediaMeta.originalName) || null
                            );
                            mediaMap.set(m.id, { path: relPath, name: repairFileNameMojibake(mediaMeta.originalName) || null });
                        } else {
                            db.prepare('INSERT OR REPLACE INTO message_media (message_id, peer_id, media_path, media_name) VALUES (?, ?, ?, ?)').run(
                              m.id,
                              rawPeerId,
                              '',
                              repairFileNameMojibake(mediaMeta.originalName) || null
                            );
                            mediaMap.set(m.id, { path: '', name: repairFileNameMojibake(mediaMeta.originalName) || null });
                        }
                        mediaRetryAfterByMessage.delete(retryKey);
                        processedMedia += 1;
                        await new Promise(r => setTimeout(r, MEDIA_REQUEST_DELAY_MS));
                    } catch(e) {
                         if (isMediaTransientError(e)) {
                            mediaRetryAfterByMessage.set(retryKey, Date.now() + MEDIA_RETRY_MS);
                         }
                         console.error(`[User ${userIdMessages}] Помилка медіа (таймаут/API) ${m.id}:`, e.message);
                    }
                }
            }
        });
    }, 100);

  } catch (error) {
    console.error(`Помилка отримання повідомлень для ${req.params.id}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/messages/:chatId/:messageId/download-media', async (req, res) => {
  try {
    const chatId = String(req.params.chatId);
    const messageId = Number.parseInt(req.params.messageId, 10);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      return res.status(400).json({ error: 'Невірний messageId' });
    }

    let media = getCachedMessageMedia({ chatId, messageId });
    if (!media) {
      const client = getClient();
      if (!client || !client.connected) {
        return res.status(401).json({ error: 'Telegram клієнт не підключений' });
      }
      media = await ensureMessageMediaCached({ client, chatId, messageId });
    }
    if (!media) {
      return res.status(404).json({ error: 'Медіа не знайдено у повідомленні' });
    }
    res.json({ success: true, mediaPath: media.mediaPath, mediaName: media.mediaName || null });
  } catch (error) {
    console.error('Помилка ручного завантаження медіа:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/messages/:chatId/:messageId/file', async (req, res) => {
  try {
    const chatId = String(req.params.chatId);
    const messageId = Number.parseInt(req.params.messageId, 10);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      return res.status(400).json({ error: 'Невірний messageId' });
    }

    let media = getCachedMessageMedia({ chatId, messageId });
    if (!media) {
      const client = getClient();
      if (!client || !client.connected) {
        return res.status(401).json({ error: 'Telegram клієнт не підключений' });
      }
      media = await ensureMessageMediaCached({ client, chatId, messageId });
    }
    if (!media || !media.diskPath || !fs.existsSync(media.diskPath)) {
      return res.status(404).json({ error: 'Файл не знайдено' });
    }

    const ext = path.extname(media.diskPath) || '.bin';
    const fallbackName = `file_${chatId}_${messageId}${ext}`;
    const downloadName = sanitizeDownloadName(media.mediaName || fallbackName, fallbackName);
    return sendDownloadFile(res, media, downloadName);
  } catch (error) {
    console.error('Помилка скачування медіа-файлу:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/send', upload.single('file'), (req, res, next) => {
  const userId = req.userId || context.getUserId();
  if (userId) {
    context.runWithContext({ userId }, next);
  } else {
    next();
  }
}, async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    const { peerId, message, replyTo } = req.body;
    if (!peerId) {
      return res.status(400).json({ error: 'peerId обов\'язковий' });
    }

    let targetPeer = peerId;
    if (/^-?\d+$/.test(targetPeer)) {
        targetPeer = BigInt(targetPeer);
    }

    const options = {};
    if (replyTo) options.replyTo = parseInt(replyTo);

    let result;
    if (req.file) {
      const normalizedOriginalName = decodeMultipartFileName(req.file.originalname);
      const ext = path.extname(normalizedOriginalName) || '';
      const nameParts = splitNameAndExt(normalizedOriginalName, ext || '.bin');
      let storedName = `${nameParts.base}${nameParts.ext}`;
      const candidatePath = path.join(runtimePaths.mediaDir, storedName);
      if (fs.existsSync(candidatePath)) {
        storedName = `${nameParts.base}_${crypto.randomBytes(3).toString('hex')}${nameParts.ext}`;
      }
      const newPath = path.join(runtimePaths.mediaDir, storedName);
      fs.renameSync(req.file.path, newPath);
        
        options.caption = message || '';
        options.file = newPath;
        result = await client.sendFile(targetPeer, options);
        
        const relPath = '/uploads/media/' + storedName;
        db.prepare('INSERT OR REPLACE INTO message_media (message_id, peer_id, media_path, media_name) VALUES (?, ?, ?, ?)').run(
          result.id,
          String(peerId),
          relPath,
          repairFileNameMojibake(normalizedOriginalName) || null
        );
    } else {
        options.message = message || '';
        result = await client.sendMessage(targetPeer, options);
    }

    const mediaRow = db.prepare('SELECT media_path, media_name FROM message_media WHERE message_id = ? AND peer_id = ?').get(result.id, String(peerId));

    const formattedMessage = {
        id: result.id,
        senderId: result.senderId ? result.senderId.toString() : null,
        text: result.message || '',
        date: result.date,
        out: result.out,
        isRead: false,
        replyTo: result.replyToMsgId,
        mediaPath: mediaRow ? mediaRow.media_path : null,
        mediaName: mediaRow ? (repairFileNameMojibake(mediaRow.media_name) || null) : null
    };

    res.json(formattedMessage);
  } catch (error) {
    console.error('Помилка відправки повідомлення:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/send-contact', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) {
      return res.status(401).json({ error: 'Telegram клієнт не підключений' });
    }

    const peerId = String(req.body?.peerId || '').trim();
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const userId = String(req.body?.userId || '').trim();

    if (!peerId) return res.status(400).json({ error: 'peerId обовʼязковий' });
    if (!firstName && !lastName) return res.status(400).json({ error: 'Імʼя контакту обовʼязкове' });
    if (!phone) return res.status(400).json({ error: 'Телефон контакту обовʼязковий' });

    let targetPeer = peerId;
    if (/^-?\d+$/.test(targetPeer)) {
      targetPeer = BigInt(targetPeer);
    }
    const peer = await client.getInputEntity(targetPeer);

    const randomId = BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000000));
    await client.invoke(new Api.messages.SendMedia({
      peer,
      media: new Api.InputMediaContact({
        phoneNumber: phone,
        firstName: firstName || 'Контакт',
        lastName: lastName || '',
        vcard: ''
      }),
      message: '',
      randomId
    }));

    res.json({
      success: true,
      contact: {
        firstName,
        lastName,
        phone,
        userId
      }
    });
  } catch (error) {
    console.error('Помилка відправки контакту:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/open-media-folder', (req, res) => {
  try {
    const mediaPath = String(req.body?.mediaPath || '').trim();
    if (!mediaPath) {
      return res.status(400).json({ error: 'mediaPath обовʼязковий' });
    }

    const marker = '/uploads/media/';
    if (!mediaPath.includes(marker)) {
      return res.status(400).json({ error: 'Невірний шлях файлу' });
    }

    const fileName = path.basename(mediaPath);
    if (!fileName) {
      return res.status(400).json({ error: 'Невірна назва файлу' });
    }

    const mediaDir = runtimePaths.mediaDir;
    const fullPath = path.join(mediaDir, fileName);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Файл не знайдено на диску' });
    }

    const done = (error) => {
      if (error) {
        console.error('open-media-folder error:', error);
      }
    };

    if (process.platform === 'darwin') {
      execFile('open', ['-R', fullPath], done);
    } else if (process.platform === 'win32') {
      execFile('explorer.exe', [path.dirname(fullPath)], done);
    } else {
      execFile('xdg-open', [path.dirname(fullPath)], done);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Помилка відкриття папки файлу:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/forward', async (req, res) => {
  try {
    const client = getClient();
    if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });

    const { fromPeer, toPeer, messageId, messageIds } = req.body;
    const normalizedIds = Array.isArray(messageIds)
      ? messageIds.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id))
      : (messageId != null ? [parseInt(messageId, 10)].filter((id) => Number.isFinite(id)) : []);

    if (!fromPeer || !toPeer || normalizedIds.length === 0) {
        return res.status(400).json({ error: 'fromPeer, toPeer, and messageId(s) are required' });
    }

    let source = fromPeer;
    if (/^-?\d+$/.test(source)) source = BigInt(source);
    let target = toPeer;
    if (/^-?\d+$/.test(target)) target = BigInt(target);

    // GramJS forwardMessages
    const result = await client.forwardMessages(target, {
        messages: normalizedIds,
        fromPeer: source,
        dropAuthor: false,
        dropMediaCaptions: false
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Помилка пересилання:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Chat general notes
router.get('/:id/note', (req, res) => {
    try {
        const row = db.prepare('SELECT content, anchor_message_id FROM notes WHERE chat_id = ?').get(String(req.params.id));
        res.json({
            content: row ? row.content : '',
            anchorMessageId: row ? row.anchor_message_id : null
        });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/note', (req, res) => {
    try {
        const { content, anchorMessageId } = req.body;
        db.prepare(
            'INSERT OR REPLACE INTO notes (chat_id, content, anchor_message_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
        ).run(
            String(req.params.id),
            content || '',
            Number.isFinite(Number(anchorMessageId)) ? Number(anchorMessageId) : null
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:id/note', (req, res) => {
    try {
        db.prepare('DELETE FROM notes WHERE chat_id = ?').run(String(req.params.id));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get local pins
router.get('/local_pins', (req, res) => {
    try {
        const rows = db.prepare('SELECT folder_id, chat_id, pinned_at FROM local_pins').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Pin/Unpin chat locally
router.post('/:id/pin', async (req, res) => {
    try {
        const { pinned, folderId } = req.body;
        const targetFolder = folderId === null ? 'main' : String(folderId);
        const chatId = String(req.params.id);

        if (pinned) {
            db.prepare('INSERT OR REPLACE INTO local_pins (folder_id, chat_id, pinned_at) VALUES (?, ?, ?)').run(targetFolder, chatId, Date.now());
        } else {
            db.prepare('DELETE FROM local_pins WHERE folder_id = ? AND chat_id = ?').run(targetFolder, chatId);
        }
        
        res.json({ success: true, pinned, folder_id: targetFolder });
    } catch (e) {
        console.error("Local toggle pin error:", e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Pin / Unpin message in chat
router.post('/:chatId/messages/:msgId/pin', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const { chatId, msgId } = req.params;
        const { pinned } = req.body; // true to pin, false to unpin

        let peer = chatId;
        if (/^-?\d+$/.test(peer)) peer = BigInt(peer);

        await client.invoke(new (require('telegram').Api).messages.UpdatePinnedMessage({
            peer: peer,
            id: parseInt(msgId, 10),
            pinned: pinned,
            pmOneSide: false
        }));

        res.json({ success: true, pinned });
    } catch (e) {
        console.error("Pin message error:", e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get pinned messages for a chat
router.get('/:chatId/pinned', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const { chatId } = req.params;
        let peer = chatId;
        if (/^-?\d+$/.test(peer)) peer = BigInt(peer);

        const { Api } = require('telegram');
        
        const result = await client.invoke(new Api.messages.Search({
            peer: peer,
            q: '',
            filter: new Api.InputMessagesFilterPinned(),
            minDate: 0,
            maxDate: 0,
            offsetId: 0,
            addOffset: 0,
            limit: 100,
            maxId: 0,
            minId: 0,
            hash: BigInt(0)
        }));

        // result.messages will contain the pinned messages
        // map to our format
        const formattedMessages = result.messages.map(m => ({
            id: m.id,
            senderId: m.senderId ? m.senderId.toString() : null,
            text: m.message || '',
            date: m.date,
            out: m.out,
            replyTo: m.replyToMsgId
        }));

        res.json(formattedMessages);
    } catch (e) {
        console.error("Get pinned messages error:", e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new group
router.post('/create_group', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const { title, users } = req.body;
        // users can be an array of user ids or usernames
        const { Api } = require('telegram');
        
        const result = await client.invoke(new Api.messages.CreateChat({
            users: users,
            title: title
        }));

        res.json({ success: true, result });
    } catch (e) {
        console.error("Create group error:", e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add user to group
router.post('/:chatId/add_user', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const { chatId } = req.params;
        const { userId } = req.body;

        let peer = chatId;
        if (/^-?\d+$/.test(peer)) peer = BigInt(peer); // It's usually the negative id, but we might need the absolute id for AddChatUser
        
        // Telegram API expects positive chat_id for AddChatUser, not the peer.
        // If chatId is -123456, we should pass 123456 as chatId
        let chat_id_num = parseInt(chatId, 10);
        if (chat_id_num < 0) chat_id_num = Math.abs(chat_id_num);
        // Note: For supergroups / channels, InviteToChannel is used instead!
        // We'll try AddChatUser first, then InviteToChannel if it fails or if it's a channel.

        const { Api } = require('telegram');
        try {
            await client.invoke(new Api.messages.AddChatUser({
                chatId: BigInt(chat_id_num),
                userId: userId,
                fwdLimit: 50
            }));
            res.json({ success: true });
        } catch (err) {
            // If it's a megagroup or channel, AddChatUser fails, use InviteToChannel
            console.log("AddChatUser failed, trying InviteToChannel...");
            await client.invoke(new Api.channels.InviteToChannel({
                channel: peer,
                users: [userId]
            }));
            res.json({ success: true });
        }

    } catch (e) {
        console.error("Add user to group error:", e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:chatId/member/:userId', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });

        const { chatId, userId } = req.params;
        let peer = chatId;
        if (/^-?\d+$/.test(peer)) peer = BigInt(peer);

        const userEntity = await client.getInputEntity(userId);
        let chatIdNum = parseInt(chatId, 10);
        if (chatIdNum < 0) chatIdNum = Math.abs(chatIdNum);

        try {
            await client.invoke(new Api.messages.DeleteChatUser({
                chatId: BigInt(chatIdNum),
                userId: userEntity,
                revokeHistory: true
            }));
        } catch (err) {
            await client.invoke(new Api.channels.EditBanned({
                channel: peer,
                participant: userEntity,
                bannedRights: new Api.ChatBannedRights({
                    untilDate: 0,
                    viewMessages: true,
                    sendMessages: true,
                    sendMedia: true,
                    sendStickers: true,
                    sendGifs: true,
                    sendGames: true,
                    sendInline: true,
                    embedLinks: true
                })
            }));
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Remove user from group error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:chatId/dialog', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });

        const { chatId } = req.params;
        const { revoke } = req.body || {};

        let peer = chatId;
        if (/^-?\d+$/.test(peer)) peer = BigInt(peer);

        await client.invoke(new Api.messages.DeleteHistory({
            peer,
            maxId: 0,
            revoke: revoke !== false,
            justClear: false,
            minDate: 0,
            maxDate: 0
        }));

        db.prepare('DELETE FROM notes WHERE chat_id = ?').run(String(chatId));
        db.prepare('DELETE FROM ignored_chats WHERE chat_id = ?').run(String(chatId));
        db.prepare('DELETE FROM local_pins WHERE chat_id = ?').run(String(chatId));

        res.json({ success: true });
    } catch (e) {
        console.error('Delete dialog error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:chatId/group', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });

        const { chatId } = req.params;
        let peer = chatId;
        if (/^-?\d+$/.test(peer)) peer = BigInt(peer);

        const me = await client.getMe();
        const meEntity = await client.getInputEntity(me.id);
        let chatIdNum = parseInt(chatId, 10);
        if (chatIdNum < 0) chatIdNum = Math.abs(chatIdNum);

        try {
            await client.invoke(new Api.channels.DeleteChannel({
                channel: peer
            }));
        } catch (deleteErr) {
            try {
                await client.invoke(new Api.channels.LeaveChannel({
                    channel: peer
                }));
            } catch (leaveErr) {
                await client.invoke(new Api.messages.DeleteChatUser({
                    chatId: BigInt(chatIdNum),
                    userId: meEntity,
                    revokeHistory: false
                }));
            }
        }

        db.prepare('DELETE FROM notes WHERE chat_id = ?').run(String(chatId));
        db.prepare('DELETE FROM ignored_chats WHERE chat_id = ?').run(String(chatId));
        db.prepare('DELETE FROM local_pins WHERE chat_id = ?').run(String(chatId));

        res.json({ success: true });
    } catch (e) {
        console.error('Delete group error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Edit message
router.put('/messages', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const { peerId, messageId, text } = req.body;
        
        let targetPeer = peerId;
        if (/^-?\d+$/.test(targetPeer)) targetPeer = BigInt(targetPeer);

        await client.editMessage(targetPeer, { message: parseInt(messageId), text: text });
        res.json({ success: true });
    } catch (e) {
        console.error("Error editing message:", e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete messages
router.delete('/messages', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const { peerId, messageIds, revoke } = req.body;
        
        let targetPeer = peerId;
        if (/^-?\d+$/.test(targetPeer)) targetPeer = BigInt(targetPeer);

        await client.deleteMessages(targetPeer, messageIds, { revoke: revoke !== false }); // За замовчуванням видаляємо для всіх
        res.json({ success: true });
    } catch (e) {
        console.error("Error deleting messages:", e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get participants for mentions
router.get('/:id/participants', async (req, res) => {
    try {
        const client = getClient();
        if (!client || !client.connected) return res.status(401).json({ error: 'Telegram клієнт не підключений' });
        
        const rawPeerId = String(req.params.id);
        let peerLookup = rawPeerId;
        if (/^-?\d+$/.test(rawPeerId)) peerLookup = BigInt(rawPeerId);
        let peer = peerLookup;
        try {
            peer = await client.getInputEntity(peerLookup);
        } catch (_) {
            peer = peerLookup;
        }

        let participants = await client.getParticipants(peer);
        if ((!Array.isArray(participants) || participants.length === 0) && peer !== peerLookup) {
            participants = await client.getParticipants(peerLookup);
        }
        const formatted = participants.map(p => ({
            id: p.id.toString(),
            firstName: p.firstName || '',
            lastName: p.lastName || '',
            username: p.username || '',
        }));
        res.json(formatted);
    } catch (e) {
        console.error("Error fetching participants:", e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
