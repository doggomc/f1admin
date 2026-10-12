#!/usr/bin/env node
'use strict';

/* Focused security checks for Race Control: production fails closed on weak
   credentials, CORS is constrained, mutations are same-origin, admin APIs
   require a signed session, login attempts are rate-limited, and the optional
   IP allowlist hides the dashboard. */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
let nextPort = 36500 + Math.floor(Math.random() * 2000);
function startServer(extra = {}) {
  const port = ++nextPort;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-security-data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SITE_URL: 'https://freef1.netlify.app',
      ADMIN_USER: 'security-admin',
      ADMIN_PASS: 'security-password',
      ADMIN_SECRET: 'security-test-secret',
      ADMIN_IP_ALLOWLIST: '',
      DATA_DIR: dataDir,
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      KV_REST_API_URL: '',
      KV_REST_API_TOKEN: '',
      ALLOWED_ORIGIN: 'https://freef1.netlify.app',
      TRUST_PROXY_HOPS: '0',
      ...extra
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', data => { log += data.toString(); });
  child.stderr.on('data', data => { log += data.toString(); });
  const base = `http://127.0.0.1:${port}`;
  return { child, base, dataDir, log: () => log };
}
async function ready(server) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(server.base + '/healthz')).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server failed to start: ${server.log()}`);
}
async function stop(server) {
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM');
    await new Promise(resolve => server.child.once('exit', resolve));
  }
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}
async function json(response) {
  try { return await response.json(); } catch (_) { return {}; }
}

(async () => {
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });
  const server = startServer();
  try {
    await ready(server);
    const allowed = await fetch(server.base + '/api/site/config', { headers: { Origin: 'https://freef1.netlify.app' } });
    check('public site origin can read config', allowed.status === 200 && allowed.headers.get('access-control-allow-origin') === 'https://freef1.netlify.app');
    const denied = await fetch(server.base + '/api/site/config', { headers: { Origin: 'https://untrusted.example' } });
    check('foreign origins cannot read public config', denied.status === 403);

    const external = await fetch(server.base + '/admin/api/news');
    check('admin news is not public', external.status === 401);
    const sameOrigin = server.base;
    const csrf = await fetch(server.base + '/admin/api/login', {
      method: 'POST', headers: { Origin: 'https://freef1.netlify.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'security-admin', password: 'security-password' })
    });
    check('cross-origin login is blocked', csrf.status === 403);

    const session = await fetch(server.base + '/admin/api/login', {
      method: 'POST', headers: { Origin: sameOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'security-admin', password: 'security-password' })
    });
    const cookie = (session.headers.get('set-cookie') || '').split(/,(?=\s*f1admin\.sid(?:\.sig)?=)/).map(part => part.split(';')[0].trim()).filter(Boolean).join('; ');
    check('correct credentials establish an admin session', session.status === 200 && Boolean(cookie));
    const crossSiteMutation = await fetch(server.base + '/admin/api/maintenance', {
      method: 'POST', headers: { Origin: 'https://freef1.netlify.app', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true })
    });
    check('same-site cookie cannot authorize cross-origin admin changes', crossSiteMutation.status === 403);

    let loginStatuses = [];
    for (let i = 0; i < 7; i++) {
      const response = await fetch(server.base + '/admin/api/login', {
        method: 'POST', headers: { Origin: sameOrigin, 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i + 1}` },
        body: JSON.stringify({ username: 'security-admin', password: 'wrong-password' })
      });
      loginStatuses.push(response.status);
    }
    check('login attempts are limited despite spoofed forwarding headers', loginStatuses.slice(0, 6).every(status => status === 401) && loginStatuses[6] === 429, loginStatuses.join(','));

  } catch (error) {
    check('security scenario completed', false, error.stack || String(error));
  } finally {
    await stop(server);
  }

  const restricted = startServer({ ADMIN_IP_ALLOWLIST: '203.0.113.19' });
  try {
    await ready(restricted);
    const page = await fetch(restricted.base + '/admin/');
    const status = await fetch(restricted.base + '/admin/api/status');
    check('IP allowlist hides dashboard and APIs from other addresses', page.status === 404 && status.status === 404, `${page.status}/${status.status}`);
  } catch (error) {
    check('IP allowlist scenario completed', false, error.stack || String(error));
  } finally {
    await stop(restricted);
  }

  const productionPort = ++nextPort;
  const production = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(productionPort),
      ADMIN_USER: '', ADMIN_PASS: '', ADMIN_SECRET: '',
      UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', KV_REST_API_URL: '', KV_REST_API_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const productionExit = new Promise(resolve => production.once('exit', resolve));
  let productionLog = '';
  production.stdout.on('data', data => { productionLog += data.toString(); });
  production.stderr.on('data', data => { productionLog += data.toString(); });
  const exit = await productionExit;
  check('production process refuses weak or missing admin secrets', exit !== 0 && /Refusing to start with insecure production settings/.test(productionLog), productionLog.trim());

  let failed = 0;
  for (const item of checks) {
    if (!item.pass) failed++;
    console.log(` ${item.pass ? ' ok ' : 'FAIL'}   ${item.label}${item.pass || !item.detail ? '' : `  →  ${item.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
