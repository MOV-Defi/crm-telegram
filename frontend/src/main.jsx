import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import SystemAuth from './components/SystemAuth.jsx';
import './index.css';

// Monkey-patch fetch to automatically add JWT token to /api/ requests
const originalFetch = window.fetch;
window.fetch = async (...args) => {
    let [resource, config] = args;
    const resourceUrl = typeof resource === 'string' ? resource : (resource instanceof URL ? resource.href : '');
    
    const isApiRequest = resourceUrl && (resourceUrl.startsWith('/api/') || resourceUrl.includes('/api/'));
    const isPublicSystemAuth = resourceUrl.includes('/api/system/login') || resourceUrl.includes('/api/system/register');
    if (isApiRequest && !isPublicSystemAuth) {
        const token = localStorage.getItem('saas_token');
        if (token) {
            config = config || {};
            config.headers = {
                ...config.headers,
                'Authorization': `Bearer ${token}`
            };
            args[1] = config;
        }
    }
    
    try {
        const response = await originalFetch(...args);
        // Auto-logout if token is invalid or expired
        if (response.status === 401 && resourceUrl && !isPublicSystemAuth) {
            console.warn('SaaS session expired or invalid. Redirecting to login...');
            localStorage.removeItem('saas_token');
            window.dispatchEvent(new Event('auth-expired'));
            // Use setTimeout to avoid interrupting the current promise chain immediately
            setTimeout(() => window.location.reload(), 100);
        }
        return response;
    } catch (error) {
        console.error('Fetch error:', error);
        throw error;
    }
};

const RootComponent = () => {
    const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('saas_token'));
    const [currentUser, setCurrentUser] = useState(localStorage.getItem('saas_username') || null);

    useEffect(() => {
        const handleAuthExpired = () => setIsAuthenticated(false);
        const handleLogin = (e) => {
            setIsAuthenticated(true);
            setCurrentUser(localStorage.getItem('saas_username'));
        };
        
        window.addEventListener('auth-expired', handleAuthExpired);
        window.addEventListener('auth-success', handleLogin);
        
        return () => {
            window.removeEventListener('auth-expired', handleAuthExpired);
            window.removeEventListener('auth-success', handleLogin);
        };
    }, []);

    const handleLogout = () => {
        localStorage.removeItem('saas_token');
        localStorage.removeItem('saas_username');
        setIsAuthenticated(false);
        setCurrentUser(null);
    };

    if (!isAuthenticated) {
        return <SystemAuth onLogin={() => setIsAuthenticated(true)} />;
    }

    return (
        <>
            <button 
                onClick={handleLogout}
                title="Вийти з акаунту (SaaS)"
                className="fixed bottom-4 right-4 z-[9999] bg-slate-800 text-slate-300 border border-slate-600 px-4 py-2 rounded-lg shadow-lg text-sm font-medium hover:bg-slate-700 hover:text-white transition-all flex items-center gap-2"
            >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                Вийти
            </button>
            <App currentUser={currentUser} />
        </>
    );
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <RootComponent />
);
