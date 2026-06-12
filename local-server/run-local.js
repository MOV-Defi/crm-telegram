/**
 * Local Server Startup Script for Solar CRM (SaaS Version)
 * One-click local startup: backend serves frontend/dist on localhost:5050.
 */

const { spawn, spawnSync, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const FRONTEND_DIST_INDEX = path.join(FRONTEND_DIR, 'dist', 'index.html');
const PID_FILE = path.join(PROJECT_ROOT, '.local-dev.pid');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BACKEND_LOG_FILE = path.join(__dirname, 'backend-start.log');
const BACKEND_PORT = 5050;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const color = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`
};

const MAIN_URL = `http://localhost:${BACKEND_PORT}`;

const openUrl = (url) => {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      return true;
    }
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
      return true;
    }
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch (_) {
    return false;
  }
};

const waitForBackendAndOpen = (url, timeoutMs = 30000) => {
  const startedAt = Date.now();
  let didOpen = false;

  const ping = () => new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });

  const loop = async () => {
    while (Date.now() - startedAt < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await ping();
      if (ok) {
        didOpen = openUrl(url);
        if (didOpen) {
          console.log(color.green(`Opened: ${url}`));
        }
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!didOpen) {
      console.log(color.yellow(`Backend did not become ready in time. Open manually: ${url}`));
    }
  };

  void loop();
};

const safeKill = (pid, signal = 'SIGTERM') => {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
  try { process.kill(pid, signal); } catch (_) {}
};

const killPort = (port) => {
  try {
    const stdout = execSync(`lsof -t -i:${port}`).toString().trim();
    if (!stdout) return;
    stdout
      .split('\n')
      .map((p) => Number.parseInt(String(p).trim(), 10))
      .filter((p) => Number.isFinite(p) && p !== process.pid)
      .forEach((pid) => {
        safeKill(pid, 'SIGKILL');
        console.log(color.yellow(`Stopped process ${pid} on port ${port}`));
      });
  } catch (_) {}
};

const ensureDeps = (dir, label) => {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return;
  console.log(color.yellow(`Installing ${label} dependencies...`));
  const install = spawnSync(npmCmd, ['install'], { cwd: dir, stdio: 'inherit' });
  if (install.status !== 0) {
    console.error(color.red(`Failed to install ${label} dependencies`));
    process.exit(1);
  }
};

const ensureDataDir = () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error(color.red(`Failed to create data dir: ${DATA_DIR}`));
    console.error(color.red(String(error?.message || error)));
    process.exit(1);
  }
};

const stopFromPidFile = () => {
  if (!fs.existsSync(PID_FILE)) return;
  try {
    const oldPid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (Number.isFinite(oldPid)) {
      safeKill(oldPid, 'SIGTERM');
      setTimeout(() => safeKill(oldPid, 'SIGKILL'), 500);
      console.log(color.yellow(`Stopped previous launcher PID ${oldPid}`));
    }
  } catch (_) {}
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
};

const cleanup = () => {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
};

console.log(color.cyan('=== Solar CRM Local Server Startup ==='));
stopFromPidFile();
killPort(BACKEND_PORT);
ensureDeps(BACKEND_DIR, 'backend');
ensureDeps(FRONTEND_DIR, 'frontend');
ensureDataDir();
if (!fs.existsSync(FRONTEND_DIST_INDEX)) {
  console.log(color.yellow('frontend/dist not found. Building frontend for backend fallback...'));
  const build = spawnSync(npmCmd, ['run', 'build'], { cwd: FRONTEND_DIR, stdio: 'inherit' });
  if (build.status !== 0) {
    console.log(color.yellow('Frontend build failed. Backend will start anyway.'));
  }
}

const backendJwtSecret = String(process.env.JWT_SECRET || '').trim() || 'local-dev-secret-change-me';
if (!String(process.env.JWT_SECRET || '').trim()) {
  console.log(color.yellow('JWT_SECRET is missing. Using local dev fallback secret.'));
}

const backend = spawn('node', ['server.js'], {
  cwd: BACKEND_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(BACKEND_PORT),
    JWT_SECRET: backendJwtSecret,
    CRM_DATA_DIR: DATA_DIR,
    LOCAL_START_DEBUG: '1'
  }
});

try { fs.writeFileSync(BACKEND_LOG_FILE, ''); } catch (_) {}
const appendBackendLog = (chunk, streamName) => {
  const text = String(chunk || '');
  const prefix = streamName === 'stderr' ? '[backend:err] ' : '[backend] ';
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    console.log(`${prefix}${line}`);
  }
  try {
    fs.appendFileSync(BACKEND_LOG_FILE, text);
  } catch (_) {}
};
if (backend.stdout) backend.stdout.on('data', (chunk) => appendBackendLog(chunk, 'stdout'));
if (backend.stderr) backend.stderr.on('data', (chunk) => appendBackendLog(chunk, 'stderr'));

fs.writeFileSync(PID_FILE, String(process.pid));
console.log(color.green(`Launcher PID=${process.pid}`));
console.log(color.green(`Main URL: ${MAIN_URL}`));
console.log(color.green(`Backend:  ${MAIN_URL}`));
console.log(color.green(`Backend log: ${BACKEND_LOG_FILE}`));
console.log(color.cyan('Press Ctrl+C to stop both services.'));
waitForBackendAndOpen(MAIN_URL);

let isStopping = false;
const shutdown = (reason) => {
  if (isStopping) return;
  isStopping = true;
  if (reason) console.log(color.yellow(reason));
  safeKill(backend.pid, 'SIGTERM');
  setTimeout(() => {
    safeKill(backend.pid, 'SIGKILL');
    cleanup();
    process.exit(0);
  }, 800);
};

backend.on('exit', (code) => {
  shutdown(`Backend exited with code ${code ?? 0}.`);
});

backend.on('error', (error) => {
  shutdown(`Backend process failed to start: ${String(error?.message || error)}`);
});

process.on('SIGINT', () => shutdown('Stopping local dev stack...'));
process.on('SIGTERM', () => shutdown('Stopping local dev stack...'));
