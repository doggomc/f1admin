#!/usr/bin/env node
'use strict';

/* Dashboard DOM/runtime check with a mocked authenticated API. Ensures IDs,
   auth boot, source editor and admin actions stay aligned, while verifying the
   dashboard performs no analytics, visitor, SSE, or timer-driven requests. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const adminDir = path.join(root, 'admin');
const html = fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(adminDir, 'admin.js'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://f1admin.onrender.com/admin/', pretendToBeVisual: true });
const { window } = dom;
if (window.document.getElementById('loadViewerPeaks') || source.includes("$('loadViewerPeaks')")) {
  throw new Error('Audience panel must not appear in Race Control');
}

const favicon = window.document.querySelector('link[rel="icon"]');
if (!favicon || favicon.getAttribute('href') !== '/admin/favicon.svg?v=freef1' || favicon.getAttribute('type') !== 'image/svg+xml') {
  throw new Error('Admin favicon must use the bundled FreeF1 SVG');
}
const icon = fs.readFileSync(path.join(adminDir, 'favicon.svg'), 'utf8');
if (!icon.includes('viewBox="0 0 64 64"') || !icon.includes('M10 45 24 17h13')) {
  throw new Error('Admin favicon does not match the FreeF1 icon');
}
const runtimeErrors = [];
window.console = console;
window.Headers = global.Headers;
window.confirm = () => true;
window.scrollTo = () => {};
window.addEventListener('error', event => runtimeErrors.push(String(event.error || event.message)));

/* The live list, straight from the resolver - the dashboard renders exactly the controls the
   backend serves, so this check cannot go stale. */
