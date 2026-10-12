#!/usr/bin/env node
'use strict';

/* End-to-end Race Control checks. The public visitor/analytics/stream-proxy
   APIs must not exist; public config is cacheable and admin mutations are
   authenticated, same-origin, and persisted as one small snapshot. */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 34500 + Math.floor(Math.random() * 5000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-control-data-'));
fs.writeFileSync(path.join(dataDir, 'stream-window.json'), JSON.stringify({
  active: true, reason: 'Migrated legacy setting', startedAt: 1_761_900_000_000, updatedAt: 1_761_900_100_000
}));
const base = `http://127.0.0.1:${port}`;
const origin = base;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SITE_URL: 'https://freef1.netlify.app',
    ADMIN_USER: 'smoke-admin',
    ADMIN_PASS: 'smoke-password',
    ADMIN_SECRET: 'smoke-test-secret',
    ADMIN_IP_ALLOWLIST: '',
    DATA_DIR: dataDir,
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    ALLOWED_ORIGIN: 'https://freef1.netlify.app'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await wait(100);
  }
  throw new Error(`Server did not start.\n${output}`);
}
async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) {}
  return { response, body, text };
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(/,(?=\s*f1admin\.sid(?:\.sig)?=)/).map(part => part.split(';')[0].trim()).filter(Boolean).join('; ');
}

