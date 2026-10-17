#!/usr/bin/env node
'use strict';

/* End-to-end Race Control checks. The public visitor/analytics/stream-proxy
   APIs must not exist; public config updates use a small push-only event stream,
   and admin mutations remain authenticated, same-origin, and persisted. */
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
    ALLOWED_ORIGIN: 'https://freef1.netlify.app',
    PUBLIC_NEWS_ENABLED: 'false',
    DISCORD_BOT_TOKEN: '',
    DISCORD_GUILD_ID: '',
    DISCORD_OWNER_ID: '',
    DISCORD_TICKETS_ENABLED: 'false'
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

function nextConfigEvent(reader) {
  let buffer = '';
  const decoder = new TextDecoder();
  return async function read(timeoutMs = 3000) {
    const readUntilConfig = async () => {
      while (true) {
        const frameEnd = buffer.indexOf('\n\n');
        if (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          if (!/^event:\s*config\s*$/m.test(frame)) continue;
          const dataLine = frame.split(/\r?\n/).find(line => line.startsWith('data:'));
          if (dataLine) return JSON.parse(dataLine.slice(5).trim());
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('Config event stream ended unexpectedly');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    let timer;
    try {
      return await Promise.race([
        readUntilConfig(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for config event')), timeoutMs); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

(async () => {
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });
  let updateController = null;
  let updateReader = null;
  let readNextConfigEvent = null;
  try {
    await waitForServer();

    const health = await request('/healthz');
    check('health endpoint is small and uncached', health.response.status === 200 && health.body.ok === true && health.response.headers.get('cache-control') === 'no-store');
    check('security headers are present', health.response.headers.get('x-powered-by') === null && health.response.headers.get('x-content-type-options') === 'nosniff');

    const home = await request('/', { redirect: 'manual' });
    check('Render root redirects to the static Netlify site', home.response.status === 302 && home.response.headers.get('location') === 'https://freef1.netlify.app/');

    const siteConfig = await request('/api/site/config', { headers: { Origin: 'https://freef1.netlify.app' } });
    check('public site config is served without admin credentials', siteConfig.response.status === 200 && siteConfig.body.maintenance?.active === false);
    check('public News payload is empty while the reversible hide flag is off', Array.isArray(siteConfig.body.news) && siteConfig.body.news.length === 0);
    check('public config is HTTP-cacheable for five minutes', /public, max-age=300/.test(siteConfig.response.headers.get('cache-control') || ''));
    check('CORS allows the public site origin', siteConfig.response.headers.get('access-control-allow-origin') === 'https://freef1.netlify.app');
    const deniedOrigin = await request('/api/site/config', { headers: { Origin: 'https://evil.example' } });
    check('untrusted browser origins are rejected', deniedOrigin.response.status === 403);

    const helpConfig = await request('/api/help/config', { headers: { Origin: 'https://freef1.netlify.app' } });
    check('Help configuration endpoint is public, uncached, and advertises text-only limits',
      helpConfig.response.status === 200 && helpConfig.body.available === false &&
      helpConfig.body.uploadsEnabled === false && helpConfig.body.limits?.initialMessage === 4000 &&
      helpConfig.response.headers.get('cache-control') === 'no-store');
    check('Help CORS exposes the bearer-header and retry-after contract',
      helpConfig.response.headers.get('access-control-allow-headers') === 'Content-Type, Authorization' &&
      helpConfig.response.headers.get('access-control-expose-headers') === 'Retry-After');
    const helpPreflight = await request('/api/help/ticket/messages', {
      method: 'OPTIONS', headers: { Origin: 'https://freef1.netlify.app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    check('Help browser preflight allows authenticated POST requests',
      helpPreflight.response.status === 204 && helpPreflight.response.headers.get('access-control-allow-origin') === 'https://freef1.netlify.app');
    const helpNoToken = await request('/api/help/ticket/status', { headers: { Origin: 'https://freef1.netlify.app' } });
    check('ticket status requires a browser bearer key', helpNoToken.response.status === 401);

    updateController = new AbortController();
    const siteUpdates = await fetch(`${base}/api/site/updates`, {
      headers: { Origin: 'https://freef1.netlify.app', Accept: 'text/event-stream' },
      signal: updateController.signal
    });
    updateReader = siteUpdates.body.getReader();
    readNextConfigEvent = nextConfigEvent(updateReader);
    const initialPush = await readNextConfigEvent();
    check('public update stream sends an initial compact config snapshot without caching',
      siteUpdates.status === 200 && (siteUpdates.headers.get('content-type') || '').includes('text/event-stream') &&
      /no-cache, no-transform/.test(siteUpdates.headers.get('cache-control') || '') && initialPush.maintenance?.active === false);

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
    const pushedMaintenance = await readNextConfigEvent();
    check('maintenance activation is pushed to already-open clients immediately',
      pushedMaintenance.maintenance?.active === true && pushedMaintenance.maintenance?.message === 'Pit stop');
    const snapshotFile = path.join(dataDir, 'race-control.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    check('saved state remains a combined config snapshot', Boolean(snapshot.maintenance && Array.isArray(snapshot.news) && snapshot.sources && snapshot.streamOverride && snapshot.streamWindow && snapshot.experimental));

    const forceLive = await request('/admin/api/stream/window', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ active: true, reason: 'Smoke test red flag' })
    });
    check('authenticated admin can enable Force Live', forceLive.response.status === 200 && forceLive.body.streamWindow?.active === true && forceLive.body.streamWindow?.reason === 'Smoke test red flag');
    const pushedForceLive = await readNextConfigEvent();
    check('Force Live changes are broadcast to connected public tabs',
      pushedForceLive.streamWindow?.active === true && pushedForceLive.streamWindow?.reason === 'Smoke test red flag');
    const publicForceLive = await request('/api/site/config');
    check('Force Live is included in the public site config', publicForceLive.body.streamWindow?.active === true);
    const restoreSchedule = await request('/admin/api/stream/window', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ active: false })
    });
    check('Force Live can be disabled to restore schedule checks', restoreSchedule.response.status === 200 && restoreSchedule.body.streamWindow?.active === false);
    const pushedRestoreSchedule = await readNextConfigEvent();
    check('schedule restoration is broadcast to connected public tabs', pushedRestoreSchedule.streamWindow?.active === false);

    const news = await request('/admin/api/news', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ title: 'Smoke test update', body: 'Race Control is online.', tag: 'Test', published: true })
    });
    check('admin can publish a sanitized news item while public display is hidden', news.response.status === 201 && news.body.news?.title === 'Smoke test update');
    const pushedNews = await readNextConfigEvent();
    check('published News stays out of public push events while the hide flag is off', Array.isArray(pushedNews.news) && pushedNews.news.length === 0);
    const publicAfterNews = await request('/api/site/config');
    check('published News stays out of public snapshots while admin data persists',
      Array.isArray(publicAfterNews.body.news) && publicAfterNews.body.news.length === 0);
    const adminNews = await request('/admin/api/news', { headers: { Origin: origin, Cookie: cookie } });
    check('News remains available in the authenticated admin data endpoint',
      adminNews.response.status === 200 && adminNews.body.news?.some(item => item.title === 'Smoke test update'));

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
    check('retired visitor/event, analytics, proxy and duplicate news APIs are gone', retiredStatuses.every(status => status === 404), retiredStatuses.join(','));

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
    if (updateController) updateController.abort();
    try { await updateReader?.cancel(); } catch (_) {}
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
