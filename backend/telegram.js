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
            Api: require('telegram').Api,
            StringSession: require('telegram/sessions').StringSession,
            PromisedWebSockets: require('telegram/extensions').PromisedWebSockets,
            computeCheck: require('telegram/Password').computeCheck
        };
    } finally {
        Module._load = originalLoad;
    }
};

const { TelegramClient, Api, StringSession, PromisedWebSockets, computeCheck } = loadTelegramDependencies();
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
            apiId: null,
            apiHash: null,
            authResolvers: { phoneNumber: null, phoneCode: null, password: null },
            authCache: { phoneNumber: null, phoneCode: null, password: null },
            phoneNumber: null,
            phoneCodeHash: null,
            isCodeViaApp: false,
            authFlowActive: false,
            authFlowPromise: null,
            currentAuthStep: null,
            currentAuthError: null
        });
    }
    return clientsData.get(userId);
};

const resetAuthState = (state) => {
    state.authCache = { phoneNumber: null, phoneCode: null, password: null };
    state.authResolvers = { phoneNumber: null, phoneCode: null, password: null };
    state.phoneNumber = null;
    state.phoneCodeHash = null;
    state.isCodeViaApp = false;
    state.currentAuthStep = null;
    state.currentAuthError = null;
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

const createTelegramClient = (apiId, apiHash, sessionString = '') => (
  new TelegramClient(new StringSession(sessionString), parseInt(apiId, 10), apiHash, {
    connectionRetries: 5,
    requestRetries: 2,
    retryDelay: 1000,
    timeout: 20,
    useWSS: true,
    networkSocket: PromisedWebSockets,
  })
);

const initTelegramClient = async (apiId, apiHash) => {
  const state = getTenantState();
  const userId = context.getUserId();
  const sessionString = getSession();

  state.apiId = apiId;
  state.apiHash = apiHash;
  state.client = createTelegramClient(apiId, apiHash, sessionString);
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
        if (state.currentAuthStep) return state.currentAuthStep;
        if (state.authResolvers.password) return 'password';
        if (state.authResolvers.phoneCode) return 'code';
        if (state.authResolvers.phoneNumber) return 'phone';
        return null;
    } catch (error) {
        return null;
    }
};

const getAuthError = () => {
    try {
        const state = getTenantState();
        return state.currentAuthError || null;
    } catch (error) {
        return null;
    }
};

const isRetryableAuthTransportError = (error) => {
    const text = String(error?.message || error || '');
    return /invalid new nonce hash|websocket connection failed|connection closed|timeout|network|не підтвердив відправку коду/i.test(text);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, timeoutMs, message) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const ensureConnected = async (state) => {
    if (!state.client) {
        throw new Error('Telegram клієнт не ініціалізовано');
    }
    if (!state.client.connected) {
        await withTimeout(state.client.connect(), 25000, 'Telegram connection timeout');
    }
};

const waitForCodeStepAfterPhone = async (state, timeoutMs = 25000) => {
    while (state.authFlowActive && !state.authCache.phoneNumber) {
        await sleep(250);
    }
    if (!state.authFlowActive) return new Promise(() => {});

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (state.currentAuthStep === 'code' || state.currentAuthStep === 'password') {
            return new Promise(() => {});
        }
        if (state.authResolvers.phoneCode || state.authResolvers.password) {
            return new Promise(() => {});
        }
        if (state.currentAuthStep === 'error' || state.currentAuthError) {
            throw new Error(state.currentAuthError || 'Telegram auth error');
        }
        await sleep(500);
    }

    throw new Error('Telegram не підтвердив відправку коду після номера. Повторюємо підключення.');
};

const recreateAuthClient = async (state) => {
    if (state.client) {
        try {
            await state.client.disconnect();
        } catch (error) {}
    }
    const apiId = state.apiId || String(db.prepare("SELECT value FROM settings WHERE key = 'api_id'").get()?.value || '').trim();
    const apiHash = state.apiHash || String(db.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get()?.value || '').trim();
    if (!apiId || !apiHash) {
        throw new Error('Налаштування API відсутні. Будь ласка, вкажіть API ID та API HASH в налаштуваннях.');
    }
    state.apiId = apiId;
    state.apiHash = apiHash;
    state.client = createTelegramClient(apiId, apiHash, '');
    state.clientOwnerUserId = context.getUserId();
    state.authResolvers = { phoneNumber: null, phoneCode: null, password: null };
    state.currentAuthStep = null;
    state.currentAuthError = null;
};

const markAuthError = (state, error) => {
    state.currentAuthStep = 'error';
    state.currentAuthError = error?.message || String(error || 'Telegram auth failed');
};

const markAuthComplete = (state) => {
    state.currentAuthStep = null;
    state.currentAuthError = null;
    state.authFlowActive = false;
    state.authFlowPromise = null;
    saveSession(state.client.session.save());
};

const runAuthStartOnce = async (state) => {
    await Promise.race([state.client.start({
        phoneNumber: async () => {
            if (state.authCache.phoneNumber) return state.authCache.phoneNumber;
            state.currentAuthStep = 'phone';
            return new Promise(resolve => state.authResolvers.phoneNumber = resolve);
        },
        password: async () => {
            if (state.authCache.password) return state.authCache.password;
            state.currentAuthStep = 'password';
            return new Promise(resolve => state.authResolvers.password = resolve);
        },
        phoneCode: async () => {
            if (state.authCache.phoneCode) return state.authCache.phoneCode;
            state.currentAuthStep = 'code';
            return new Promise(resolve => state.authResolvers.phoneCode = resolve);
        },
        onError: (error) => {
            state.currentAuthError = error?.message || String(error || 'Telegram auth error');
            state.currentAuthStep = 'error';
            console.log(`[User ${context.getUserId()}] Telegram Auth Error:`, error);
            return true;
        },
    }), waitForCodeStepAfterPhone(state)]);
};

