#!/usr/bin/env node
'use strict';

/* Browser-level smoke checks for the static site. The site must boot and keep
   its local stream selector usable if Race Control is unavailable; public
   motorsport APIs are direct browser requests with local fallback, and no
   visitor/analytics/stream-proxy API is contacted. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');
const indexPath = path.join(siteDir, 'index.html');
if (!fs.existsSync(indexPath)) throw new Error(`Site not found: ${indexPath}`);
const html = fs.readFileSync(indexPath, 'utf8');
const appSource = fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8');
const redirects = fs.readFileSync(path.join(siteDir, '_redirects'), 'utf8');

function boot({ backendOffline = false, seedSnapshot = false, forceLive = false } = {}) {
  const runtimeErrors = [];
  const requested = [];
  const blockedByCsp = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://freef1.netlify.app/' });
  const { window } = dom;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.console = console;
  window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null });
  window.requestIdleCallback = callback => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
  window.scrollTo = () => {};
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!window.crypto || !window.crypto.randomUUID) Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => 'site-dom-test' } });
  Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { hasBeenActive: false } });
  window.addEventListener('error', event => runtimeErrors.push(String(event.error || event.message)));
  const now = Date.now();
  if (seedSnapshot) {
    window.localStorage.setItem('freef1_site_config_v2', JSON.stringify({
      savedAt: now - 10 * 60 * 1000,
      config: { sources: { disabled: ['dazn'] }, news: [], streamOverride: { active: false }, streamWindow: { active: false }, experimental: { enabled: true } }
    }));
    window.localStorage.setItem('freef1_user_id', 'retired-browser-id');
    window.localStorage.setItem('freef1_visitor_token', 'retired-token');
    window.localStorage.setItem('freef1_active_count', '123');
  }

  const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, options = {}) => {
    const value = String(url);
    requested.push({ url: value, options });
    let hostname = 'self';
    try { hostname = new URL(value, 'https://freef1.netlify.app/').hostname; } catch (_) {}
    const allowed = new Set(['freef1.netlify.app', 'f1admin.onrender.com', 'api.openf1.org', 'api.jolpi.ca']);
    if (!allowed.has(hostname)) { blockedByCsp.push(value); throw new TypeError(`CSP blocked ${hostname}`); }
    if (value.includes('/api/site/config')) {
      if (backendOffline) throw new TypeError('Race Control offline');
      return response({ maintenance: { active: false }, news: [], sources: { disabled: [] }, streamOverride: { active: false }, streamWindow: { active: forceLive, reason: forceLive ? 'test force' : '', startedAt: forceLive ? Date.now() : null }, experimental: { enabled: true } });
    }
    if (value.includes('driverstandings')) return response({ MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [] }] } } });
    if (value.includes('constructorstandings')) return response({ MRData: { StandingsTable: { StandingsLists: [{ ConstructorStandings: [] }] } } });
    if (value.includes('api.openf1.org')) return response([]);
    if (value.includes('api.jolpi.ca')) return response({ MRData: { RaceTable: { Races: [] }, total: '0' } });
    return response({});
  };

  try {
    window.eval(appSource + `\n;window.__freef1TestState = () => ({\n  ids: sources.map(source => source.id),\n  labels: sources.map(source => source.label),\n  urls: sources.map(source => source.url || ''),\n  disabled: [...disabledSources],\n  streamOverride: { ...streamOverride },\n  streamWindow: { ...streamWindowState },\n  selectedStreamAvailable: isStreamAvailable(currentSession),\n  live: (() => { const live = getCurrentLiveSession(); return live ? { forced: live.forced === true, session: live.session.name } : null; })(),\n  viewNames: Object.keys(VIEWS),\n  activeView,\n  legacyRoutesResolveHome: routeFromPath('/performance') === 'home' && routeFromPath('/247') === 'home'\n});`);
  } catch (error) {
    runtimeErrors.push(`${error.message}\n${error.stack}`);
  }
  return { window, requested, runtimeErrors, blockedByCsp };
}

(async () => {
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });

  const normal = boot();
  await new Promise(resolve => setTimeout(resolve, 250));
  const $ = id => normal.window.document.getElementById(id);
  check('app.js boots without runtime errors', normal.runtimeErrors.length === 0, normal.runtimeErrors.join(' | '));
  check('no startup availability gate or visitor counter remains', !normal.window.document.documentElement.classList.contains('site-checking') && !$('visitorCount'));
  check('stream selector renders from local source definitions', $('links')?.children.length > 0, String($('links')?.children.length || 0));
  const pageRoutesRemoved = ['viewPerformance', 'view247', 'footExperimental'].every(id => !normal.window.document.getElementById(id)) &&
    !normal.window.document.querySelector('[data-route=\"performance\"], [data-route=\"track\"], [data-route=\"247\"], [data-route=\"audio\"]');
  check('experimental Performance and 24/7 pages are removed from the site and footer', pageRoutesRemoved && !html.includes('Experimental'));
  check('removed page routes are absent from SPA views and Netlify rewrites',
    normal.window.__freef1TestState?.().legacyRoutesResolveHome === true &&
    !normal.window.__freef1TestState?.().viewNames.some(route => ['performance', 'track', '247', 'audio'].includes(route)) &&
    !redirects.split('\n').some(line => /^\/(performance|track|audio|247)(?:\/|\s)/.test(line)));
  check('regular Session Results remain available in the cockpit', Boolean($('sessionsOverlay') && $('sessionsBtn')));
  check('Race Control is requested only as optional site config', normal.requested.filter(item => item.url.includes('f1admin.onrender.com')).length === 1,
    normal.requested.filter(item => item.url.includes('f1admin.onrender.com')).map(item => item.url).join(' '));
  check('public sports data is fetched directly from providers', normal.requested.some(item => item.url.includes('api.jolpi.ca')) &&
    !normal.requested.some(item => item.url.includes('f1admin.onrender.com') && !item.url.includes('/api/site/config')));
  check('Fly 44 and Sky UK 2 sources are absent', typeof normal.window.__freef1TestState === 'function' &&
    !normal.window.__freef1TestState().ids.some(id => ['sky-sports-f1', 'sky-uk-2'].includes(id)) &&
    !normal.window.__freef1TestState().labels.some(label => /Sky UK 2|Sky Sports F1/i.test(label)));
  check('stream source URLs are present in the static app, not fetched as backend tickets',
    normal.window.__freef1TestState?.().urls.some(url => url.startsWith('https://')) &&
    !normal.requested.some(item => /\/api\/stream\/ticket|\/stream\//.test(item.url)));
  check('CSP-allowed direct providers were sufficient for startup', normal.blockedByCsp.length === 0, normal.blockedByCsp.join(', '));
  check('no visitor, analytics, heartbeat, SSE, or proxy APIs are requested',
    !normal.requested.some(item => /visitor|analytics|heartbeat|\/api\/events|\/api\/stream\/ticket|\/api\/news/.test(item.url)));

  const termsLink = normal.window.document.querySelector('.foot-links button[data-panel=\"termsPanel\"]');
  termsLink?.dispatchEvent(new normal.window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 300));
  check('clean footer policy links still open the correct Information panel',
    normal.window.__freef1TestState?.().activeView === 'info' && normal.window.document.getElementById('termsPanel')?.classList.contains('active'));

  const forced = boot({ forceLive: true });
  await new Promise(resolve => setTimeout(resolve, 250));
  const forcedState = forced.window.__freef1TestState?.();
  check('Race Control Force Live bypasses the schedule window for the selected session',
    forcedState?.streamWindow.active === true && forcedState.selectedStreamAvailable === true && forcedState.live?.forced === true);

  const offline = boot({ backendOffline: true, seedSnapshot: true });
  await new Promise(resolve => setTimeout(resolve, 250));
  const offlineState = offline.window.__freef1TestState?.();
  check('site still boots when Race Control is offline', offline.runtimeErrors.length === 0 && offline.window.document.getElementById('links').children.length > 0, offline.runtimeErrors.join(' | '));
  check('last local site settings remain available during outage', offlineState?.disabled.includes('dazn') === true);
  check('failed Race Control request is not retried or polled', offline.requested.filter(item => item.url.includes('f1admin.onrender.com')).length === 1);
  check('legacy visitor ID/token/count are removed from local storage',
    ['freef1_user_id', 'freef1_visitor_token', 'freef1_active_count'].every(key => offline.window.localStorage.getItem(key) === null));
  check('outage path never calls visitor, analytics, SSE, or stream proxy APIs',
    !offline.requested.some(item => /visitor|analytics|heartbeat|\/api\/events|\/api\/stream\/ticket/.test(item.url)));

  let failed = 0;
  for (const item of checks) {
    if (!item.pass) failed++;
    console.log(` ${item.pass ? ' ok ' : 'FAIL'}   ${item.label}${item.pass || !item.detail ? '' : `  →  ${item.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
