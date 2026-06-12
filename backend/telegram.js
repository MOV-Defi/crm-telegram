const loadTelegramDependencies = () => {
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function patchedTelegramDependencyLoad(request, parent, isMain) {
        if (request === 'bufferutil') {
            return require('bufferutil/fallback');
        }
        return originalLoad.apply(this, arguments);
    };
    try {
        return {
            TelegramClient: require('telegram').TelegramClient,
            StringSession: require('telegram/sessions').StringSession,
            ConnectionTCPObfuscated: require('telegram/network').ConnectionTCPObfuscated,
            ConnectionTCPAbridged: require('telegram/network').ConnectionTCPAbridged
        };
    } finally {
        Module._load = originalLoad;
    }
};

const { TelegramClient, StringSession, ConnectionTCPObfuscated, ConnectionTCPAbridged } = loadTelegramDependencies();
const db = require('./db');
const context = require('./context');
const runtimePaths = require('./runtime-paths');
const fs = require('fs');
const path = require('path');

const clientsData = new Map();
const DEFAULT_TELEGRAM_DC = { dcId: 4, host: '149.154.167.91' };

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBooleanEnv = (value, fallback) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
};

const TELEGRAM_CONNECT_TIMEOUT_SEC = parsePositiveInt(process.env.TELEGRAM_CONNECT_TIMEOUT_SEC, 20);
const TELEGRAM_CONNECTION_RETRIES = parsePositiveInt(process.env.TELEGRAM_CONNECTION_RETRIES, 8);
const TELEGRAM_RETRY_DELAY_MS = parsePositiveInt(process.env.TELEGRAM_RETRY_DELAY_MS, 1500);
const TELEGRAM_USE_HTTPS_PORT = parseBooleanEnv(process.env.TELEGRAM_USE_HTTPS_PORT, true);
const TELEGRAM_CONNECTION_MODE = String(process.env.TELEGRAM_CONNECTION_MODE || 'obfuscated').trim().toLowerCase();

const getTelegramConnectionClass = () => {
    if (TELEGRAM_CONNECTION_MODE === 'abridged') return ConnectionTCPAbridged;
    return ConnectionTCPObfuscated;
};

const getTelegramProxy = () => {
    const host = String(process.env.TELEGRAM_PROXY_HOST || '').trim();
    const port = parsePositiveInt(process.env.TELEGRAM_PROXY_PORT, 0);
    if (!host || !port) return undefined;
    return {
        ip: host,
        port,
        socksType: parsePositiveInt(process.env.TELEGRAM_PROXY_SOCKS_TYPE, 5),
        username: String(process.env.TELEGRAM_PROXY_USERNAME || '').trim() || undefined,
        password: String(process.env.TELEGRAM_PROXY_PASSWORD || '').trim() || undefined,
        timeout: parsePositiveInt(process.env.TELEGRAM_PROXY_TIMEOUT_SEC, TELEGRAM_CONNECT_TIMEOUT_SEC)
    };
};

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
            authFlowPromise: null,
            authError: null,
            authErrorLogged: false
        });
    }
    return clientsData.get(userId);
};

const resetAuthState = (state) => {
    state.authCache = { phoneNumber: null, phoneCode: null, password: null };
    state.authResolvers = { phoneNumber: null, phoneCode: null, password: null };
    state.authError = null;
    state.authErrorLogged = false;
};

const formatAuthError = (error) => {
    const rawSeconds = Number(error?.seconds || 0);
    let seconds = Number.isFinite(rawSeconds) ? rawSeconds : 0;
    const rawMessage = String(error?.message || error || 'Telegram auth failed');
    if (!seconds) {
        const match = rawMessage.match(/wait of (\d+) seconds/i);
        if (match) seconds = Number(match[1]);
    }
    if (seconds > 0) {
        const minutes = Math.ceil(seconds / 60);
        return `Telegram тимчасово обмежив вхід через багато спроб. Зачекайте ${seconds} секунд (приблизно ${minutes} хв) і спробуйте знову.`;
    }
    if (isTelegramNetworkError(error)) {
        return 'Telegram зараз не відповідає з сервера. Ми зробили кілька спроб підключення, але мережа Telegram недоступна. Спробуйте ще раз через хвилину.';
    }
    return rawMessage;
};