const startAuthFlow = async () => {
    const state = getTenantState();
    if (!state.client) {
        return { success: false, error: 'Telegram клієнт не ініціалізовано' };
    }
    resetAuthState(state);
    state.authFlowActive = true;

    try {
        console.log(`[User ${context.getUserId()}] Починаємо ручний Telegram auth flow...`);
        await ensureConnected(state);
        if (await state.client.checkAuthorization()) {
            console.log(`[User ${context.getUserId()}] Telegram вже авторизований.`);
            markAuthComplete(state);
            return { success: true, connected: true };
        }
        state.currentAuthStep = 'phone';
        return { success: true, waitingFor: 'phone' };
    } catch (error) {
        console.error(`[User ${context.getUserId()}] Помилка старту Telegram auth:`, error);
        markAuthError(state, error);
        state.authFlowActive = false;
        return { success: false, error: error.message };
    }
};

const sendAuthCode = async (state, phoneNumber) => {
    const phone = String(phoneNumber || '').trim();
    if (!phone) throw new Error('Введіть номер телефону');

    state.authCache.phoneNumber = phone;
    state.phoneNumber = phone;
    state.currentAuthStep = 'sending_code';
    state.currentAuthError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            await ensureConnected(state);
            const result = await withTimeout(
                state.client.sendCode({ apiId: parseInt(state.apiId, 10), apiHash: state.apiHash }, phone, false),
                35000,
                'Telegram sendCode timeout'
            );
            if (!result?.phoneCodeHash) {
                throw new Error('Telegram не повернув phoneCodeHash після відправки коду');
            }
            state.phoneCodeHash = result.phoneCodeHash;
            state.isCodeViaApp = !!result.isCodeViaApp;
            state.currentAuthStep = 'code';
            console.log(`[User ${context.getUserId()}] Telegram code requested (${state.isCodeViaApp ? 'app' : 'sms/other'}).`);
            return { success: true, waitingFor: 'code', isCodeViaApp: state.isCodeViaApp };
        } catch (error) {
            const canRetry = attempt === 1 && isRetryableAuthTransportError(error);
            if (!canRetry) {
                markAuthError(state, error);
                throw error;
            }
            console.warn(`[User ${context.getUserId()}] Telegram sendCode failed, retrying with fresh WSS client:`, error?.message || error);
            await recreateAuthClient(state);
            state.authCache.phoneNumber = phone;
            state.phoneNumber = phone;
        }
    }

    throw new Error('Telegram не зміг відправити код');
};

const signInWithCode = async (state, codeValue) => {
    const code = String(codeValue || '').trim();
    if (!code) throw new Error('Введіть код Telegram');
    if (!state.phoneNumber || !state.phoneCodeHash) {
        throw new Error('Немає активного Telegram-коду. Введіть номер ще раз.');
    }

    try {
        await ensureConnected(state);
        const result = await withTimeout(
            state.client.invoke(new Api.auth.SignIn({
                phoneNumber: state.phoneNumber,
                phoneCodeHash: state.phoneCodeHash,
                phoneCode: code,
            })),
            30000,
            'Telegram signIn timeout'
        );

        if (result instanceof Api.auth.AuthorizationSignUpRequired) {
            throw new Error('Цей номер не зареєстрований у Telegram або потрібна окрема реєстрація Telegram.');
        }

        markAuthComplete(state);
        console.log(`[User ${context.getUserId()}] Telegram авторизований через код.`);
        return { success: true, connected: true };
    } catch (error) {
        if (String(error?.errorMessage || error?.message || '').includes('SESSION_PASSWORD_NEEDED')) {
            state.currentAuthStep = 'password';
            state.currentAuthError = null;
            return { success: true, waitingFor: 'password' };
        }
        markAuthError(state, error);
        throw error;
    }
};

const signInWithPassword = async (state, passwordValue) => {
    const password = String(passwordValue || '').trim();
    if (!password) throw new Error('Введіть пароль 2FA Telegram');

    try {
        await ensureConnected(state);
        const passwordInfo = await withTimeout(
            state.client.invoke(new Api.account.GetPassword()),
            30000,
            'Telegram getPassword timeout'
        );
        const passwordCheck = await computeCheck(passwordInfo, password);
        await withTimeout(
            state.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck })),
            30000,
            'Telegram checkPassword timeout'
        );
        markAuthComplete(state);
        console.log(`[User ${context.getUserId()}] Telegram авторизований через 2FA пароль.`);
        return { success: true, connected: true };
    } catch (error) {
        markAuthError(state, error);
        throw error;
    }
};

const resolveAuthStep = async (step, value) => {
    try {
        const state = getTenantState();
        if (!String(value || '').trim()) return false;
        if (!state.authFlowActive) {
            return false;
        }
        if (step === 'phoneNumber') return sendAuthCode(state, value);
        if (step === 'phoneCode') return signInWithCode(state, value);
        if (step === 'password') return signInWithPassword(state, value);
        return false;
    } catch (error) {
        return { success: false, error: error.message || String(error) };
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
    getAuthError,
    disconnectTelegramClient,
    logoutTelegramClient
};
