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
fs.writeFileSync(path.join(dataDir, 'race-control.json'), JSON.stringify({ news: [{ id: 'old', title: 'Old', body: 'remove' }], maintenance: { active: false, message: 'keep me', eta: 'Soon' } }));
fs.writeFileSync(path.join(dataDir, 'news.json'), JSON.stringify([{ title: 'legacy' }]));
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
    check('News is removed from the public snapshot', !('news' in siteConfig.body));
    check('stored News is removed while other state survives migration', !fs.existsSync(path.join(dataDir, 'news.json')) && !('news' in JSON.parse(fs.readFileSync(path.join(dataDir, 'race-control.json'), 'utf8'))) && siteConfig.body.maintenance.message === 'keep me');
    check('public config is HTTP-cacheable for five minutes and edge-cached for 60s',
      /public, max-age=300/.test(siteConfig.response.headers.get('cache-control') || '') &&
      /public, s-maxage=60/.test(siteConfig.response.headers.get('netlify-cdn-cache-control') || ''));
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
    check('admin panel cache-busts its stylesheet and script URLs',
      /\/admin\/admin\.css\?v=[a-f0-9]{10}/.test(adminPage.text) &&
      /\/admin\/admin\.js\?v=[a-f0-9]{10}/.test(adminPage.text));
    const adminJs = await request('/admin/admin.js');
    check('admin static assets revalidate instead of serving stale 1h cache',
      adminJs.response.status === 200 && /no-cache/.test(adminJs.response.headers.get('cache-control') || ''));
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
    check('dashboard receives its single compact config payload', dashboardConfig.response.status === 200 && Array.isArray(dashboardConfig.body.sourceList) && !('adminNews' in dashboardConfig.body), `${dashboardConfig.response.status} ${JSON.stringify(dashboardConfig.body)}`);
    check('legacy Force Live state migrates into the admin config snapshot', dashboardConfig.body.streamWindow?.active === true && dashboardConfig.body.streamWindow?.reason === 'Migrated legacy setting');
    check('Page Control lists Other, Replays and Other streams', ['other','replays','other-streams'].every(id => dashboardConfig.body.pageList.some(page => page.id === id)));
    const sourceIds = Array.isArray(dashboardConfig.body.sourceList) ? dashboardConfig.body.sourceList.map(source => source.id) : [];
    check('Hakuna Sky Sports uses the clean embed', require('../stream-resolver').STREAM_SOURCES.find(source => source.id === 'sky-sports')?.links?.[0]?.url === 'https://hakunamatata5.org/sky-main-event/clean.html');
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
    check('saved state remains a combined config snapshot', Boolean(snapshot.maintenance && snapshot.pages && !('news' in snapshot) && snapshot.sources && snapshot.streamOverride && snapshot.streamWindow && snapshot.experimental));

    const invalidPage = await request('/admin/api/pages', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: ['home'] })
    });
    check('Home cannot be disabled through Page Control', invalidPage.response.status === 400);
    const pageOutage = await request('/admin/api/pages', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: ['standings', 'help', 'other', 'replays', 'other-streams'] })
    });
    check('authenticated admin can set Standings to Partial Outage', pageOutage.response.status === 200 && pageOutage.body.pages?.disabled?.includes('standings'));
    const pushedPageOutage = await readNextConfigEvent();
    check('Page Control outage is broadcast immediately to open public tabs',
      pushedPageOutage.pages?.disabled?.includes('standings') && pushedPageOutage.pages?.disabled?.includes('help') && ['other','replays','other-streams'].every(id => pushedPageOutage.pages?.disabled?.includes(id)));
    const pausedHelpConfig = await request('/api/help/config', { headers: { Origin: 'https://freef1.netlify.app' } });
    const pausedHelpCreate = await request('/api/help/tickets', {
      method: 'POST',
      headers: { Origin: 'https://freef1.netlify.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tester', category: 'website', message: 'Testing paused help desk.' })
    });
    check('disabling Help in Page Control pauses /api/help/config and blocks ticket creation with 503',
      pausedHelpConfig.body.available === false && pausedHelpConfig.body.pausedByAdmin === true && pausedHelpCreate.response.status === 503);
    const restorePages = await request('/admin/api/pages', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: [] })
    });
    check('authenticated admin can restore all categories online', restorePages.response.status === 200 && restorePages.body.pages?.disabled?.length === 0);
    await readNextConfigEvent();

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

    const removedNews = await request('/admin/api/news', { headers: { Origin: origin, Cookie: cookie } });
    check('authenticated News endpoint has been removed', removedNews.response.status === 404);
    const customCatalogue = { custom: [{ id:'custom-test', label:'Test feed', url:'https://example.com/embed', tab:'other' }], disabled: ['dazn'], removed: ['sky-uk'], overrides: { dazn: { label:'Race feed' } }, order: ['custom-test', 'dazn'] };
    const savedCatalogue = await request('/admin/api/stream/catalogue', { method:'POST', headers:authHeaders, body:JSON.stringify(customCatalogue) });
    check('catalogue atomically adds, orders, edits, hides and removes sources', savedCatalogue.response.status === 200 && savedCatalogue.body.sourceList[0]?.id === 'custom-test' && !savedCatalogue.body.sourceList.some(x => x.id === 'sky-uk') && savedCatalogue.body.sources.overrides.dazn.label === 'Race feed');
    const pushedCatalogue = await readNextConfigEvent();
    check('custom catalogue reaches public config without refresh', pushedCatalogue.sources.custom[0]?.id === 'custom-test' && pushedCatalogue.sources.disabled.includes('sky-uk') && pushedCatalogue.sources.order[0] === 'custom-test');
    const badCatalogue = await request('/admin/api/stream/catalogue', { method:'POST', headers:authHeaders, body:JSON.stringify({ ...customCatalogue, custom:[{ id:'custom-test', label:'Bad', url:'http://example.com', tab:'en' }] }) });
    check('insecure custom source is rejected without changing state', badCatalogue.response.status === 400 && JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).sources.custom[0]?.label === 'Test feed');
    const clearCatalogue = await request('/admin/api/stream/catalogue', { method:'POST', headers:authHeaders, body:JSON.stringify({ custom:[], disabled:[], removed:[], overrides:{}, order:[] }) });
    check('catalogue can remove custom sources and restore defaults', clearCatalogue.response.status === 200 && !clearCatalogue.body.sources.custom.length && clearCatalogue.body.sourceList.some(x => x.id === 'sky-uk'));
    await readNextConfigEvent();

    const invalidSource = await request('/admin/api/stream/sources', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: ['sky-uk-2'] })
    });
    check('removed source IDs cannot be re-enabled through the API', invalidSource.response.status === 400);
    const sourceChange = await request('/admin/api/stream/sources', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ disabled: ['dazn', 'sky-uhd'] })
    });
    const adminCfgAfterSave = await request('/admin/api/config', { headers: { Origin: origin, Cookie: cookie } });
    check('source settings can be changed by an authenticated admin without leaking retired sky-uhd into admin config',
      sourceChange.response.status === 200 &&
      sourceChange.body.disabled.includes('dazn') &&
      !sourceChange.body.disabled.includes('sky-uhd') &&
      !adminCfgAfterSave.body.sources?.disabled?.includes('sky-uhd'));

    const ppvSources = (sourceChange.body.sources || []).filter(item => item.provider === 'ppv');
    const ppvStrippedSources = (sourceChange.body.sources || []).filter(item => item.provider === 'ppv-stripped');
    check('all 9 PPV sources and 9 Stripped PPV counterparts are registered cleanly',
      ppvSources.length === 9 && ppvSources.every(item => /\(PPV\)$/.test(item.label)) &&
      ppvStrippedSources.length === 9 && ppvStrippedSources.every(item => item.stripped === true && /\(PPV Stripped\)$/.test(item.label)) &&
      !(sourceChange.body.sources || []).some(item => item.provider === 'taifood'));
    const ppvBulkOff = await request('/admin/api/stream/sources/bulk', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ group: 'ppv', action: 'disable' })
    });
    const ppvStrippedBulkOff = await request('/admin/api/stream/sources/bulk', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ group: 'ppv-stripped', action: 'disable' })
    });
    check('bulk PPV and PPV Stripped group toggles each touch all 9 sources independently',
      ppvBulkOff.response.status === 200 && ppvBulkOff.body.touched === 9 &&
      ppvStrippedBulkOff.response.status === 200 && ppvStrippedBulkOff.body.touched === 9);
    await request('/admin/api/stream/sources/bulk', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ group: 'ppv', action: 'enable' })
    });
    await request('/admin/api/stream/sources/bulk', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ group: 'ppv-stripped', action: 'enable' })
    });

    const { createStreamResolver } = require('../stream-resolver');
    const mockResolver = createStreamResolver({
      ppvResolveImpl: async ({ slug }) => ({
        ok: true,
        masterUrl: `https://bharat.indianservers.st/secure/TESTTOKEN/0/1899999999/${slug.split('/').pop()}/index.m3u8`
      }),
      fetchImpl: async (url, options) => {
        if (String(url).includes('indianservers.st/secure/TESTTOKEN/') && String(url).endsWith('/index.m3u8')) {
          const hdrs = options?.headers || {};
          if ((hdrs.Referer || hdrs.referer) !== 'https://taifood-blog.asia/') {
            return { ok: false, status: 403, text: async () => 'Forbidden' };
          }
          return {
            ok: true,
            status: 200,
            text: async () => '#EXTM3U\n## IRON DOME\n#EXT-X-STREAM-INF:BANDWIDTH=10060000,RESOLUTION=1920x1080\ntracks-v1a1/mono.ts.m3u8\n'
          };
        }
        if (String(url).includes('indianservers.st/secure/TESTTOKEN/') && String(url).endsWith('/tracks-v1a1/mono.ts.m3u8')) {
          const hdrs = options?.headers || {};
          if ((hdrs.Referer || hdrs.referer) !== 'https://taifood-blog.asia/') {
            return { ok: false, status: 403, text: async () => 'Forbidden' };
          }
          return {
            ok: true,
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:3.840,\nhttps://p16-common-sign.tiktokcdn.com/tos-alisg-v-4896/seg1~tplv-tiktokx-origin.image?x-expires=1794150000\n'
          };
        }
        if (String(url).includes('api.embdlol.st/struct')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 200,
              channels: [
                { id: '01a1b4d1-abab-728d-aedb-b4334056751d', channelname: 'Moto3/2/GP - Qatar - Saturday - DAZN' },
                { id: '01a1b624-6a06-75eb-8927-bcfc1c37791e', channelname: 'F1 - Sao Paulo - Saturday - Sky' },
                { id: '01a1b624-c0dd-7119-9596-76d79e8b5b9a', channelname: 'F1 - Sao Paulo - Saturday - UHD' },
                { id: '01a1b625-3629-7451-a024-99b4b0b14854', channelname: 'F1 - Sao Paulo - Saturday - ATV' },
                { id: '01a1b626-1295-72f0-9a1a-3d168ccd10f2', channelname: 'F1 - Sao Paulo - Saturday - 540p' },
                { id: '01a1b627-f5e0-71bd-bc45-f66b79cfeea5', channelname: 'F1 - Sao Paulo - Saturday - DAZN' },
                { id: '01a1b628-a900-70e8-b24e-79cb9c2f8a99', channelname: 'F1 - Sao Paulo - Saturday - SkyIT' },
                { id: '01a1b62b-689c-768f-86c0-f804724b0497', channelname: 'F1 - Sao Paulo - Saturday - SkyDE' }
              ]
            })
          };
        }
        if (String(url).includes('api.ppv.st/api/streams')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              streams: [{
                category: 'Motorsports',
                streams: [{
                  id: 31852,
                  name: 'São Paulo Grand Prix - Qualifying',
                  tag: 'Formula 1',
                  source_tag: 'HD | Sky Sports F1',
                  uri_name: 'f1/2026/brazil/qualifying',
                  locale: 'en-gb',
                  iframe: 'https://taifood-blog.asia/embed/f1/2026/brazil/qualifying',
                  substreams: [
                    { id: 1031852, source_tag: 'SD | Sky Sports F1', locale: 'en-gb', iframe: 'https://taifood-blog.asia/embed/f1/2026/brazil/qualifying_540p' },
                    { id: 31854, source_tag: 'HD | Apple TV (F1TV)', locale: 'en-us', iframe: 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31854' },
                    { id: 1031854, source_tag: 'SD | Apple TV (F1TV)', locale: 'en-us', iframe: 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31854_540p' },
                    { id: 31858, source_tag: 'HD | Sky Sport F1', locale: 'it', iframe: 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31858' },
                    { id: 31857, source_tag: 'HD | Sky Sport F1', locale: 'de', iframe: 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31857' }
                  ]
                }]
              }]
            })
          };
        }
        if (String(url).includes('strmfree.st/embed/racing/skyf11080p')) {
          const hdrs = options?.headers || {};
          if (hdrs.Referer || hdrs.referer) {
            return { ok: false, status: 403, text: async () => '{"detail":"Violation"}' };
          }
          return {
            ok: true,
            status: 200,
            text: async () => [
              '<!DOCTYPE html><html><head><title>Sky Sports F1</title>',
              '<script src="/static/mirror-client.js?v=2"></script>',
              '<script src="/analytics.js"></script>',
              "<script>(function(){ aclib.runPop({ zoneId: '10818186' }); })();</script>",
              '</head><body><div id="jwplayer"></div><script>',
              'const VARIANT = "skyf11080p"; const QUALITY = "1080p";',
              'const AUTOSTART = getAutostartFromURL();',
              'const _0x = {"1080p": {"_e": 1794154609, "_n": "3fc4d3cdc6ecb2d2", "_t": "n0S0giC4NRJOYdZQYGvAJg"}};',
              'async function getStreamSource(){ let url = `/live-externalcdn/${VARIANT}/index.m3u8`; const p = _0x[QUALITY]; if (p) { url += `?_t=${p._t}&_e=${p._e}&_n=${p._n}`; } return url; }',
              'const playerConfig = { mute: false }; window.sandDetect = () => { document.body.innerHTML = "blocked"; };',
              'document.body.insertAdjacentHTML("beforeend", \'<object id="sandDetect" onerror="window.sandDetect()"></object>\');',
              '(()=>{let a=()=>{document.body.insertAdjacentHTML(\'beforeend\',\'<iframe id="close" src="/ad.html"></iframe>\');};a()})();',
              'jwplayer("jwplayer");',
              '</script></body></html>'
            ].join('\n')
          };
        }
        if (String(url).includes('strmfree.st/live-externalcdn/skyf11080p/index.m3u8')) {
          return {
            ok: true,
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5.76,\nhttps://p16-common-sign.tiktokcdn.com/seg1.image\n#EXTINF:5.76,\nrelative-seg2.js\n'
          };
        }
        if (String(url).includes('weellz.live/beta')) {
          return {
            ok: true,
            status: 200,
            text: async () => [
              '<!doctype html><html><head><title>Player</title></head><body>',
              '<template id="rl-pu"><script src="https://capitalhospitals.org/1/b6758a8d28634c9706ac96e0212095ea" async></script></template>',
              '<script src="https://ssl.p.jwpcdn.com/player/v/8.39.3/jwplayer.js"></script>',
              '<script>function rlGuard(){return true;}</script>',
              '</body></html>'
            ].join('')
          };
        }
        if (String(url).includes('rewnd.live/k/')) {
          return {
            ok: true,
            status: 200,
            headers: { get: (h) => (String(h).toLowerCase() === 'date' ? 'Sat, 07 Nov 2026 12:00:00 GMT' : null) },
            arrayBuffer: async () => Uint8Array.from({ length: 16 }, (_, idx) => idx + 1).buffer
          };
        }
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
      }
    });
    const ppvCatalog = await mockResolver.taifoodChannels();
    const chipRows = await mockResolver.chipAddresses();
    const chipById = new Map(chipRows.map(row => [row.id, row]));
    const strippedEmbed = await mockResolver.weellzStrippedHtml();
    const keyRelay = await mockResolver.weellzAesKey('dflgjhacdfahpgchehacbdacoekfacieee', '2990184.0123456789abcdef0123');
    check('stream-resolver strips ad popup + rlGuard from weellz.live/beta and relays 16-byte AES keys',
      strippedEmbed.html.includes('<base href="https://weellz.live/">') &&
      strippedEmbed.html.includes('<meta name="referrer" content="no-referrer">') &&
      !strippedEmbed.html.includes('capitalhospitals.org') &&
      !strippedEmbed.html.includes('id="rl-pu"') &&
      strippedEmbed.html.includes('function _disabledRlGuard(') &&
      keyRelay.ok === true &&
      Buffer.isBuffer(keyRelay.body) &&
      keyRelay.body.length === 16 &&
      chipById.get('weelo-stripped-skyweelo')?.wouldUse === '/api/stream/weellz-embed?stream=dflgjhacdfahpgchehacbdacoekfacieee');
    const okEmbEmbed = await request('/api/stream/embdlol-embed?id=01a1b7c0-66f7-77f0-9268-7205c35c60b8', { headers: { Origin: 'null' } });
    const badEmbEmbed = await request('/api/stream/embdlol-embed?id=bad$id');
    check('embdlol-embed serves stripped ad-free player shell and resolves emb-stripped-* addresses',
      okEmbEmbed.response.status === 200 &&
      okEmbEmbed.response.headers.get('access-control-allow-origin') === '*' &&
      okEmbEmbed.text.includes('https://api.embdlol.st/watch') &&
      okEmbEmbed.text.includes('freef1-audio') &&
      !okEmbEmbed.text.includes('llvpn.com') &&
      !okEmbEmbed.text.includes('rtmark.net') &&
      badEmbEmbed.response.status === 400 &&
      chipById.get('emb-stripped-fullhd1')?.current === '/api/stream/embdlol-embed?id=01a1b624-6a06-75eb-8927-bcfc1c37791e' &&
      chipById.get('emb-stripped-uhd')?.current === '/api/stream/embdlol-embed?id=01a1b624-c0dd-7119-9596-76d79e8b5b9a');
    const sfStripped = await mockResolver.strmfreeStrippedHtml('skyf11080p', 'strmfree.st');
    const sfPlaylist = await mockResolver.strmfreePlaylist('live-externalcdn', 'skyf11080p', 'strmfree.st');
    const badSfUhd = await request('/api/stream/strmfree-embed?variant=skyf12160p');
    check('strmfree UHD is removed and base Sky HD is stripped with playlist relay',
      !chipById.has('sky-uhd') &&
      chipById.get('sky-uk')?.current === '/api/stream/strmfree-embed?variant=skyf11080p&host=strmfree.st' &&
      sfStripped.ok === true &&
      !sfStripped.html.includes('/analytics.js') &&
      !sfStripped.html.includes('aclib.runPop') &&
      !sfStripped.html.includes('/ad.html') &&
      sfStripped.html.includes('/api/stream/strmfree-m3u8/live-externalcdn/') &&
      sfPlaylist.ok === true &&
      sfPlaylist.body.includes('https://strmfree.st/live-externalcdn/skyf11080p/relative-seg2.js') &&
      badSfUhd.response.status === 400);
    const previewConfig = await request('/api/site/config', { headers: { Origin: 'https://deploy-preview-42--freef1.netlify.app' } });
    const mirrorPreviewConfig = await request('/api/site/config', { headers: { Origin: 'https://deploy-preview-8--freef2.netlify.app' } });
    const vercelProdConfig = await request('/api/site/config', { headers: { Origin: 'https://freef1-live.vercel.app' } });
    const vercelPreviewConfig = await request('/api/site/config', { headers: { Origin: 'https://freef1-live-git-main-team.vercel.app' } });
    const rogueNetlify = await request('/api/site/config', { headers: { Origin: 'https://random-other-site.netlify.app' } });
    const rogueVercel = await request('/api/site/config', { headers: { Origin: 'https://random-other-site.vercel.app' } });
    const badWeellzEmbed = await request('/api/stream/weellz-embed?stream=bad$id');
    const directWeellzEmbed = await request('/api/stream/weellz-embed?stream=gebdacefgfacieee&autoplay=1&mute=1', {
      headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' }
    });
    const directWeeloState = await request('/api/stream/weelo', {
      headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' }
    });
    const allowedWeeloState = await request('/api/stream/weelo', {
      headers: {
        Origin: 'https://freef1.netlify.app',
        Referer: 'https://freef1.netlify.app/cockpit.html',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'X-FreeF1-Client': 'cockpit'
      }
    });
    const badWeellzKey = await request('/api/stream/weellz-key/testkid?t=badtoken', { headers: { Origin: 'null' } });
    check('Netlify deploy previews, weelo/weellz direct-access blocks, and sandboxed weellz relay CORS headers work',
      previewConfig.response.status === 200 &&
      previewConfig.response.headers.get('access-control-allow-origin') === 'https://deploy-preview-42--freef1.netlify.app' &&
      mirrorPreviewConfig.response.status === 200 &&
      mirrorPreviewConfig.response.headers.get('access-control-allow-origin') === 'https://deploy-preview-8--freef2.netlify.app' &&
      vercelProdConfig.response.status === 200 &&
      vercelProdConfig.response.headers.get('access-control-allow-origin') === 'https://freef1-live.vercel.app' &&
      vercelPreviewConfig.response.status === 200 &&
      vercelPreviewConfig.response.headers.get('access-control-allow-origin') === 'https://freef1-live-git-main-team.vercel.app' &&
      rogueNetlify.response.status === 403 &&
      rogueVercel.response.status === 403 &&
      badWeellzEmbed.response.status === 400 &&
      directWeellzEmbed.response.status === 403 &&
      directWeeloState.response.status === 403 &&
      (allowedWeeloState.response.status === 200 || allowedWeeloState.response.status === 503) &&
      Array.isArray(dashboardConfig.body.linkReport?.streams) &&
      dashboardConfig.body.linkReport.streams.some(item => item.id === 'sky-uk' && item.current.includes('/api/stream/strmfree-embed')) &&
      badWeellzKey.response.status === 400 &&
      badWeellzKey.response.headers.get('access-control-allow-origin') === '*' &&
      badWeellzKey.response.headers.get('access-control-expose-headers') === 'Date, Retry-After');
    check('stream-resolver builds PPV channels from api.ppv.st/api/streams and drops all 540p variants',
      ppvCatalog.ppv === 'https://taifood-blog.asia/embed/f1/2026/brazil/qualifying' &&
      ppvCatalog.list.length === 3 &&
      ppvCatalog.list.every(item => !/540p/i.test(item.uri)) &&
      chipById.get('ppv')?.current === 'https://taifood-blog.asia/embed/f1/2026/brazil/qualifying' &&
      chipById.get('appletv')?.current === 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31854' &&
      chipById.get('sky-italia')?.current === 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31858' &&
      chipById.get('sky-de')?.current === 'https://taifood-blog.asia/embed/so-paulo-grand-prix---qualifying-31857' &&
      chipById.get('ppv-stripped')?.current === '/api/stream/ppv-embed?slug=f1%2F2026%2Fbrazil%2Fqualifying&host=taifood-blog.asia' &&
      chipById.get('appletv-stripped')?.current === '/api/stream/ppv-embed?slug=so-paulo-grand-prix---qualifying-31854&host=taifood-blog.asia' &&
      chipById.get('sky-italia-stripped')?.current === '/api/stream/ppv-embed?slug=so-paulo-grand-prix---qualifying-31858&host=taifood-blog.asia' &&
      chipById.get('sky-de-stripped')?.current === '/api/stream/ppv-embed?slug=so-paulo-grand-prix---qualifying-31857&host=taifood-blog.asia');
    const okPpvEmbed = await request('/api/stream/ppv-embed?slug=f1%2F2026%2Fbrazil%2Fqualifying&host=taifood-blog.asia', { headers: { Origin: 'null' } });
    const badPpv540 = await request('/api/stream/ppv-embed?slug=f1%2F2026%2Fbrazil%2Fqualifying_540p');
    const badPpvHost = await request('/api/stream/ppv-embed?slug=sky-sports-golf-29059&host=evil.example');
    const ppvMaster = await mockResolver.ppvMasterPlaylist('so-paulo-grand-prix---qualifying-31854', 'taifood-blog.asia');
    const ppvSub = await mockResolver.ppvSubPlaylist('so-paulo-grand-prix---qualifying-31854', 'tracks-v1a1/mono.ts.m3u8', 'taifood-blog.asia');
    const badPpvSub = await mockResolver.ppvSubPlaylist('so-paulo-grand-prix---qualifying-31854', '../secret.m3u8', 'taifood-blog.asia');
    check('ppv-embed and ppv-m3u8 strip ads, enforce Referer/SSRF rules, edge-cache playlists, and keep TikTok segments direct',
      okPpvEmbed.response.status === 200 &&
      okPpvEmbed.response.headers.get('access-control-allow-origin') === '*' &&
      okPpvEmbed.response.headers.get('netlify-cdn-cache-control') === 'no-store' &&
      /referer/i.test(okPpvEmbed.response.headers.get('vary') || '') &&
      okPpvEmbed.text.includes('/api/stream/ppv-m3u8/index.m3u8?slug=') &&
      okPpvEmbed.text.includes('TsSyncLoader') &&
      !okPpvEmbed.text.includes('aclib') &&
      badPpv540.response.status === 400 &&
      badPpvHost.response.status === 400 &&
      ppvMaster.ok === true &&
      ppvMaster.body.includes('sub.m3u8?slug=so-paulo-grand-prix---qualifying-31854&host=taifood-blog.asia&sub=tracks-v1a1%2Fmono.ts.m3u8') &&
      ppvSub.ok === true &&
      ppvSub.body.includes('https://p16-common-sign.tiktokcdn.com/tos-alisg-v-4896/seg1~tplv-tiktokx-origin.image') &&
      badPpvSub.ok === false &&
      badPpvSub.status === 400);
    check('stream-resolver resolves hyphenated EMB F1 channels (Sky, ATV, UHD, DAZN, SkyIT, SkyDE) and drops 540p/MotoGP',
      chipById.get('emb-fullhd1')?.current === 'https://embdlol.st/embed/01a1b624-6a06-75eb-8927-bcfc1c37791e' &&
      chipById.get('emb-fullhd3')?.current === 'https://embdlol.st/embed/01a1b625-3629-7451-a024-99b4b0b14854' &&
      chipById.get('emb-uhd')?.current === 'https://embdlol.st/embed/01a1b624-c0dd-7119-9596-76d79e8b5b9a' &&
      chipById.get('emb-dazn')?.current === 'https://embdlol.st/embed/01a1b627-f5e0-71bd-bc45-f66b79cfeea5' &&
      chipById.get('emb-skyit')?.current === 'https://embdlol.st/embed/01a1b628-a900-70e8-b24e-79cb9c2f8a99' &&
      chipById.get('emb-skyde')?.current === 'https://embdlol.st/embed/01a1b62b-689c-768f-86c0-f804724b0497');

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
