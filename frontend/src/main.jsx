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

    if (!isAuthenticated) {
        return <SystemAuth onLogin={() => setIsAuthenticated(true)} />;
    }

    return <App currentUser={currentUser} />;
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <RootComponent />
);