const FEED_SOURCES = require('../stream-resolver').STREAM_SOURCES.map(({ id, label, provider, tab, special, stripped }) => ({ id, label, provider, tab: tab || 'en', special, stripped }));
const PAGE_LIST = [
  { id: 'cockpit', label: 'Cockpit', path: '/cockpit.html', description: 'Live stream player, sources & multiviewer' },
  { id: 'schedule', label: 'Schedule', path: '/schedule.html', description: 'Season calendar & weekend session times' },
  { id: 'standings', label: 'Standings', path: '/standings.html', description: 'Drivers & Constructors championships' },
  { id: 'live-timing', label: 'Live timing', path: '/live-timing.html', description: 'Timing tower, sectors, race control & radio' },
  { id: 'drivers', label: 'Drivers', path: '/drivers.html', description: 'Driver grid & individual driver profiles' },
  { id: 'teams', label: 'Teams', path: '/teams.html', description: 'Constructor grid & team profiles' },
  { id: 'other', label: 'Other', path: '/other.html', description: 'Other section hub' },
  { id: 'replays', label: 'Replays', path: '/replays.html', description: 'Replay directory & replay player' },
  { id: 'other-streams', label: 'Other streams', path: '/other-streams.html', description: 'Other streams directory & private player' },
  { id: 'help', label: 'Help', path: '/help.html', description: 'Support desk & help tickets' }
];
let snapshot = {
  maintenance: { active: false, message: "We'll be back before the race.", eta: 'Before lights out', startedAt: null },
  pages: { disabled: [], updatedAt: null },
  pageList: PAGE_LIST,
  sources: { disabled: [], updatedAt: null },
  streamOverride: { active: false, input: null, url: null, type: null, startedAt: null },
  streamWindow: { active: false, reason: '', startedAt: null, updatedAt: null },
  experimental: { enabled: true }, sourceList: FEED_SOURCES,
  linkReport: { siteUrl: 'https://freef1.netlify.app', streams: [
    { id: FEED_SOURCES[0].id, online: true, current: '/api/stream/weellz-embed?stream=test', shipped: [
      { url: 'https://primary.example/', from: 'shipped' },
      { url: '/api/stream/fallback?x=1&y=2', from: 'provider <safe>' },
      { url: 'https://second.example/path', from: 'ppv-live' },
      { url: 'javascript:alert(1)', from: 'ppv-id' }
    ] },
    { id: FEED_SOURCES[1].id, shipped: [{ url: 'https://single.example/' }] }
  ] },
  storage: { store: 'upstash', durable: true, redisConfigured: true, localWritable: true }
};
const calls = [];
const writePayloads = [];
window.fetch = async (url, options = {}) => {
  const pathname = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  calls.push({ pathname, method, body: options.body ? JSON.parse(options.body) : null });
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  if (pathname.endsWith('/admin/api/status')) return reply({ authenticated: true, loginAt: Date.now() });
  if (pathname.endsWith('/admin/api/config')) return reply(structuredClone(snapshot));
  if (pathname.endsWith('/admin/api/pages')) {
    const body = calls.at(-1).body || {};
    snapshot.pages = { disabled: Array.isArray(body.disabled) ? body.disabled : [], updatedAt: Date.now() };
    writePayloads.push({ endpoint: 'pages', body });
    return reply({ success: true, pages: snapshot.pages, pageList: PAGE_LIST, durable: true, store: 'upstash' });
  }
  if (pathname.endsWith('/admin/api/maintenance')) {
    const body = calls.at(-1).body || {};
    snapshot.maintenance = { ...snapshot.maintenance, ...body, startedAt: body.active ? Date.now() : null };
    writePayloads.push({ endpoint: 'maintenance', body });
    return reply({ success: true, maintenance: snapshot.maintenance, durable: true, store: 'upstash' });
  }
  if (pathname.endsWith('/admin/api/stream/window')) {
    const body = calls.at(-1).body || {};
    snapshot.streamWindow = {
      active: body.active === true,
      reason: body.active === true ? String(body.reason || '') : '',
      startedAt: body.active === true ? (snapshot.streamWindow.active ? snapshot.streamWindow.startedAt : Date.now()) : null,
      updatedAt: Date.now()
    };
    writePayloads.push({ endpoint: 'stream-window', body });
    return reply({ success: true, streamWindow: snapshot.streamWindow, durable: true, store: 'upstash' });
  }
  if (pathname.endsWith('/admin/api/stream/sources')) {
    const body = calls.at(-1).body || {};
    snapshot.sources = { disabled: body.disabled || [], updatedAt: Date.now() };
    writePayloads.push({ endpoint: 'sources', body });
    return reply({ success: true, sources: FEED_SOURCES, ...snapshot.sources, durable: true, store: 'upstash' });
  }
  if (pathname.endsWith('/admin/api/stream/override')) {
    const body = calls.at(-1).body || {};
    snapshot.streamOverride = { active: true, input: body.url, url: 'https://www.youtube-nocookie.com/embed/abc123XYZ_0', type: 'youtube', startedAt: Date.now() };
    writePayloads.push({ endpoint: 'override', body });
    return reply({ success: true, override: snapshot.streamOverride, durable: true, store: 'upstash' });
  }
  if (pathname.endsWith('/admin/api/stream/stop')) {
    snapshot.streamOverride = { ...snapshot.streamOverride, active: false, startedAt: null };
    return reply({ success: true, override: snapshot.streamOverride, durable: true });
  }
  if (pathname.endsWith('/admin/api/stream/normal')) {
    snapshot.streamOverride = { active: false, input: null, url: null, type: null, startedAt: null };
    return reply({ success: true, override: snapshot.streamOverride, durable: true });
  }
  if (pathname.endsWith('/admin/api/stream/catalogue')) {
    const body = calls.at(-1).body || {};
    snapshot.sources = body;
    snapshot.sourceList = [...FEED_SOURCES.filter(x => !body.removed.includes(x.id)), ...body.custom.map(x => ({ ...x, isCustom:true, customLabel:x.label, customUrl:x.url }))].sort((a,b) => body.order.indexOf(a.id)-body.order.indexOf(b.id));
    writePayloads.push({ endpoint:'sources', body });
    return reply({ success:true, sources:snapshot.sources, sourceList:snapshot.sourceList, durable:true, store:'upstash' });
  }
  return reply({ error: `unexpected ${method} ${pathname}` }, 404);
};