const setAuthError = (state, error) => {
    state.authError = formatAuthError(error);
    if (!state.authErrorLogged) {
        console.warn(`[User ${context.getUserId()}] Telegram auth stopped: ${state.authError}`);
        state.authErrorLogged = true;
    }
    return state.authError;
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

const normalizeTelegramSessionTransport = (stringSession) => {
  const dcId = stringSession.dcId || DEFAULT_TELEGRAM_DC.dcId;
  const host = stringSession.serverAddress || DEFAULT_TELEGRAM_DC.host;
  const port = TELEGRAM_USE_HTTPS_PORT ? 443 : 80;
  stringSession.setDC(dcId, host, port);
};

const isTelegramNetworkError = (error) => {
    const message = String(error?.message || error || '').toLowerCase();
    const code = String(error?.code || '').toLowerCase();
    return (
        code === 'etimedout' ||
        code === 'econnreset' ||
        code === 'econnrefused' ||
        code === 'enetwork' ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('etimedout') ||
        message.includes('connection closed') ||
        message.includes('not connected')
    );
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, timeoutMs, label) => {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timeout after ' + timeoutMs + 'ms')), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
};

const connectTelegramClient = async (state, reason = 'connect') => {
    if (!state.client) {
        throw new Error('Telegram клієнт не ініціалізовано');
    }
    if (state.client.connected) return state.client;

    let lastError = null;
    const timeoutMs = TELEGRAM_CONNECT_TIMEOUT_SEC * 1000;
    for (let attempt = 1; attempt <= TELEGRAM_CONNECTION_RETRIES; attempt += 1) {
        try {
            console.log(`[User ${context.getUserId()}] Telegram ${reason}: attempt ${attempt}/${TELEGRAM_CONNECTION_RETRIES}`);
            await withTimeout(state.client.connect(), timeoutMs, 'Telegram connect');
            normalizeTelegramSessionTransport(state.client.session);
            return state.client;
        } catch (error) {
            lastError = error;
            console.warn(`[User ${context.getUserId()}] Telegram ${reason} failed (${attempt}/${TELEGRAM_CONNECTION_RETRIES}):`, error?.message || error);
            try {
                await state.client.disconnect();
            } catch (_) {}
            if (attempt < TELEGRAM_CONNECTION_RETRIES) {
                await wait(TELEGRAM_RETRY_DELAY_MS * attempt);
            }
        }
    }

    throw lastError || new Error('Telegram connect failed');
};

const initTelegramClient = async (apiId, apiHash) => {
  const state = getTenantState();
  const userId = context.getUserId();
  const sessionString = getSession();
  const stringSession = new StringSession(sessionString);
  normalizeTelegramSessionTransport(stringSession);
  
  state.client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
    connection: getTelegramConnectionClass(),
    connectionRetries: TELEGRAM_CONNECTION_RETRIES,
    retryDelay: TELEGRAM_RETRY_DELAY_MS,
    timeout: TELEGRAM_CONNECT_TIMEOUT_SEC,
    requestRetries: 5,
    useWSS: TELEGRAM_USE_HTTPS_PORT,
    proxy: getTelegramProxy(),
    appVersion: 'Solar Service CRM',
    deviceModel: 'Railway Node.js',
    systemVersion: process.version
  });
  try {
    state.client.setLogLevel('warn');
  } catch (_) {}
  state.clientOwnerUserId = userId;

  if (sessionString) {
    try {
      await connectTelegramClient(state, 'session restore');
      console.log(`[User ${context.getUserId()}] Підключено до Telegram за існуючою сесією!`);
      return state.client;
    } catch (e) {
      console.error(`[User ${context.getUserId()}] Не вдалося підключитися до Telegram за існуючою сесією:`, e?.message || e);
      setAuthError(state, e);
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
            await connectTelegramClient(state, 'auth start');
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
                onError: (err) => {
                    setAuthError(state, err);
                    return true;
                },
            });
            
            console.log(`[User ${context.getUserId()}] Ви успішно авторизовані!`);
            normalizeTelegramSessionTransport(state.client.session);
            saveSession(state.client.session.save());
            return { success: true };
        } catch (error) {
            const message = setAuthError(state, error);
            return { success: false, error: message };
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
            state.authCache[step] = value;
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

const getAuthError = () => {
    try {
        const state = getTenantState();
        return state.authError || null;
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
    getAuthError,
    disconnectTelegramClient,
    logoutTelegramClient
};
