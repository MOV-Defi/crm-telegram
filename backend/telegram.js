const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const db = require('./db');
const context = require('./context');
const runtimePaths = require('./runtime-paths');
const fs = require('fs');
const path = require('path');

const clientsData = new Map();

const getTenantState = () => {
    const userId = context.getUserId();
    if (!userId) {
        // Fallback or better error for debugging
        const stack = new Error().stack;
        console.error('getTenantState called outside of user context! Stack:', stack);
        throw new Error('Telegram access outside of user context');
    }
    
    if (!clientsData.has(userId)) {
        clientsData.set(userId, {
            userId,
            client: null,
            clientOwnerUserId: null,
            authResolvers: { phoneNumber: null, phoneCode: null, password: null },
            authCache: { phoneNumber: null, phoneCode: null, password: null },
            authFlowActive: false,
            authFlowPromise: null
        });
    }
    return clientsData.get(userId);
};

const resetAuthState = (state) => {
    state.authCache = { phoneNumber: null, phoneCode: null, password: null };
    state.authResolvers = { phoneNumber: null, phoneCode: null, password: null };
};

const sessionsDir = path.join(runtimePaths.dataRoot, 'telegram_sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const getSessionFilePath = (userId) => path.join(sessionsDir, `user_${String(userId)}.session`);

const getSession = () => {
  const userId = context.getUserId();
  const filePath = getSessionFilePath(userId);

  // 1) Пріоритет: стабільний persistent файл у /data
  try {
    if (fs.existsSync(filePath)) {
      const value = String(fs.readFileSync(filePath, 'utf8') || '').trim();
      if (value) return value;
    }
  } catch (_) {}

  // Intentional: do not fallback to legacy DB session key.
  // This prevents accidental cross-account reuse when old data exists.
  return '';
};

const saveSession = (sessionString) => {
  const userId = context.getUserId();
  const filePath = getSessionFilePath(userId);
  const safeValue = String(sessionString || '').trim();

  // Зберігаємо і в settings, і у persistent файл
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('tg_session', safeValue);
  try {
    fs.writeFileSync(filePath, safeValue, 'utf8');
  } catch (error) {
    console.error(`[User ${userId}] Failed to write telegram session file:`, error.message);
  }
};

const initTelegramClient = async (apiId, apiHash) => {
  const state = getTenantState();
  const userId = context.getUserId();
  const sessionString = getSession();
  const stringSession = new StringSession(sessionString);
  
  state.client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
    connectionRetries: 5,
  });
  state.clientOwnerUserId = userId;

  if (sessionString) {
    try {
      await state.client.connect();
      console.log(`[User ${context.getUserId()}] Підключено до Telegram за існуючою сесією!`);
      return state.client;
    } catch (e) {
      console.error(`[User ${context.getUserId()}] Не вдалося підключитися (сесія невірна або застаріла):`, e);
    }
  }

  return state.client;
};

const getAuthStep = () => {
    try {
        const state = getTenantState();
        if (state.authResolvers.password) return 'password';
        if (state.authResolvers.phoneCode) return 'code';
        if (state.authResolvers.phoneNumber) return 'phone';
        return null;
    } catch(e) {
        const userId = context.getUserId();
        // Start the background auth flow, preserving the user context
        context.runWithContext({ userId }, () => {
            startAuthFlow().catch(err => {
                console.error(`[User ${userId}] Auth flow error:`, err);
                const state = getTenantState();
                state.currentAuthStep = { step: 'error', error: err.message };
            });
        });
        
        return { success: true };
    }
};

const startAuthFlow = async () => {
    const state = getTenantState();
    if (!state.client) {
        return { success: false, error: 'Telegram клієнт не ініціалізовано' };
    }
    if (state.authFlowActive && state.authFlowPromise) {
        return state.authFlowPromise;
    }
    resetAuthState(state);
    state.authFlowActive = true;
    
    state.authFlowPromise = (async () => {
        try {
            console.log(`[User ${context.getUserId()}] Починаємо client.start()...`);
            await state.client.start({
                phoneNumber: async () => {
                    if (state.authCache.phoneNumber) return state.authCache.phoneNumber;
                    return new Promise(resolve => state.authResolvers.phoneNumber = resolve);
                },
                password: async () => {
                    if (state.authCache.password) return state.authCache.password;
                    return new Promise(resolve => state.authResolvers.password = resolve);
                },
                phoneCode: async () => {
                    if (state.authCache.phoneCode) return state.authCache.phoneCode;
                    return new Promise(resolve => state.authResolvers.phoneCode = resolve);
                },
                onError: (err) => console.log(`[User ${context.getUserId()}] Telegram Auth Error:`, err),
            });
            
            console.log(`[User ${context.getUserId()}] Ви успішно авторизовані!`);
            saveSession(state.client.session.save());
            return { success: true };
        } catch (error) {
            console.error(`[User ${context.getUserId()}] Помилка авторизації:`, error);
            return { success: false, error: error.message };
        } finally {
            state.authFlowActive = false;
            state.authFlowPromise = null;
        }
    })();
    return state.authFlowPromise;
};

const resolveAuthStep = (step, value) => {
    try {
        const state = getTenantState();
        if (!String(value || '').trim()) return false;
        if (state.authResolvers[step]) {
            state.authResolvers[step](value);
            state.authResolvers[step] = null;
            return true;
        }
        if (!state.authFlowActive) {
            return false;
        }
        state.authCache[step] = value;
        return true;
    } catch(e) {
        return false;
    }
};

const getClient = () => {
    try {
        const state = getTenantState();
        const currentUserId = context.getUserId();
        if (state.client && state.clientOwnerUserId !== currentUserId) {
            console.warn(`[User ${currentUserId}] Blocked foreign telegram client reuse (owner: ${state.clientOwnerUserId}).`);
            return null;
        }
        return state.client;
    } catch (e) {
        return null;
    }
};

const disconnectTelegramClient = async () => {
    try {
        const state = getTenantState();
        if (state.client) {
            try {
                await state.client.disconnect();
            } catch(e) {}
            state.client = null;
            state.clientOwnerUserId = null;
        }
        resetAuthState(state);
        state.authFlowPromise = null;
        state.authFlowActive = false;
    } catch (e) {}
};

const logoutTelegramClient = async () => {
    try {
        const userId = context.getUserId();
        const state = getTenantState();
        if (state.client) {
            try {
                const { Api } = require('telegram');
                await state.client.invoke(new Api.auth.LogOut());
            } catch(e) {}
            try {
                await state.client.disconnect();
            } catch(e) {}
            state.client = null;
            state.clientOwnerUserId = null;
        }
        resetAuthState(state);
        state.authFlowPromise = null;
        state.authFlowActive = false;
        db.prepare("DELETE FROM settings WHERE key = 'tg_session'").run();
        try {
          const filePath = getSessionFilePath(userId);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
    } catch(e) {}
};

module.exports = {
    initTelegramClient,
    startAuthFlow,
    resolveAuthStep,
    getClient,
    getAuthStep,
    disconnectTelegramClient,
    logoutTelegramClient
};