(async () => {
  const checks = [];
  const check = (label, condition, detail = '') => checks.push({ label, pass: Boolean(condition), detail });
  try { window.eval(source); } catch (error) { runtimeErrors.push(`${error.message}\n${error.stack}`); }
  await new Promise(resolve => setTimeout(resolve, 80));

  const $ = id => window.document.getElementById(id);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const references = [...source.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]);
  const missing = [...new Set(references)].filter(id => !ids.has(id));
  check('every admin.js ID reference exists in index.html', missing.length === 0, missing.join(', '));
  check('authenticated dashboard opens and hides the login panel', $('dashboard').hidden === false && $('authScreen').hidden === true);
  check('initialization makes only status and one config request', calls.length === 2 && calls[0].pathname.endsWith('/status') && calls[1].pathname.endsWith('/config'), JSON.stringify(calls.map(call => call.pathname)));
  check('removed feeds are absent from source controls', !html.includes('sky-uk-2') && !html.includes('sky-sports-f1') &&
    ![...$('sourceList').querySelectorAll('.source-id')].some(el => /sky-uk-2|sky-sports-f1/.test(el.textContent)));
  const fallbackRow = $('sourceList').querySelector(`[data-source-id="${FEED_SOURCES[0].id}"]`);
  const disclosure = fallbackRow.querySelector('details.addr-fallbacks');
  const fallbackItems = [...disclosure.querySelectorAll('li')];
  check('relative relay primary links point to the backend', fallbackRow.querySelector('.addr-url').href === 'https://f1admin.onrender.com/api/stream/weellz-embed?stream=test');
  check('source overview reports draft visibility', Number($('sourceVisibleCount').textContent) === FEED_SOURCES.length && $('sourceHiddenCount').textContent === '0');
  check('fallback disclosure shows the correct count and begins closed', disclosure.querySelector('summary').textContent === '+3 fallbacks' && !disclosure.open);
  check('fallback addresses are complete, ordered and safely rendered', fallbackItems.map(item => item.querySelector('.addr-fallback-url').textContent).join('|') === 'https://f1admin.onrender.com/api/stream/fallback?x=1&y=2|https://second.example/path|javascript:alert(1)' && fallbackItems[0].querySelector('em').textContent === 'provider <safe>' && !fallbackItems[0].querySelector('safe'));
  check('only HTTP fallback addresses are links and open safely', fallbackItems.slice(0, 2).every(item => item.querySelector('a[target="_blank"][rel="noopener noreferrer"]')) && !fallbackItems[2].querySelector('a'));
  disclosure.querySelector('summary').click();
  check('fallback disclosure opens without a write', disclosure.open && writePayloads.length === 0);
  disclosure.querySelector('summary').click();
  check('fallback disclosure closes without a write', !disclosure.open && writePayloads.length === 0);
  check('single or missing addresses have no fallback disclosure', !$('sourceList').querySelector(`[data-source-id="${FEED_SOURCES[1].id}"] details.addr-fallbacks`) && !$('sourceList').querySelector(`[data-source-id="${FEED_SOURCES[2].id}"] details.addr-fallbacks`));
  check('admin public links use the current site', [...window.document.querySelectorAll('a[href*="freef1-live.vercel.app"]')].length >= 3 && ![...window.document.querySelectorAll('a')].some(a => a.href.includes('freef1.netlify.app')));
  const editor = fallbackRow.querySelector('details.source-editor');
  editor.querySelector('summary').click();
  const draftInput = editor.querySelector('input');
  draftInput.value = 'Draft name'; draftInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  $('sourceSearch').value = FEED_SOURCES[0].id;
  $('sourceSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('editing and filtering preserve draft values without writes', $('sourceList').querySelector('.source-custom input').value === 'Draft name' && writePayloads.length === 0 && $('sourceResults').textContent.startsWith('1 of '));
  $('sourceSearch').value = '';
  $('sourceSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('source instructions say to save draft switch changes', /Changes remain a draft until you save[\s\S]*Save source settings/i.test(html));
  check('no visitor, analytics, SSE, or recurring API request is made', calls.every(call => !/visitor|analytics|events|status\?/.test(call.pathname)));

  await new Promise(resolve => setTimeout(resolve, 120));
  check('idle dashboard does not poll or heartbeat', calls.length === 2, `${calls.length} request(s)`);

  const group = id => $('sourceBulk').querySelector(`[data-group="${id}"]`);
  const groupButton = (id, action) => group(id).querySelector(`button[aria-label^="${action}"]`);
  const weeloIds = FEED_SOURCES.filter(s => s.provider === 'weelo').map(s => s.id);
  const embIds = FEED_SOURCES.filter(s => s.provider === 'embdlol').map(s => s.id);
  check('provider controls are visible and have independent state', $('sourceBulk').closest('details').open && weeloIds.length > 0 && embIds.length > 0 && Boolean(group('special')));
  groupButton('weelo', 'Disable').click();
  check('disabling Weelo changes only Weelo in the draft', weeloIds.every(id => $('sourceList').querySelector(`[data-source-id="${id}"] .source-switch`).getAttribute('aria-pressed') === 'false') && embIds.every(id => $('sourceList').querySelector(`[data-source-id="${id}"] .source-switch`).getAttribute('aria-pressed') === 'true') && groupButton('weelo', 'Disable').getAttribute('aria-pressed') === 'true' && writePayloads.length === 0);
  groupButton('emb', 'Disable').click();
  groupButton('weelo', 'Enable').click();
  check('enabling Weelo leaves EMB disabled', weeloIds.every(id => $('sourceList').querySelector(`[data-source-id="${id}"] .source-switch`).getAttribute('aria-pressed') === 'true') && embIds.every(id => $('sourceList').querySelector(`[data-source-id="${id}"] .source-switch`).getAttribute('aria-pressed') === 'false'));
  $('saveSources').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  check('saving group changes publishes only the selected provider', embIds.every(id => snapshot.sources.disabled.includes(id)) && weeloIds.every(id => !snapshot.sources.disabled.includes(id)));
  groupButton('emb', 'Enable').click();
  $('saveSources').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  check('provider groups can be restored independently', embIds.every(id => !snapshot.sources.disabled.includes(id)) && weeloIds.every(id => !snapshot.sources.disabled.includes(id)));

  const standingsSwitch = $('pageControlList').querySelector('[data-page-id="standings"] .page-switch');
  standingsSwitch.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('Page Control switch flips Standings to Partial Outage', snapshot.pages.disabled.includes('standings') && writePayloads.some(item => item.endpoint === 'pages'));
  $('enableAllPages').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('Restore all pages clears Partial Outage state', snapshot.pages.disabled.length === 0);

  check('Page Control includes Other, Replays and Other streams', ['other','replays','other-streams'].every(id => $('pageControlList').querySelector(`[data-page-id="${id}"]`)));
  const toggle = $('sourceList').querySelector('.source-switch');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  $('saveSources').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('source controls submit only the intentional admin change', writePayloads.some(item => item.endpoint === 'sources') && calls.at(-1).method === 'POST');

  const filterChip = label => [...$('sourceFilters').querySelectorAll('button')].find(button => button.textContent.trim().startsWith(label));
  filterChip('Visible').click();
  const beforeVisible = $('sourceList').querySelectorAll('.source-row').length;
  $('sourceList').querySelector('.source-switch').click();
  check('hiding a source immediately removes it from the Visible filter', $('sourceList').querySelectorAll('.source-row').length === beforeVisible - 1);
  filterChip('Hidden').click();
  const beforeHidden = $('sourceList').querySelectorAll('.source-row').length;
  $('sourceList').querySelector('.source-switch').click();
  check('enabling a source immediately removes it from the Hidden filter', $('sourceList').querySelectorAll('.source-row').length === beforeHidden - 1);
  filterChip('All').click();

  $('forceLiveReason').value = 'Red flag delay';
  $('enableForceLive').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('Force Live can be enabled with an optional reason', snapshot.streamWindow.active === true && snapshot.streamWindow.reason === 'Red flag delay');
  $('disableForceLive').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('Force Live restores the schedule window when disabled', snapshot.streamWindow.active === false);

  $('toggleMaintenance').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('maintenance button updates local dashboard state after save', snapshot.maintenance.active === true && $('maintenanceStatus').classList.contains('is-active'));

  $('overrideInput').value = 'https://youtu.be/abc123XYZ_0';
  $('overrideForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('stream override is an explicit admin POST', snapshot.streamOverride.active === true && calls.at(-1).pathname.endsWith('/stream/override'));

  $('newSourceName').value = 'Test feed'; $('newSourceUrl').value = 'https://example.com/player';
  $('addSourceForm').dispatchEvent(new window.Event('submit', { bubbles:true, cancelable:true }));
  check('custom source is added to the draft', [...$('sourceList').querySelectorAll('.source-name')].some(el => el.textContent.includes('Test feed')));
  $('saveSources').dispatchEvent(new window.MouseEvent('click', { bubbles:true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('custom source is published in an atomic catalogue update', snapshot.sources.custom?.some(source => source.label === 'Test feed'));
  check('news controls are absent', !$('newsSection') && !$('newsForm'));
  check('no runtime errors', runtimeErrors.length === 0, runtimeErrors.join(' | '));

  let failed = 0;
  for (const item of checks) {
    if (!item.pass) failed++;
    console.log(` ${item.pass ? ' ok ' : 'FAIL'}   ${item.label}${item.pass || !item.detail ? '' : `  →  ${item.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
