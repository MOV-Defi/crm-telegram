import React, { useMemo, useState } from 'react';

const resolveApiUrl = () => {
  const configured = String(import.meta.env.VITE_API_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return '/api';
};

const API_URL = resolveApiUrl();

export default function Auth({ onAuthenticated, appTheme = 'dark' }) {
  const [step, setStep] = useState('phone'); // phone, code, password
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const logoSrc = useMemo(() => (
    appTheme === 'light' ? '/solar-logo-light.png' : '/solar-logo.png'
  ), [appTheme]);

  const requestJson = async (url, options) => {
    const response = await fetch(url, options);
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_) {
        const preview = raw.slice(0, 180).trim();
        throw new Error(`Сервер повернув не JSON (${response.status}) для ${url}${preview ? `: ${preview}` : ''}`);
      }
    }
    return { response, data: data || {} };
  };

  const waitForAuthStep = async (expectedSteps, timeoutMs = 12000) => {
    const acceptedSteps = Array.isArray(expectedSteps) ? expectedSteps : [expectedSteps];
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const statusRes = await fetch(`${API_URL}/auth/status`);
        const statusData = await statusRes.json();
        if (statusData?.connected) {
          return { connected: true, waitingFor: null };
        }
        if (acceptedSteps.includes(statusData?.waitingFor)) {
          return statusData;
        }
      } catch (_) {
        // retry
      }
      await sleep(450);
    }
    return null;
  };

  const startAuth = async (phone) => {
    setLoading(true);
    try {
        const { response: statusRes, data: statusData } = await requestJson(`${API_URL}/auth/status`);
        if (statusData.connected) {
            onAuthenticated();
            return;
        }

        // Ініціюємо auth flow максимально толерантно (без жорсткого падіння на першій невдалій відповіді)
        const tryStartFlow = async () => {
            let lastError = null;
            for (let i = 0; i < 3; i += 1) {
                try {
                    const { response, data } = await requestJson(`${API_URL}/auth/start`, { method: 'POST' });
                    if (response.ok && data?.success) return true;
                    lastError = data?.error || data?.message || null;
                } catch (error) {
                    lastError = error?.message || String(error);
                }
                await sleep(500);
            }
            if (lastError) console.warn('auth/start soft-fail:', lastError);
            return false;
        };

        await tryStartFlow();

        const statusAfterStart = await waitForAuthStep(['phone', 'code', 'password'], 12000);
        if (statusAfterStart?.connected) {
            onAuthenticated();
            return;
        }
        if (statusAfterStart?.waitingFor === 'password') {
            setStep('password');
            setInputValue('');
            return;
        }
        if (statusAfterStart?.waitingFor === 'code') {
            setStep('code');
            setInputValue('');
            return;
        }

        // Відправляємо номер з повторними спробами
        let phoneAccepted = false;
        let lastPhoneError = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const phoneReq = await requestJson(`${API_URL}/auth/phone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone })
            });
            const phoneRes = phoneReq.response;
            const phoneData = phoneReq.data;
            if (phoneRes.ok && phoneData?.success) {
                phoneAccepted = true;
                break;
            }
            const maybeRace = String(phoneData?.message || phoneData?.error || '').toLowerCase().includes('no active phone request');
            lastPhoneError = phoneData?.error || phoneData?.message || 'Номер не прийнято. Спробуйте ще раз.';
            if (maybeRace) {
                await tryStartFlow();
                await waitForAuthStep('phone', 4000);
                await sleep(350);
                continue;
            }
            await sleep(350);
        }
        if (!phoneAccepted) {
            throw new Error(lastPhoneError || 'Номер не прийнято. Спробуйте ще раз.');
        }
        
        setStep('code');
        setInputValue('');
    } catch (e) {
        console.error("Auth Error", e);
        const msg = String(e?.message || '');
        if (/failed to fetch/i.test(msg) || /networkerror/i.test(msg)) {
          alert('Немає зʼєднання з backend. Перевірте, що сервер запущений, і оновіть сторінку (F5).');
        } else {
          alert(msg || "Помилка підключення до сервера бекенду");
        }
    } finally {
        setLoading(false);
    }
  };

  const sendCode = async () => {
    setLoading(true);
    try {
        const { response: codeRes, data: codeData } = await requestJson(`${API_URL}/auth/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: inputValue })
        });
        if (!codeRes.ok || !codeData?.success) {
            throw new Error(codeData?.error || 'Код не прийнято. Спробуйте ще раз.');
        }
        
        // Переходимо в стан очікування (кнопки сховані)
        setStep('waiting');
        setInputValue('');

        const pollStatus = async () => {
            try {
                const { data } = await requestJson(`${API_URL}/auth/status`);
                if (data.connected) {
                    onAuthenticated();
                } else if (data.waitingFor === 'password') {
                    setStep('password');
                    setLoading(false);
                } else {
                    setTimeout(pollStatus, 1500);
                }
            } catch (e) {
                setTimeout(pollStatus, 1500);
            }
        };
        pollStatus();

    } catch (e) {
        console.error(e);
        alert(e.message || 'Невірний код. Повертаємо до вводу номера телефону.');
        setStep('phone');
        setInputValue('');
        setLoading(false);
    }
  };

  const sendPassword = async () => {
      setLoading(true);
      try {
          const { response: passRes, data: passData } = await requestJson(`${API_URL}/auth/password`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: inputValue })
          });
          if (!passRes.ok || !passData?.success) {
              throw new Error(passData?.error || 'Пароль не прийнято. Спробуйте ще раз.');
          }
          setStep('waiting');
          setInputValue('');
          
          const pollStatus = async () => {
              try {
                  const { data } = await requestJson(`${API_URL}/auth/status`);
                  if (data.connected) {
                      onAuthenticated();
                  } else {
                      setTimeout(pollStatus, 1500);
                  }
              } catch (e) {
                  setTimeout(pollStatus, 1500);
              }
          };
          pollStatus();
      } catch (e) {
          console.error(e);
          alert(e.message || 'Не вдалося підтвердити пароль');
          setLoading(false);
      }
  };

  const handleNext = () => {
      if (step === 'phone') startAuth(inputValue);
      if (step === 'code') sendCode();
      if (step === 'password') sendPassword();
  };

  return (
      <div className="flex items-center justify-center min-h-screen bg-background text-slate-200">
          <div className="glass p-8 rounded-2xl w-full max-w-md relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-400 to-indigo-500"></div>
              
              <div className="flex justify-center mb-6">
                <img src={logoSrc} alt="Solar Service" className="h-16 w-auto object-contain" />
              </div>

              <h1 className="text-2xl font-bold mb-2 text-center">Вхід до системи</h1>
              <p className="text-slate-400 text-center mb-6 text-sm">
                  {step === 'phone' && 'Введіть номер телефону від вашого облікового запису Telegram'}
                  {step === 'code' && 'Введіть код підтвердження, який надіслав вам Telegram в офіційний додаток'}
                  {step === 'password' && 'На акаунті увімкнено безпеку 2FA. Введіть хмарний пароль, щоб завершити вхід'}
              </p>
              
              <div className="mb-6">
                {step === 'waiting' ? (
                  <div className="text-center py-4">
                      <p className="text-blue-400 font-medium animate-pulse">Перевірка коду...</p>
                      <p className="text-slate-500 text-sm mt-2">Чекаємо відповіді від Telegram</p>
                  </div>
              ) : (
                  <input 
                      type={step === 'password' ? 'password' : 'text'} 
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={step === 'phone' ? "+380..." : (step === 'code' ? '12345' : 'Ваш хмарний пароль')}
                      className="w-full bg-slate-900/50 text-slate-200 border border-slate-700/50 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition shadow-inner"
                      onKeyDown={(e) => e.key === 'Enter' && handleNext()}
                  />
              )}
              </div>
              
              {step !== 'waiting' && (
              <button 
                  onClick={handleNext}
                  disabled={loading || !inputValue}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold rounded-xl px-4 py-3 transition shadow-lg shadow-blue-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                  {loading ? (
                    <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  ) : 'Продовжити'}
              </button>
              )}
          </div>
      </div>
  );
}
