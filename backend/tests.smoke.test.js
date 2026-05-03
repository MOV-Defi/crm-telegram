const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcrm-smoke-'));
process.env.CRM_DATA_DIR = path.join(tmpRoot, 'data');
process.env.JWT_SECRET = 'test-secret-smoke';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.PORT = '0';

const { startServer } = require('./server');

let server;
let port;

const requestJson = ({ method, route, token, body }) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: route,
    method,
    headers: {
      'content-type': 'application/json',
      ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      let json = null;
      try { json = data ? JSON.parse(data) : null; } catch (_) {}
      resolve({ status: res.statusCode, json, text: data });
    });
  });

  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

before(async () => {
  server = startServer(0);
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('register/login/role update flow works locally', async () => {
  const adminRegister = await requestJson({
    method: 'POST',
    route: '/api/system/register',
    body: { username: 'owner', password: 'pass123456' }
  });
  assert.equal(adminRegister.status, 200);
  assert.equal(adminRegister.json.role, 'admin');

  const adminLogin = await requestJson({
    method: 'POST',
    route: '/api/system/login',
    body: { username: 'owner', password: 'pass123456' }
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.json.role, 'admin');
  assert.ok(adminLogin.json.token);

  const userRegister = await requestJson({
    method: 'POST',
    route: '/api/system/register',
    body: { username: 'manager', password: 'pass123456' }
  });
  assert.equal(userRegister.status, 200);
  assert.equal(userRegister.json.role, 'user');

  const promote = await requestJson({
    method: 'PATCH',
    route: `/api/system/users/${userRegister.json.userId}/role`,
    token: adminLogin.json.token,
    body: { role: 'admin' }
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.json.user.role, 'admin');
});

test('uploads endpoint requires auth', async () => {
  const response = await requestJson({ method: 'GET', route: '/uploads/some-file.jpg' });
  assert.equal(response.status, 401);
});
