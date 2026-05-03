/**
 * Local Server Startup Script for Solar CRM (SaaS Version)
 * This script starts the backend server which serves both the API and the Frontend.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
const PID_FILE = path.join(PROJECT_ROOT, '.backend.pid');
const PORT_FILE = path.join(PROJECT_ROOT, '.backend.port');

console.log('\x1b[36m%s\x1b[0m', '=== Solar CRM Local Server Startup ===');

// 1. Провірка залежностей
if (!fs.existsSync(path.join(BACKEND_DIR, 'node_modules'))) {
    console.log('\x1b[33m%s\x1b[0m', 'Installing backend dependencies...');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const install = spawnSync(npmCmd, ['install'], { cwd: BACKEND_DIR, stdio: 'inherit' });
    if (install.status !== 0) {
        console.error('Failed to install backend dependencies');
        process.exit(1);
    }
}

// 2. Читання порту (пріоритет: .env -> .backend.port -> 5050)
let port = 5050;
const envPath = path.join(BACKEND_DIR, '.env');
let jwtSecret = '';
if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const match = env.match(/^PORT=(\d+)/m);
    if (match) port = parseInt(match[1]);
    const jwtMatch = env.match(/^JWT_SECRET=(.+)$/m);
    if (jwtMatch) jwtSecret = String(jwtMatch[1] || '').trim();
} else if (fs.existsSync(PORT_FILE)) {
    const savedPort = fs.readFileSync(PORT_FILE, 'utf8').trim();
    if (savedPort) port = parseInt(savedPort);
}

if (!jwtSecret) {
    jwtSecret = 'local-dev-secret-change-me';
    console.log('\x1b[33m%s\x1b[0m', 'JWT_SECRET is missing in backend/.env. Using local fallback secret for local run.');
}

// 3. Зупинка старого процесу (агресивна перевірка порту)
try {
    const stdout = require('child_process').execSync(`lsof -t -i:${port}`).toString().trim();
    if (stdout) {
        stdout.split('\n').forEach(pid => {
            if (pid != process.pid) { // Не вбиваємо самих себе
                console.log(`Stopping process ${pid} on port ${port}...`);
                try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e) {}
            }
        });
        // Даємо час на звільнення порту
        require('child_process').execSync('sleep 1');
    }
} catch (e) {
    // Порт вільний або lsof не знайдено
}

// 4. Запуск сервера
const server = spawn('node', ['server.js'], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    env: { ...process.env, PORT: port, JWT_SECRET: jwtSecret }
});

// 5. Збереження PID та Порту
fs.writeFileSync(PID_FILE, server.pid.toString());
fs.writeFileSync(PORT_FILE, port.toString());

const url = `http://localhost:${port}`;
console.log('\x1b[32m%s\x1b[0m', `Server started on ${url}`);
console.log(`PID: ${server.pid} | Logs are shown above\n`);

// 6. Відкриття браузера
setTimeout(() => {
    const openCmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
    require('child_process').exec(`${openCmd} ${url}`);
}, 1000);

server.on('exit', (code) => {
    console.log(`\nServer exited with code ${code}`);
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(code || 0);
});

// Обробка завершення скрипта (Ctrl+C)
process.on('SIGINT', () => {
    console.log('\nStopping server...');
    server.kill('SIGTERM');
});
