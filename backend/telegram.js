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
            computeCheck: require('telegram/Password').computeCheck,
            StringSession: require('telegram/sessions').StringSession
        };
    } finally {
        Module._load = originalLoad;
    }
};

const { TelegramClient, Api, computeCheck, StringSession } = loadTelegramDependencies();
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
            authCodeInfo: null,
            qrLogin: null,
            authStep: null,
            authError: null,
            authFlowActive: false,
            authFlowPromise: null
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
    state.authCodeInfo = null;
    state.qrLogin = null;
    state.authStep = null;
    state.authError = null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const maskPhone = (value) => {
    const raw = String(value || '').trim();
    if (raw.length <= 5) return raw ? '***' : '';
    return `${raw.slice(0, 4)}***${raw.slice(-2)}`;
};

const waitForAuthResolver = async (state, step, timeoutMs = 12000) => {
    const resolverKey = step === 'phone' ? 'phoneNumber' : step === 'code' ? 'phoneCode' : step;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (state.authResolvers[resolverKey]) return true;
        if (state.authError) return false;
        if (!state.authFlowActive && !state.authFlowPromise) return false;
        await sleep(250);
    }
    return Boolean(state.authResolvers[resolverKey]);
};

const withTimeout = (promise, timeoutMs, message) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

const codeClassName = (value) => String(value?.className || value?.constructor?.name || '').replace(/^auth\./, '');

const buildCodeInfo = (sentCode, requested = 'normal') => {
    const delivery = codeClassName(sentCode?.type);
    return {
        requested,
        delivery,
        isCodeViaApp: sentCode?.type instanceof Api.auth.SentCodeTypeApp
    };
};

const assertTelegramAppCode = (codeInfo) => {
    if (!codeInfo?.isCodeViaApp) {
        throw new Error('Telegram не відправив код у застосунок Telegram. Перевірте, що цей номер уже відкритий в офіційному Telegram app.');
    }
};

const sendTelegramCode = async (state, phoneNumber) => {
    const sentCode = await withTimeout(
        state.client.invoke(new Api.auth.SendCode({
            phoneNumber,
            apiId: parseInt(state.apiId, 10),
            apiHash: state.apiHash,
            settings: new Api.CodeSettings({})
        })),
        35000,
        'Telegram sendCode timeout'
    );
    if (sentCode instanceof Api.auth.SentCodeSuccess) {
        throw new Error('Telegram авторизувався одразу після відправки коду');
    }
    return sentCode;
};

const buildLoginUrl = (token) => `tg://login?token=${Buffer.from(token).toString('base64url')}`;

const normalizeLoginTokenResult = async (state, result) => {
    if (result instanceof Api.auth.LoginTokenSuccess) {
        saveSession(state.client.session.save());
        resetAuthState(state);
        state.authFlowActive = false;
        console.log(`[User ${context.getUserId()}] Telegram авторизований через QR/login token.`);
        return { success: true, connected: true };
    }
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
        const migrated = await withTimeout(
            state.client.invoke(new Api.auth.ImportLoginToken({ token: result.token }), result.dcId),
            30000,
            'Telegram importLoginToken timeout'
        );
        return normalizeLoginTokenResult(state, migrated);
    }
    if (result instanceof Api.auth.LoginToken) {
        state.qrLogin = {
            token: Buffer.from(result.token),
            expires: Number(result.expires || 0),
            url: buildLoginUrl(result.token)
        };
        state.authStep = 'qr';
        state.authError = null;
        return {
            success: true,
            waitingFor: 'qr',
            qrLogin: {
                url: state.qrLogin.url,
                expires: state.qrLogin.expires
            }
        };
    }
    throw new Error('Telegram повернув невідомий QR login result');
};

const requestQrLogin = async () => {
    const state = getTenantState();
    if (!state.client) {
        return { success: false, error: 'Telegram клієнт не ініціалізовано' };
    }
    state.authFlowActive = true;
    await ensureConnected(state);
    if (await state.client.checkAuthorization()) {
        saveSession(state.client.session.save());
        resetAuthState(state);
        state.authFlowActive = false;
        return { success: true, connected: true };
    }
    const result = await withTimeout(
        state.client.invoke(new Api.auth.ExportLoginToken({
            apiId: parseInt(state.apiId, 10),
            apiHash: state.apiHash,
            exceptIds: []
        })),
        30000,
        'Telegram exportLoginToken timeout'
    );
    return normalizeLoginTokenResult(state, result);
};

const checkQrLogin = async () => {
    const state = getTenantState();
    if (!state.authFlowActive || state.authStep !== 'qr' || !state.qrLogin?.token) {
        return null;
    }
    await ensureConnected(state);
    try {
        const result = await withTimeout(
            state.client.invoke(new Api.auth.ImportLoginToken({ token: state.qrLogin.token })),
            12000,
            'Telegram importLoginToken timeout'
        );
        return normalizeLoginTokenResult(state, result);
    } catch (error) {
        const text = String(error?.errorMessage || error?.message || '');
        if (/SESSION_PASSWORD_NEEDED/.test(text)) {
            state.authStep = 'password';
            state.authError = null;
            return { success: true, waitingFor: 'password' };
        }
        if (/AUTH_TOKEN_INVALID|AUTH_TOKEN_EXPIRED|TOKEN_INVALID|TOKEN_EXPIRED/i.test(text)) {
            state.qrLogin = null;
            state.authStep = 'phone';
            return { success: false, error: 'Посилання Telegram app застаріло. Спробуйте увійти через Telegram app ще раз.' };
        }
        return {
            success: true,
            waitingFor: 'qr',
            qrLogin: {
                url: state.qrLogin.url,
                expires: state.qrLogin.expires
            }
        };
    }
};