(async () => {
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });
  try {
    await waitForServer();

    const health = await request('/healthz');
    check('health endpoint is small and uncached', health.response.status === 200 && health.body.ok === true && health.response.headers.get('cache-control') === 'no-store');
    check('security headers are present', health.response.headers.get('x-powered-by') === null && health.response.headers.get('x-content-type-options') === 'nosniff');

    const home = await request('/', { redirect: 'manual' });
    check('Render root redirects to the static Netlify site', home.response.status === 302 && home.response.headers.get('location') === 'https://freef1.netlify.app/');

    const siteConfig = await request('/api/site/config', { headers: { Origin: 'https://freef1.netlify.app' } });
    check('public site config is served without admin credentials', siteConfig.response.status === 200 && siteConfig.body.maintenance?.active === false);
    check('public config is HTTP-cacheable for five minutes', /public, max-age=300/.test(siteConfig.response.headers.get('cache-control') || ''));
    check('CORS allows the public site origin', siteConfig.response.headers.get('access-control-allow-origin') === 'https://freef1.netlify.app');
    const deniedOrigin = await request('/api/site/config', { headers: { Origin: 'https://evil.example' } });
    check('untrusted browser origins are rejected', deniedOrigin.response.status === 403);

    const adminPage = await request('/admin/');
    check('admin panel is served from Render with no-store', adminPage.response.status === 200 && /Race Control/.test(adminPage.text) && adminPage.response.headers.get('cache-control') === 'no-store');
    check('admin page has no visitor or analytics module references', !/analytics\.js|charts\.js|visitorTable|onlineCount/.test(adminPage.text));

    const missingSession = await request('/admin/api/news', { headers: { Origin: origin } });
    check('admin data endpoints require a session', missingSession.response.status === 401);
    const missingForceLiveSession = await request('/admin/api/stream/window', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true })
    });
    check('Force Live changes require an authenticated admin session', missingForceLiveSession.response.status === 401);
    const crossOriginLogin = await request('/admin/api/login', {
      method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke-admin', password: 'smoke-password' })
    });
    check('cross-origin login is refused', crossOriginLogin.response.status === 403);

    const login = await request('/admin/api/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke-admin', password: 'smoke-password' })
    });
    const cookie = cookieFrom(login.response);
    check('valid same-origin admin login sets a session', login.response.status === 200 && login.body.success === true && Boolean(cookie));
    const authHeaders = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };

    const dashboardConfig = await request('/admin/api/config', { headers: { Origin: origin, Cookie: cookie } });
    check('dashboard receives its single compact config payload', dashboardConfig.response.status === 200 && Array.isArray(dashboardConfig.body.sourceList) && Array.isArray(dashboardConfig.body.adminNews), `${dashboardConfig.response.status} ${JSON.stringify(dashboardConfig.body)}`);
    check('legacy Force Live state migrates into the admin config snapshot', dashboardConfig.body.streamWindow?.active === true && dashboardConfig.body.streamWindow?.reason === 'Migrated legacy setting');
    const sourceIds = Array.isArray(dashboardConfig.body.sourceList) ? dashboardConfig.body.sourceList.map(source => source.id) : [];
    check('retired Sky and Fly 44 source IDs are not registered', !sourceIds.includes('sky-sports-f1') && !sourceIds.includes('sky-uk-2'));
    check('local-only state is explicitly marked non-durable', dashboardConfig.body.storage?.store === 'local' && dashboardConfig.body.storage?.durable === false);

    const maintenance = await request('/admin/api/maintenance', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ active: true, message: 'Pit stop', eta: 'Five minutes' })
    });
    check('maintenance changes persist without overwriting other settings', maintenance.response.status === 200 && maintenance.body.maintenance?.active === true);
    const snapshotFile = path.join(dataDir, 'race-control.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    check('saved state remains a combined config snapshot', Boolean(snapshot.maintenance && Array.isArray(snapshot.news) && snapshot.sources && snapshot.streamOverride && snapshot.streamWindow && snapshot.experimental));

    const forceLive = await request('/admin/api/stream/window', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ active: true, reason: 'Smoke test red flag' })
    });
    check('authenticated admin can enable Force Live', forceLive.response.status === 200 && forceLive.body.streamWindow?.active === true && forceLive.body.streamWindow?.reason === 'Smoke test red flag');
    const publicForceLive = await request('/api/site/config');
    check('Force Live is included in the public site config', publicForceLive.body.streamWindow?.active === true);
    const restoreSchedule = await request('/admin/api/stream/window', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ active: false })
    });
    check('Force Live can be disabled to restore schedule checks', restoreSchedule.response.status === 200 && restoreSchedule.body.streamWindow?.active === false);

    const news = await request('/admin/api/news', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ title: 'Smoke test update', body: 'Race Control is online.', tag: 'Test', published: true })
    });
    check('admin can publish a sanitized news item', news.response.status === 201 && news.body.news?.title === 'Smoke test update');
    const publicAfterNews = await request('/api/site/config');
    check('published news is included in the cacheable public snapshot', publicAfterNews.body.news?.[0]?.title === 'Smoke test update');

    const invalidSource = await request('/admin/api/stream/sources', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: ['sky-uk-2'] })
    });
    check('removed source IDs cannot be re-enabled through the API', invalidSource.response.status === 400);
    const sourceChange = await request('/admin/api/stream/sources', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: ['dazn'] })
    });
    check('source settings can be changed by an authenticated admin', sourceChange.response.status === 200 && sourceChange.body.disabled.includes('dazn'));

    const badOverride = await request('/admin/api/stream/override', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ url: 'http://insecure.example/video.mp4' })
    });
    check('stream overrides require HTTPS', badOverride.response.status === 400);
    const override = await request('/admin/api/stream/override', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ' })
    });
    check('YouTube override is normalized for embed playback', override.response.status === 200 && override.body.override?.url?.includes('youtube-nocookie.com/embed/'));
    const publicOverride = await request('/api/site/config');
    check('active override is published via the public snapshot', publicOverride.body.streamOverride?.active === true);
    await request('/admin/api/stream/stop', { method: 'POST', headers: authHeaders, body: '{}' });

    const retiredPaths = [
      '/api/visitors/token', '/api/visitors/heartbeat', '/api/visitors/event',
      '/api/visitors/active', '/api/analytics', '/api/news', '/api/stream/ticket',
      '/api/site/status', '/api/events'
    ];
    const retiredStatuses = [];
    for (const pathname of retiredPaths) retiredStatuses.push((await request(pathname)).response.status);
    check('retired visitor, analytics, SSE, proxy and duplicate news APIs are gone', retiredStatuses.every(status => status === 404), retiredStatuses.join(','));

    const leakedData = await request('/data/analytics.json');
    check('old tracking data is not exposed by the service', leakedData.response.status === 404);
    const loginAgain = await request('/admin/api/status', { headers: { Cookie: cookie } });
    check('session status reports the authenticated admin', loginAgain.response.status === 200 && loginAgain.body.authenticated === true);
    const logout = await request('/admin/api/logout', { method: 'POST', headers: authHeaders, body: '{}' });
    const loggedOut = await request('/admin/api/status');
    check('logout clears the browser session cookie and status is unauthenticated', logout.response.status === 200 && loggedOut.response.status === 200 && loggedOut.body.authenticated === false);
  } catch (error) {
    check('integration scenario completed', false, error.stack || String(error));
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const item of checks) {
    if (!item.pass) failed++;
    console.log(` ${item.pass ? ' ok ' : 'FAIL'}   ${item.label}${item.pass || !item.detail ? '' : `  →  ${item.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
