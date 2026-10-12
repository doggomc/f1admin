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
const runtimeErrors = [];
window.console = console;
window.Headers = global.Headers;
window.confirm = () => true;
window.scrollTo = () => {};
window.addEventListener('error', event => runtimeErrors.push(String(event.error || event.message)));

const FEED_SOURCES = [
  { id: 'westream', label: 'WeStream F1' }, { id: 'sky-uk', label: 'Sky UHD' },
  { id: 'f1tv', label: 'F1TV' }, { id: 'appletv', label: 'AppleTV' },
  { id: 'dazn', label: 'DAZN' }, { id: 'wikisport', label: 'WikiSport' }
];
let snapshot = {
  maintenance: { active: false, message: "We'll be back before the race.", eta: 'Before lights out', startedAt: null },
  news: [], sources: { disabled: [], updatedAt: null },
  streamOverride: { active: false, input: null, url: null, type: null, startedAt: null },
  streamWindow: { active: false, reason: '', startedAt: null, updatedAt: null },
  experimental: { enabled: true }, sourceList: FEED_SOURCES, adminNews: [],
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
  if (pathname.endsWith('/admin/api/news') && method === 'POST') {
    const body = calls.at(-1).body || {};
    const item = { ...body, id: 'news_test', createdAt: Date.now(), updatedAt: Date.now() };
    snapshot.adminNews.unshift(item);
    writePayloads.push({ endpoint: 'news', body });
    return reply({ success: true, news: item, durable: true }, 201);
  }
  if (pathname.endsWith('/admin/api/news/news_test') && method === 'PATCH') {
    return reply({ success: true, news: { ...calls.at(-1).body, id: 'news_test', createdAt: Date.now(), updatedAt: Date.now() }, durable: true });
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
  check('authenticated dashboard opens and hides the login panel', $('app').classList.contains('open') && $('authScreen').classList.contains('hidden'));
  check('initialization makes only status and one config request', calls.length === 2 && calls[0].pathname.endsWith('/status') && calls[1].pathname.endsWith('/config'), JSON.stringify(calls.map(call => call.pathname)));
  check('removed feeds are absent from source controls', !html.includes('sky-uk-2') && !html.includes('sky-sports-f1') &&
    ![...$('sourceList').querySelectorAll('.source-id')].some(el => /sky-uk-2|sky-sports-f1/.test(el.textContent)));
  check('no visitor, analytics, SSE, or recurring API request is made', calls.every(call => !/visitor|analytics|events|status\?/.test(call.pathname)));

  await new Promise(resolve => setTimeout(resolve, 120));
  check('idle dashboard does not poll or heartbeat', calls.length === 2, `${calls.length} request(s)`);

  const toggle = $('sourceList').querySelector('.source-switch');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  $('saveSources').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('source controls submit only the intentional admin change', writePayloads.some(item => item.endpoint === 'sources') && calls.at(-1).method === 'POST');

  $('forceLiveReason').value = 'Red flag delay';
  $('enableForceLive').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('Force Live can be enabled with an optional reason', snapshot.streamWindow.active === true && snapshot.streamWindow.reason === 'Red flag delay');
  $('disableForceLive').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('Force Live restores the schedule window when disabled', snapshot.streamWindow.active === false);

  $('toggleMaintenance').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('maintenance button updates local dashboard state after save', snapshot.maintenance.active === true && $('maintenanceBanner').classList.contains('active'));

  $('streamUrl').value = 'https://youtu.be/abc123XYZ_0';
  $('playOverride').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  check('stream override is an explicit admin POST', snapshot.streamOverride.active === true && calls.at(-1).pathname.endsWith('/stream/override'));

  $('newsHeadline').value = 'Test update';
  $('newsTag').value = 'Race Control';
  $('newsBody').value = 'A short update.';
  $('newsForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  check('news form posts sanitized text to the admin API', snapshot.adminNews[0]?.title === 'Test update' && writePayloads.some(item => item.endpoint === 'news'));
  check('no runtime errors', runtimeErrors.length === 0, runtimeErrors.join(' | '));

  let failed = 0;
  for (const item of checks) {
    if (!item.pass) failed++;
    console.log(` ${item.pass ? ' ok ' : 'FAIL'}   ${item.label}${item.pass || !item.detail ? '' : `  →  ${item.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