const ensureConnected = async (state) => {
    if (!state.client) throw new Error('Telegram клієнт не ініціалізовано');
    if (!state.client.connected) {
        await withTimeout(state.client.connect(), 25000, 'Telegram connection timeout');
    }
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

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tg_session'").get();
    const value = String(row?.value || '').trim();
    if (value) return value;
  } catch (_) {}

  return '';
};

const clearSession = () => {
  const userId = context.getUserId();
  try {
    db.prepare("DELETE FROM settings WHERE key = 'tg_session'").run();
  } catch (_) {}
  try {
    const filePath = getSessionFilePath(userId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
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

  if (state.client) {
    try {
      await state.client.disconnect();
    } catch (_) {}
  }
  resetAuthState(state);
  state.apiId = String(apiId || '').trim();
  state.apiHash = String(apiHash || '').trim();
  
  state.client = new TelegramClient(stringSession, parseInt(state.apiId, 10), state.apiHash, {
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
      clearSession();
      state.client = new TelegramClient(new StringSession(''), parseInt(state.apiId, 10), state.apiHash, {
        connectionRetries: 5,
      });
      state.clientOwnerUserId = userId;
    }
  }

  return state.client;
};

const getAuthStep = () => {
    try {
        const state = getTenantState();
        if (state.authError) return { step: 'error', error: state.authError };
        if (state.authStep === 'code') return { step: 'code', codeInfo: state.authCodeInfo || null };
        if (state.authStep === 'qr') {
            return {
                step: 'qr',
                qrLogin: state.qrLogin ? {
                    url: state.qrLogin.url,
                    expires: state.qrLogin.expires
                } : null
            };
        }
        if (state.authStep) return state.authStep;
        if (state.authResolvers.password) return 'password';
        if (state.authResolvers.phoneCode) return 'code';
        if (state.authResolvers.phoneNumber) return 'phone';
        return null;
    } catch(_) {
        return null;
    }
};

const isAuthFlowActive = () => {
    try {
        const state = getTenantState();
        return Boolean(state.authFlowActive);
    } catch (_) {
        return false;
    }
};

const isAnyAuthFlowActive = () => {
    for (const state of clientsData.values()) {
        if (state?.authFlowActive) return true;
    }
    return false;
};

const startAuthFlow = async () => {
    const state = getTenantState();
    if (!state.client) {
        return { success: false, error: 'Telegram клієнт не ініціалізовано' };
    }
    if (state.authFlowActive && state.authStep) {
        return {
            success: true,
            waitingFor: state.authStep,
            codeInfo: state.authCodeInfo || null
        };
    }
    resetAuthState(state);
    state.authFlowActive = true;

    try {
        console.log(`[User ${context.getUserId()}] Починаємо ручний Telegram auth flow...`);
        await ensureConnected(state);
        if (await state.client.checkAuthorization()) {
            console.log(`[User ${context.getUserId()}] Telegram вже авторизований.`);
            saveSession(state.client.session.save());
            state.authFlowActive = false;
            state.authStep = null;
            state.authError = null;
            return { success: true, connected: true };
        }
        state.authStep = 'phone';
        console.log(`[User ${context.getUserId()}] Telegram auth waiting for phone number`);
        return { success: true, waitingFor: 'phone' };
    } catch (error) {
        console.error(`[User ${context.getUserId()}] Помилка старту Telegram auth:`, error);
        state.authError = error.message;
        state.authStep = 'error';
        state.authFlowActive = false;
        return { success: false, error: error.message };
    }
};

const requestAuthCode = async (state, phone) => {
    const phoneNumber = String(phone || '').trim();
    if (!phoneNumber) throw new Error('Введіть номер телефону');
    if (!state.apiId || !state.apiHash) {
        const idRow = db.prepare("SELECT value FROM settings WHERE key = 'api_id'").get();
        const hashRow = db.prepare("SELECT value FROM settings WHERE key = 'api_hash'").get();
        state.apiId = String(idRow?.value || '').trim();
        state.apiHash = String(hashRow?.value || '').trim();
    }
    if (!state.apiId || !state.apiHash) {
        throw new Error('Налаштування API відсутні. Будь ласка, вкажіть API ID та API HASH в налаштуваннях.');
    }

    await ensureConnected(state);
    state.authStep = 'sending_code';
    state.authError = null;
    state.phoneNumber = phoneNumber;
    const result = await sendTelegramCode(state, phoneNumber);
    const codeInfo = buildCodeInfo(result, 'normal');
    if (!result?.phoneCodeHash) {
        throw new Error('Telegram не повернув phoneCodeHash після відправки коду');
    }
    state.phoneCodeHash = result.phoneCodeHash;
    assertTelegramAppCode(codeInfo);
    state.isCodeViaApp = Boolean(codeInfo.isCodeViaApp);
    state.authCodeInfo = codeInfo;
    state.authStep = 'code';
    console.log(`[User ${context.getUserId()}] Telegram app code requested for ${maskPhone(phoneNumber)} (delivery=${codeInfo.delivery || 'unknown'}, requested=${codeInfo.requested}).`);
    return { success: true, waitingFor: 'code', isCodeViaApp: state.isCodeViaApp, codeInfo };
};

const resendAuthCode = async () => {
    const state = getTenantState();
    if (!state.authFlowActive || !state.phoneNumber || !state.phoneCodeHash) {
        return { success: false, error: 'Немає активного запиту коду. Введіть номер ще раз.' };
    }
    await ensureConnected(state);
    try {
        await withTimeout(
            state.client.invoke(new Api.auth.CancelCode({
                phoneNumber: state.phoneNumber,
                phoneCodeHash: state.phoneCodeHash
            })),
            15000,
            'Telegram cancelCode timeout'
        );
    } catch (error) {
        console.warn(`[User ${context.getUserId()}] Telegram cancel code warning:`, error?.message || error);
    }
    const result = await sendTelegramCode(state, state.phoneNumber);
    if (!result?.phoneCodeHash) {
        throw new Error('Telegram не повернув phoneCodeHash після повторної відправки коду');
    }
    const codeInfo = buildCodeInfo(result, 'repeat');
    state.phoneCodeHash = result.phoneCodeHash;
    assertTelegramAppCode(codeInfo);
    state.isCodeViaApp = Boolean(codeInfo.isCodeViaApp);
    state.authCodeInfo = codeInfo;
    state.authStep = 'code';
    state.authError = null;
    console.log(`[User ${context.getUserId()}] Telegram app code re-requested for ${maskPhone(state.phoneNumber)} (delivery=${codeInfo.delivery || 'unknown'}, requested=${codeInfo.requested}).`);
    return { success: true, waitingFor: 'code', isCodeViaApp: state.isCodeViaApp, codeInfo };
};

const signInWithCode = async (state, codeValue) => {
    const code = String(codeValue || '').trim();
    if (!code) throw new Error('Введіть код Telegram');
    if (!state.phoneNumber || !state.phoneCodeHash) {
        throw new Error('Немає активного Telegram-коду. Введіть номер ще раз.');
    }

    await ensureConnected(state);
    try {
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
        saveSession(state.client.session.save());
        resetAuthState(state);
        state.authFlowActive = false;
        console.log(`[User ${context.getUserId()}] Telegram авторизований через код.`);
        return { success: true, connected: true };
    } catch (error) {
        const text = String(error?.errorMessage || error?.message || '');
        if (text.includes('SESSION_PASSWORD_NEEDED')) {
            state.authStep = 'password';
            state.authError = null;
            return { success: true, waitingFor: 'password' };
        }
        throw error;
    }
};

const signInWithPassword = async (state, passwordValue) => {
    const password = String(passwordValue || '').trim();
    if (!password) throw new Error('Введіть пароль 2FA Telegram');
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
    saveSession(state.client.session.save());
    resetAuthState(state);
    state.authFlowActive = false;
    console.log(`[User ${context.getUserId()}] Telegram авторизований через 2FA пароль.`);
    return { success: true, connected: true };
};

const resolveAuthStep = async (step, value) => {
    try {
        const state = getTenantState();
        if (!String(value || '').trim()) return false;
        if (!state.authFlowActive) {
            return false;
        }
        if (step === 'phoneNumber') return requestAuthCode(state, value);
        if (step === 'phoneCode') return signInWithCode(state, value);
        if (step === 'password') return signInWithPassword(state, value);
        return false;
    } catch(error) {
        const state = getTenantState();
        state.authError = error.message || String(error);
        state.authStep = 'error';
        console.error(`[User ${context.getUserId()}] Telegram auth step error:`, error);
        return { success: false, error: error.message || String(error) };
    }
};

const resolvePhoneNumber = async (phone) => {
    try {
        const state = getTenantState();
        if (!String(phone || '').trim()) {
            return { success: false, error: 'Введіть номер телефону' };
        }
        if (!state.authFlowActive) {
            const started = await startAuthFlow();
            if (!started?.success) return started;
            if (started?.connected) return started;
        }
        console.log(`[User ${context.getUserId()}] Telegram auth phone accepted: ${maskPhone(phone)}`);
        return requestAuthCode(state, phone);
    } catch(e) {
        return { success: false, error: e.message || String(e) };
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
        clearSession();
    } catch(e) {}
};

module.exports = {
    initTelegramClient,
    startAuthFlow,
    resolveAuthStep,
    resolvePhoneNumber,
    resendAuthCode,
    requestQrLogin,
    checkQrLogin,
    getClient,
    getAuthStep,
    isAuthFlowActive,
    isAnyAuthFlowActive,
    disconnectTelegramClient,
    logoutTelegramClient
};
