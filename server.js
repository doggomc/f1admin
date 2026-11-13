'use strict';
const { createAutoResolver } = require('./auto-streams');
const { createRaceWeekend, resolveAutoStreams } = require('./race-weekend');
const raceWeekend = createRaceWeekend();
const autoResolver = createAutoResolver();

/* FreeF1 Race Control API
 * The public site is a static Netlify app. This Render process serves the
 * authenticated control panel, a small public configuration snapshot and
 * push-only config stream, plus an optional text-only Help-ticket API and
 * Discord bot. It does not proxy streams, sports data, or media, and it does
 * not collect visitor presence, page history, heartbeats, or analytics.
 */
const crypto = require('crypto');
const compression = require('compression');
const express = require('express');
const cookieSession = require('cookie-session');
const fs = require('fs');
const path = require('path');
const { HelpTicketService, HELP_CATEGORIES } = require('./support-tickets');

const app = express();
app.disable('x-powered-by');
let discordBot = null;

// One ephemeral response per visible public tab; no visitor identity or
// periodic heartbeat is recorded or sent.
const siteConfigStreams = new Set();

const PORT = Number(process.env.PORT) || 3000;
const CONTROL_ROLE = process.env.CONTROL_ROLE || 'standalone';
if (!['standalone', 'headquarters', 'replica'].includes(CONTROL_ROLE)) throw new Error('Invalid CONTROL_ROLE');
const HQ_CONTROL_KEY = 'freef1:headquarters:control:v1';
const HQ_TARGETS = CONTROL_ROLE === 'headquarters' ? require('./headquarters').readTargets(process.env.HQ_TARGETS) : [];
const HQ_PUSH_TARGETS = CONTROL_ROLE === 'headquarters' ? require('./headquarters').readPushTargets(process.env.HQ_PUSH_TARGETS, process.env.NODE_ENV === 'test') : [];
const HQ_PUSH_SECRET = String(process.env.HQ_PUSH_SECRET || '');
const HQ_URL = String(process.env.HQ_URL || '').trim().replace(/\/+$/, '');
const FORWARDABLE_ADMIN_PATHS = new Set(['/pages','/maintenance','/stream/window','/stream/override','/stream/stop','/stream/normal','/stream/auto','/stream/relays','/stream/sources','/stream/catalogue','/stream/sources/bulk','/stream/chip','/reset-all']);
let lastPushResults = null;
let replicaSyncTail = Promise.resolve();
let lastSharedSync = null;
let sharedInitialized = false;
let committedSharedSnapshot = null;
let adminWriteTail = Promise.resolve();
const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.REQUIRE_PRODUCTION_SECRETS === '1';
const SITE_URL = String(process.env.SITE_URL || 'https://freef1-live.vercel.app').replace(/\/+$/, '');
const ADMIN_USER = String(process.env.ADMIN_USER || (PRODUCTION ? '' : 'admin')).trim();
const ADMIN_PASS = String(process.env.ADMIN_PASS || (PRODUCTION ? '' : 'admin'));
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || (PRODUCTION ? '' : 'local-development-only-change-before-deploy'));
const ADMIN_PASS_MIN_LENGTH = Math.max(12, Number.parseInt(process.env.ADMIN_PASS_MIN_LENGTH || '12', 10) || 12);
const TRUST_PROXY_HOPS = Math.max(0, Math.min(4,
  Number.parseInt(process.env.TRUST_PROXY_HOPS || (PRODUCTION ? '1' : '0'), 10) || 0));
app.set('trust proxy', TRUST_PROXY_HOPS);

if (PRODUCTION) {
  const missing = [];
  if (!ADMIN_USER || /^(?:change-me|admin)$/i.test(ADMIN_USER)) missing.push('ADMIN_USER (replace the example value)');
  if (!ADMIN_PASS || ADMIN_PASS === 'admin' || /^(?:change-me|replace-with|use-a-long-random-password)/i.test(ADMIN_PASS) || ADMIN_PASS.length < ADMIN_PASS_MIN_LENGTH) missing.push(`ADMIN_PASS (minimum ${ADMIN_PASS_MIN_LENGTH} random characters)`);
  if (!ADMIN_SECRET || ADMIN_SECRET.length < 32 || /(?:change-me|replace-with|local-development-only)/i.test(ADMIN_SECRET)) missing.push('ADMIN_SECRET (at least 32 random characters)');
  if (missing.length) throw new Error(`Refusing to start with insecure production settings: ${missing.join(', ')}.`);
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_DIR = path.join(__dirname, 'admin');
const ASSETS_DIR = path.join(__dirname, 'assets');
const CONTROL_FILE = path.join(DATA_DIR, 'race-control.json');
const HELP_TICKETS_FILE = path.join(DATA_DIR, 'help-tickets.json');
const HELP_TICKETS_REDIS_KEY = 'freef1:help-tickets:v1';
const HELP_TICKETS_ENABLED = String(process.env.DISCORD_TICKETS_ENABLED || '').toLowerCase() === 'true';
const LEGACY_FILES = {
  maintenance: path.join(DATA_DIR, 'maintenance.json'),
  sources: path.join(DATA_DIR, 'stream-sources.json'),
  streamOverride: path.join(DATA_DIR, 'stream-override.json'),
  streamWindow: path.join(DATA_DIR, 'stream-window.json')
};
const CONTROL_REDIS_KEY = 'freef1:race-control:v1';
const LEGACY_REDIS_KEYS = {
  maintenance: 'freef1:maintenance:v1',
  sources: 'freef1:stream-sources:v1',
  streamOverride: 'freef1:stream-override:v1',
  streamWindow: process.env.STREAM_WINDOW_REDIS_KEY || 'freef1:stream-window:v1'
};
const UPSTASH_URL = cleanEnv('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL').replace(/\/+$/, '');
const UPSTASH_TOKEN = cleanEnv('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN');
const UPSTASH_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const HQ_UPSTASH_URL = cleanEnv('HQ_UPSTASH_REDIS_REST_URL', '').replace(/\/+$/, '');
const HQ_UPSTASH_TOKEN = cleanEnv('HQ_UPSTASH_REDIS_REST_TOKEN', '');
if (CONTROL_ROLE !== 'standalone' && (!HQ_UPSTASH_URL || !HQ_UPSTASH_TOKEN)) throw new Error('Headquarters and replica modes require HQ_UPSTASH_REDIS_REST_URL and HQ_UPSTASH_REDIS_REST_TOKEN');
if (CONTROL_ROLE !== 'standalone' && (!HQ_PUSH_SECRET || (PRODUCTION && HQ_PUSH_SECRET.length < 32))) throw new Error('HQ_PUSH_SECRET is required (at least 32 characters in production)');
if (CONTROL_ROLE === 'replica' && HQ_URL) {
  let url; try { url = new URL(HQ_URL); } catch { throw new Error('Invalid HQ_URL'); }
  const localTest = process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || localTest) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('HQ_URL must be an HTTPS origin');
}
if (CONTROL_ROLE !== 'standalone' && PRODUCTION) {
  let url; try { url = new URL(HQ_UPSTASH_URL); } catch { throw new Error('Invalid shared Upstash URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Shared Upstash URL must be an HTTPS origin');
}
async function sharedStoreRequest(command) {
  const response = await fetch(HQ_UPSTASH_URL, { method: 'POST', headers: { authorization: `Bearer ${HQ_UPSTASH_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000), cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`Shared store HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error('Shared store command failed');
  return payload;
}
const DEFAULT_ALLOWED_ORIGINS = PRODUCTION
  ? 'https://freef1.netlify.app,https://freef1-live.vercel.app'
  : 'https://freef1.netlify.app,https://freef1-live.vercel.app,http://localhost:4173,http://127.0.0.1:4173';
const ALLOWED_ORIGINS = new Set(parseOrigins(process.env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGINS));
// Vercel assigns a fresh hostname to each deployment. The team suffix is
// required; frame-ancestors is generated per request from the approved referrer.
const RELAY_LIVE_ORIGIN = 'https://freef1-live.vercel.app';
const RELAY_EXTRA_ORIGINS = new Set(parseOrigins(process.env.RELAY_ALLOWED_ORIGINS || ''));
const RELAY_PREVIEW = /^https:\/\/freef1-[a-z0-9-]+-f4-ac7f\.vercel\.app$/;
function isRelayOrigin(origin) {
  return origin === RELAY_LIVE_ORIGIN || RELAY_PREVIEW.test(origin) || RELAY_EXTRA_ORIGINS.has(origin)
    || (!PRODUCTION && /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|https:\/\/[a-z0-9-]+\.e2b\.app)$/i.test(origin));
}

const SITE_CONFIG_MAX_AGE_SECONDS = 300;
const ADMIN_IP_ALLOWLIST = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(value => value.trim()).filter(Boolean);
const LEGACY_REMOTE_KEYS_TO_DELETE = [
  process.env.UNIQUE_VISITOR_REDIS_KEY || 'freef1:unique-visitors:v1',
  process.env.ANALYTICS_REDIS_KEY || 'freef1:analytics:v1',
  process.env.LOGIN_GUARD_REDIS_KEY || 'freef1:login-guard:v1',
  process.env.STREAM_TARGETS_REDIS_KEY || 'freef1:stream-targets:v1'
];
const LEGACY_LOCAL_FILES_TO_DELETE = ['unique-visitors.json', 'analytics.json', 'login-guard.json', 'stream-targets.json'];

/* The player list the Race Control panel renders. It is read from the resolver's STREAM_SOURCES —
   the same list the player draws and GET /api/stream/sources publishes — so the admin, the API and
   the site can never drift apart. Add a source there and it appears here, in the player and in
   "which sources are live" without a second edit. */
function staticChipUrl(source) {
  if (source.weelo) {
    return source.stripped
      ? `/api/stream/weellz-embed?stream=${source.weelo}`
      : `https://weellz.live/beta?stream=${source.weelo}`;
  }
  const first = (source.links || []).find((entry) => entry && entry.url && !(source.provider === 'wikisport' && entry.addressing === 'dynamic'));
  return first?.url || '';
}

const FEED_SOURCES = require('./stream-resolver').STREAM_SOURCES.map((source) => ({
  id: source.id,
  label: source.label,
  provider: source.provider,
  defaultUrl: staticChipUrl(source),
  ...(source.main ? { main: true } : {}),
  /* Carried so Race Control can group rows (all EMB, all weelo, all taifood …) without parsing ids. */
  tab: source.tab || 'en',
  ...(source.lang ? { lang: source.lang } : {}),
  ...(source.special ? { special: source.special } : {}),
  ...(source.stripped ? { stripped: true } : {})
}));
const FEED_SOURCE_IDS = new Set(FEED_SOURCES.map(source => source.id));

const CONTROLLABLE_PAGES = Object.freeze([
  Object.freeze({ id: 'cockpit', label: 'Cockpit', path: '/cockpit.html', description: 'Live stream player, sources & multiviewer' }),
  Object.freeze({ id: 'schedule', label: 'Schedule', path: '/schedule.html', description: 'Season calendar & weekend session times' }),
  Object.freeze({ id: 'standings', label: 'Standings', path: '/standings.html', description: 'Drivers & Constructors championships' }),
  Object.freeze({ id: 'live-timing', label: 'Live timing', path: '/live-timing.html', description: 'Timing tower, sectors, race control & radio' }),
  Object.freeze({ id: 'drivers', label: 'Drivers', path: '/drivers.html', description: 'Driver grid & individual driver profiles' }),
  Object.freeze({ id: 'teams', label: 'Teams', path: '/teams.html', description: 'Constructor grid & team profiles' }),
  Object.freeze({ id: 'other', label: 'Other', path: '/other.html', description: 'Other section hub' }),
  Object.freeze({ id: 'replays', label: 'Replays', path: '/replays.html', description: 'Replay directory & replay player' }),
  Object.freeze({ id: 'other-streams', label: 'Other streams', path: '/other-streams.html', description: 'Other streams directory & private player' }),
  Object.freeze({ id: 'help', label: 'Help', path: '/help.html', description: 'Support desk & help tickets' })
]);
const CONTROLLABLE_PAGE_IDS = new Set(CONTROLLABLE_PAGES.map(page => page.id));

const DEFAULT_MAINTENANCE = Object.freeze({
  active: false,
  message: "We'll be back before the race.",
  eta: 'Before lights out',
  startedAt: null,
  updatedAt: null
});

const state = {
  maintenance: { ...DEFAULT_MAINTENANCE },
  pages: { disabled: [], updatedAt: null },
  sources: { disabled: [], removed: [], overrides: {}, custom: [], order: [], updatedAt: null },
  streamOverride: { active: false, input: null, url: null, type: null, startedAt: null, updatedAt: null },
  streamWindow: { active: false, reason: '', startedAt: null, updatedAt: null },
  experimental: { enabled: true },
  failover: { active: false, updatedAt: null }
};

let fileStoreReady = false;
let redisReady = false;
let lastStateWrite = { durable: false, store: 'memory' };

function cleanEnv(primary, fallback) {
  const raw = process.env[primary] || process.env[fallback] || '';
  return String(raw).trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

function parseOrigins(value) {
  return String(value || '').split(',').map(normalizeOrigin).filter(Boolean);
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isPublicSiteOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Production + mirror Netlify/Vercel projects and their deploy previews.
  if (/^https:\/\/(?:[a-z0-9-]+--)?freef[1-9]\.netlify\.app$/i.test(origin)) return true;
  if (/^https:\/\/(?:free-?f[1-9]|vercel-?f[1-9]|netlify-?f[1-9])(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin)) return true;
  if (!PRODUCTION && /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|https:\/\/[a-z0-9-]+\.e2b\.app)$/i.test(origin)) {
    return true;
  }
  return false;
}

function selfOrigin(req) {
  return normalizeOrigin(`${req.protocol}://${req.get('host') || ''}`);
}

function isSafeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left == null ? '' : left)).digest();
  const b = crypto.createHash('sha256').update(String(right == null ? '' : right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function safeText(value, maxLength, { lines = false } = {}) {
  let text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  if (lines) text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  else text = text.replace(/\s+/g, ' ');
  return text.trim().slice(0, maxLength).trim();
}

function normalizeMaintenance(raw = {}) {
  const active = raw.active === true;
  const message = safeText(raw.message, 180) || DEFAULT_MAINTENANCE.message;
  const eta = safeText(raw.eta, 60) || DEFAULT_MAINTENANCE.eta;
  const startedAt = active ? (Number(raw.startedAt) || Date.now()) : null;
  const updatedAt = Number(raw.updatedAt) || Date.now();
  return { active, message, eta, startedAt, updatedAt };
}

/* Chip overrides: a label, a custom link, or both, keyed by source id. Ids that no longer exist are
   dropped, so a retired chip cannot keep a ghost name. */
const OVERRIDE_TEXT = 40;
function normalizeOverrides(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!FEED_SOURCE_IDS.has(id) || !value || typeof value !== 'object') continue;
    const entry = {};
    const label = safeText(value.label, OVERRIDE_TEXT);
    if (label) entry.label = label;
    const url = httpsUrl(value.url);
    if (url) entry.url = url.href.slice(0, 500);
    if (entry.label || entry.url) out[id] = { ...entry, updatedAt: Number(value.updatedAt) || Date.now() };
  }
  return out;
}

function normalizeSources(raw = {}, { migrateWiki = false } = {}) {
  const custom = [];
  const customIds = new Set();
  for (const item of Array.isArray(raw.custom) ? raw.custom.slice(0, 50) : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '');
    const label = safeText(item.label, 40);
    const url = httpsUrl(item.url);
    if (!/^custom-[a-z0-9-]{1,60}$/.test(id) || customIds.has(id) || FEED_SOURCE_IDS.has(id) || !label || !url) continue;
    customIds.add(id);
    custom.push({ id, label, url: url.href.slice(0, 500), tab: item.tab === 'other' ? 'other' : 'en' });
  }
  const ids = new Set([...FEED_SOURCE_IDS, ...customIds]);
  const disabled = Array.isArray(raw.disabled) ? raw.disabled.map(String).filter(id => ids.has(id)) : [];
  const removed = Array.isArray(raw.removed) ? raw.removed.map(String).filter(id => FEED_SOURCE_IDS.has(id)) : [];
  /* Preserve the previous WikiSport visibility/removal when upgrading to separate feeds. */
  if (migrateWiki && raw.wikiSplitVersion !== 1) {
    const additions = [2, 3, 4, 5].map(n => `wikisport-${n}`);
    if (disabled.includes('wikisport')) disabled.push(...additions);
    if (removed.includes('wikisport')) removed.push(...additions);
  }
  const order = Array.isArray(raw.order) ? raw.order.map(String).filter(id => ids.has(id)) : [];
  return { wikiSplitVersion: 1, autoStreams: raw.autoStreams === true, relaysDisabled: raw.relaysDisabled === true, disabled: [...new Set(disabled)], removed: [...new Set(removed)], overrides: normalizeOverrides(raw.overrides), custom, order: [...new Set(order)], updatedAt: Number(raw.updatedAt) || null };
}

function normalizePages(raw = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.disabled) ? raw.disabled : [];
  const disabled = list.map(id => String(id).trim().toLowerCase()).filter(id => CONTROLLABLE_PAGE_IDS.has(id));
  return { disabled: [...new Set(disabled)], updatedAt: Number(raw?.updatedAt) || null };
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function classifyStreamUrl(value) {
  const original = String(value || '').trim().slice(0, 2000);
  const parsed = httpsUrl(original);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0] || '';
  else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (parsed.pathname === '/watch') id = parsed.searchParams.get('v') || '';
    else id = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
  }
  if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    return {
      input: original,
      url: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`,
      type: 'youtube'
    };
  }
  const extension = parsed.pathname.toLowerCase().split('.').pop();
  return { input: original, url: parsed.href, type: extension === 'mp4' ? 'mp4' : extension === 'webm' ? 'webm' : 'embed' };
}

function normalizeOverride(raw = {}) {
  const parsed = raw.url ? classifyStreamUrl(raw.input || raw.url) : null;
  const active = raw.active === true && Boolean(parsed || httpsUrl(raw.url));
  let input = null, url = null, type = null;
  if (parsed) ({ input, url, type } = parsed);
  else if (httpsUrl(raw.url)) {
    input = safeText(raw.input || raw.url, 2000);
    url = httpsUrl(raw.url).href;
    type = ['youtube', 'mp4', 'webm', 'embed'].includes(raw.type) ? raw.type : 'embed';
  }
  return {
    active,
    input,
    url,
    type,
    startedAt: active ? (Number(raw.startedAt) || Date.now()) : null,
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

function normalizeStreamWindow(raw = {}) {
  const active = raw.active === true;
  return {
    active,
    reason: active ? safeText(raw.reason, 120) : '',
    startedAt: active ? (Number(raw.startedAt) || Date.now()) : null,
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

function normalizeExperimental(raw) {
  if (typeof raw === 'boolean') return { enabled: raw };
  return { enabled: raw?.enabled !== false };
}

function applySnapshot(raw) {
  if (!raw || typeof raw !== 'object') return;
  if (raw.maintenance) state.maintenance = normalizeMaintenance(raw.maintenance);
  if (raw.pages) state.pages = normalizePages(raw.pages);
  if (raw.sources) state.sources = normalizeSources(raw.sources, { migrateWiki: true });
  if (raw.streamOverride || raw.override) state.streamOverride = normalizeOverride(raw.streamOverride || raw.override);
  if (raw.streamWindow) state.streamWindow = normalizeStreamWindow(raw.streamWindow);
  if (raw.experimental !== undefined) state.experimental = normalizeExperimental(raw.experimental);
  state.failover = { active: raw.failover?.active === true, updatedAt: Number(raw.failover?.updatedAt) || null };
}

function currentSnapshot() {
  return {
    maintenance: state.maintenance,
    pages: state.pages,
    sources: state.sources,
    streamOverride: state.streamOverride,
    streamWindow: state.streamWindow,
    experimental: state.experimental,
    failover: state.failover
  };
}

function initializeFileStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    fileStoreReady = true;
    for (const name of LEGACY_LOCAL_FILES_TO_DELETE) {
      try { fs.rmSync(path.join(DATA_DIR, name), { force: true }); } catch (_) {}
    }
  } catch (error) {
    fileStoreReady = false;
    console.warn(`[Storage] Local state is unavailable: ${error.message}`);
  }
}

function readLocalJson(filePath) {
  if (!fileStoreReady) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[Storage] Could not read ${path.basename(filePath)}: ${error.message}`);
    return null;
  }
}

function writeLocalJson(filePath, value) {
  if (!fileStoreReady) return false;
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    console.warn(`[Storage] Could not write ${path.basename(filePath)}: ${error.message}`);
    return false;
  }
}

initializeFileStore();

async function upstashRequest(commands, timeoutMs = 5000) {
  if (!UPSTASH_ENABLED) throw new Error('Upstash is not configured');
  const pipeline = Array.isArray(commands[0]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${UPSTASH_URL}${pipeline ? '/pipeline' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error);
    if (Array.isArray(payload)) {
      const failed = payload.find(item => item?.error);
      if (failed) throw new Error(failed.error);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function parseRedisJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return null; }
}

const HELP_RATE_LIMIT_SECRET = crypto.randomBytes(32);
let helpStorageReady = false;
let helpStorageMode = 'unavailable';
async function loadHelpTicketState() {
  const explicitDisk = Boolean(String(process.env.DATA_DIR || '').trim());
  if (UPSTASH_ENABLED) {
    try {
      const reply = await upstashRequest(['GET', HELP_TICKETS_REDIS_KEY], 8000);
      helpStorageReady = true;
      helpStorageMode = 'upstash';
      return parseRedisJson(reply?.result);
    } catch (error) {
      console.warn(`[Help] Upstash ticket read failed: ${error.message}`);
    }
  }
  if (fileStoreReady && (!PRODUCTION || explicitDisk)) {
    helpStorageReady = true;
    helpStorageMode = explicitDisk ? 'persistent-disk' : 'local';
    return readLocalJson(HELP_TICKETS_FILE);
  }
  helpStorageReady = false;
  helpStorageMode = 'unavailable';
  return null;
}

async function saveHelpTicketState(value) {
  const explicitDisk = Boolean(String(process.env.DATA_DIR || '').trim());
  if (UPSTASH_ENABLED && helpStorageMode === 'upstash') {
    try {
      const reply = await upstashRequest(['SET', HELP_TICKETS_REDIS_KEY, JSON.stringify(value)], 8000);
      if (reply?.result !== 'OK') throw new Error('Upstash did not confirm ticket save');
      helpStorageReady = true;
      return true;
    } catch (error) {
      console.warn(`[Help] Upstash ticket save failed: ${error.message}`);
      if (PRODUCTION && !explicitDisk) {
        helpStorageReady = false;
        helpStorageMode = 'unavailable';
        return false;
      }
    }
  }
  if (fileStoreReady && (!PRODUCTION || explicitDisk)) {
    const saved = writeLocalJson(HELP_TICKETS_FILE, value);
    if (saved) {
      helpStorageReady = true;
      helpStorageMode = explicitDisk ? 'persistent-disk' : 'local';
      return true;
    }
  }
  helpStorageReady = false;
  helpStorageMode = 'unavailable';
  return false;
}

const helpTicketService = new HelpTicketService({
  loadState: loadHelpTicketState,
  saveState: saveHelpTicketState,
  getBot: () => discordBot,
  storageReady: () => helpStorageReady,
  log: (...args) => console.warn('[Help]', ...args),
});

function helpTokenFromRequest(req) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(String(req.get('authorization') || '').trim());
  return match ? match[1] : '';
}

function helpRateKey(req) {
  const ip = sanitizeIp(req.ip || req.socket.remoteAddress || 'unknown');
  return crypto.createHmac('sha256', HELP_RATE_LIMIT_SECRET).update(ip).digest('hex');
}

function sendHelpError(res, error) {
  const status = Number(error?.status) || 500;
  if (Number(error?.retryAfter) > 0) res.setHeader('Retry-After', String(Number(error.retryAfter)));
  if (status >= 500 && status !== 503) console.warn('[Help] request failed:', error?.message || error);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error: status === 500 ? 'The support request failed. Please try again.' : String(error?.message || 'The support request could not be completed.').slice(0, 240) });
}

function applyLegacyLocalState() {
  const maintenance = readLocalJson(LEGACY_FILES.maintenance);
  const sources = readLocalJson(LEGACY_FILES.sources);
  const streamOverride = readLocalJson(LEGACY_FILES.streamOverride);
  const streamWindow = readLocalJson(LEGACY_FILES.streamWindow);
  if (maintenance) state.maintenance = normalizeMaintenance(maintenance);
  if (sources) state.sources = normalizeSources(sources, { migrateWiki: true });
  if (streamOverride) state.streamOverride = normalizeOverride(streamOverride);
  if (streamWindow) state.streamWindow = normalizeStreamWindow(streamWindow);
}

async function loadSiteState() {
  const localSnapshot = readLocalJson(CONTROL_FILE);
  if (localSnapshot) {
    applySnapshot(localSnapshot);
    if (localSnapshot.streamWindow === undefined) {
      const legacyStreamWindow = readLocalJson(LEGACY_FILES.streamWindow);
      if (legacyStreamWindow) state.streamWindow = normalizeStreamWindow(legacyStreamWindow);
    }
  } else applyLegacyLocalState();

  if (!UPSTASH_ENABLED) {
    const sanitizedLocal = !localSnapshot || !Object.hasOwn(localSnapshot, 'news') || writeLocalJson(CONTROL_FILE, currentSnapshot());
    if (sanitizedLocal) { try { fs.rmSync(path.join(DATA_DIR, 'news.json'), { force: true }); } catch (_) {} }
    lastStateWrite = { durable: false, store: fileStoreReady ? 'local' : 'memory' };
    return false;
  }

  const redisKeys = [
    CONTROL_REDIS_KEY,
    LEGACY_REDIS_KEYS.maintenance,
    'freef1:news:v1', // read only to migrate and permanently delete the retired module's data
    LEGACY_REDIS_KEYS.sources,
    LEGACY_REDIS_KEYS.streamOverride,
    LEGACY_REDIS_KEYS.streamWindow
  ];
  const commands = redisKeys.map(key => ['GET', key]);
  // Remove retired telemetry/visitor data and obsolete stream-proxy settings.
  // The legacy Force Live setting is read above and preserved in the snapshot.
  // This is one bounded Upstash pipeline at startup, never per user.
  for (const key of new Set(LEGACY_REMOTE_KEYS_TO_DELETE)) commands.push(['DEL', key]);
  try {
    const replies = await upstashRequest(commands, 10_000);
    const values = Array.isArray(replies) ? replies.slice(0, redisKeys.length).map(item => parseRedisJson(item?.result)) : [];
    if (values[0]) {
      applySnapshot(values[0]);
      if (values[0].streamWindow === undefined && values[5]) state.streamWindow = normalizeStreamWindow(values[5]);
    } else {
      if (values[1]) state.maintenance = normalizeMaintenance(values[1]);
      if (values[3]) state.sources = normalizeSources(values[3], { migrateWiki: true });
      if (values[4]) state.streamOverride = normalizeOverride(values[4]);
      if (values[5]) state.streamWindow = normalizeStreamWindow(values[5]);
    }
    // First persist the sanitized combined state, then delete the legacy key. Never delete
    // the old data before the replacement snapshot is safely acknowledged.
    if ((values[0] && Object.hasOwn(values[0], 'news')) || values[2]) {
      const saved = await upstashRequest(['SET', CONTROL_REDIS_KEY, JSON.stringify(currentSnapshot())]);
      if (saved?.result !== 'OK') throw new Error('News cleanup snapshot was not saved');
    }
    const deleted = await upstashRequest(['DEL', 'freef1:news:v1']);
    if (deleted?.error) throw new Error('Could not delete retired News key');
    const sanitizedLocal = !localSnapshot || !Object.hasOwn(localSnapshot, 'news') || writeLocalJson(CONTROL_FILE, currentSnapshot());
    if (sanitizedLocal) { try { fs.rmSync(path.join(DATA_DIR, 'news.json'), { force: true }); } catch (_) {} }
    redisReady = true;
    lastStateWrite = { durable: true, store: 'upstash' };
    return true;
  } catch (error) {
    redisReady = false;
    console.warn(`[Storage] Upstash read failed; using local/default state. ${error.message}`);
    lastStateWrite = { durable: false, store: fileStoreReady ? 'local' : 'memory' };
    return false;
  }
}

async function syncSharedState({ initialize = false } = {}) {
  try {
    let reply = await sharedStoreRequest(['GET', HQ_CONTROL_KEY]);
    let snapshot = parseRedisJson(reply?.result);
    if (!snapshot && initialize) {
      // NX prevents an accidental second Headquarters from replacing existing state.
      await sharedStoreRequest(['SET', HQ_CONTROL_KEY, JSON.stringify(currentSnapshot()), 'NX']);
      reply = await sharedStoreRequest(['GET', HQ_CONTROL_KEY]);
      snapshot = parseRedisJson(reply?.result);
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !snapshot.sources || !snapshot.pages || !snapshot.maintenance) throw new Error('Shared control snapshot is missing or invalid');
    const before = JSON.stringify(currentSnapshot());
    applySnapshot(snapshot);
    committedSharedSnapshot = JSON.parse(JSON.stringify(currentSnapshot()));
    sharedInitialized = true;
    redisReady = true;
    lastSharedSync = Date.now();
    lastStateWrite = { durable: true, store: 'upstash' };
    writeLocalJson(CONTROL_FILE, currentSnapshot());
    if (JSON.stringify(currentSnapshot()) !== before) broadcastSiteConfig();
    return true;
  } catch (error) {
    redisReady = false;
    console.warn('[Headquarters] Shared state unavailable; retaining last confirmed settings:', error.message);
    return false;
  }
}
async function loadSharedState() {
  const local = readLocalJson(CONTROL_FILE);
  if (local) applySnapshot(local);
  committedSharedSnapshot = JSON.parse(JSON.stringify(currentSnapshot()));
  await syncSharedState({ initialize: CONTROL_ROLE === 'headquarters' && process.env.HQ_INITIALIZE === 'true' });
}

let persistQueue = Promise.resolve();
function persistState() {
  const snapshot = currentSnapshot();
  if (CONTROL_ROLE === 'headquarters') {
    return (async () => {
      if (!sharedInitialized) { if (committedSharedSnapshot) applySnapshot(committedSharedSnapshot); return { error: 'Shared settings not initialized; restart Headquarters after storage is available.' }; }
      try {
        const reply = await sharedStoreRequest(['SET', HQ_CONTROL_KEY, JSON.stringify(snapshot)]);
        if (reply?.result !== 'OK') throw new Error('Shared store did not acknowledge write');
        committedSharedSnapshot = JSON.parse(JSON.stringify(snapshot));
        redisReady = true; lastSharedSync = Date.now();
        writeLocalJson(CONTROL_FILE, snapshot);
        lastStateWrite = { durable: true, store: 'upstash' };
        broadcastSiteConfig();
        // A successful save and a successful delivery are distinct outcomes.
        lastPushResults = await require('./headquarters').pushUpdates(HQ_PUSH_TARGETS, HQ_PUSH_SECRET);
        return { durable: true, store: 'upstash', localSaved: fileStoreReady, delivery: lastPushResults };
      } catch (error) {
        if (committedSharedSnapshot) applySnapshot(committedSharedSnapshot);
        redisReady = false; sharedInitialized = false;
        console.warn('[Headquarters] Shared write failed:', error.message);
        return { error: 'Could not save shared settings. No change was confirmed.' };
      }
    })();
  }
  // Publish the compact public snapshot immediately; storage durability work
  // continues independently and does not delay already-open public tabs.
  broadcastSiteConfig();
  const write = async () => {
    const localSaved = writeLocalJson(CONTROL_FILE, snapshot);
    let remoteSaved = false;
    if (UPSTASH_ENABLED) {
      try {
        const reply = await upstashRequest(['SET', CONTROL_REDIS_KEY, JSON.stringify(snapshot)]);
        if (reply?.result !== 'OK') throw new Error('Upstash did not confirm the write');
        remoteSaved = true;
        redisReady = true;
      } catch (error) {
        redisReady = false;
        console.warn(`[Storage] Upstash write failed; local fallback ${localSaved ? 'saved' : 'unavailable'}. ${error.message}`);
      }
    }
    lastStateWrite = {
      durable: remoteSaved,
      store: remoteSaved ? 'upstash' : localSaved ? 'local' : 'memory'
    };
    return { durable: remoteSaved, store: lastStateWrite.store, localSaved };
  };
  const pending = persistQueue.then(write, write);
  persistQueue = pending.catch(() => {});
  return pending;
}

function storageSummary() {
  return {
    store: lastStateWrite.store,
    durable: Boolean(lastStateWrite.durable),
    redisConfigured: CONTROL_ROLE === 'standalone' ? UPSTASH_ENABLED : Boolean(HQ_UPSTASH_URL && HQ_UPSTASH_TOKEN),
    localWritable: fileStoreReady
  };
}

const RETIRED_COMPAT_SOURCE_IDS = new Set(['sky-uhd']);

function adminSourcesState() {
  return { ...state.sources, disabled: [...state.sources.disabled] };
}

function publicSources() {
  /* Keep retired 'sky-uhd' listed in public disabled so already-deployed clients hide it cleanly. */
  return { ...state.sources, disabled: [...new Set([...state.sources.disabled, ...state.sources.removed, ...RETIRED_COMPAT_SOURCE_IDS])] };
}

/* Race Control sees the chip as a visitor will: the custom name and link when there is one. */
function adminSourceList() {
  const builtins = FEED_SOURCES.filter(source => !state.sources.removed.includes(source.id)).map((source) => {
    const custom = state.sources.overrides[source.id] || {};
    return { ...source, label: custom.label || source.label, baseLabel: source.label,
      customLabel: custom.label || '', customUrl: custom.url || '', updatedAt: custom.updatedAt || null };
  });
  const custom = state.sources.custom.map(source => ({ ...source, provider: 'custom', isCustom: true, baseLabel: source.label, customLabel: source.label, customUrl: source.url, defaultUrl: source.url }));
  const rank = new Map(state.sources.order.map((id, index) => [id, index]));
  return [...builtins, ...custom].sort((a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6));
}

function publicOverride() {
  return {
    active: Boolean(state.streamOverride.active && state.streamOverride.url),
    url: state.streamOverride.active ? state.streamOverride.url : null,
    type: state.streamOverride.active ? state.streamOverride.type : null,
    startedAt: state.streamOverride.startedAt,
    updatedAt: state.streamOverride.updatedAt
  };
}

function publicPages() {
  return { disabled: [...state.pages.disabled], updatedAt: state.pages.updatedAt };
}

function publicConfig() {
  return {
    maintenance: state.maintenance,
    pages: publicPages(),
    sources: publicSources(),
    streamOverride: publicOverride(),
    streamWindow: state.streamWindow,
    experimental: state.experimental,
    failover: state.failover
  };
}

function sendSiteConfigEvent(response, config = publicConfig()) {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`event: config\ndata: ${JSON.stringify(config)}\n\n`);
    response.flush?.();
    return true;
  } catch (_) {
    siteConfigStreams.delete(response);
    return false;
  }
}

function broadcastSiteConfig() {
  if (!siteConfigStreams.size) return;
  const config = publicConfig();
  for (const response of siteConfigStreams) {
    if (!sendSiteConfigEvent(response, config)) siteConfigStreams.delete(response);
  }
}

function sanitizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/i, '').trim();
}

function ipv4ToInt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  let number = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    number = (number << 8) | byte;
  }
  return number >>> 0;
}

function adminIpAllowed(ip) {
  if (!ADMIN_IP_ALLOWLIST.length) return true;
  const address = ipv4ToInt(sanitizeIp(ip));
  if (address === null) return false;
  return ADMIN_IP_ALLOWLIST.some(entry => {
    if (!entry.includes('/')) return sanitizeIp(entry) === sanitizeIp(ip);
    const [range, bitsText] = entry.split('/');
    const network = ipv4ToInt(range);
    const bits = Number(bitsText);
    if (network === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (address & mask) === (network & mask);
  });
}

// Security headers are deliberately small; the Render process no longer
// serves or frames the main public site.
app.use(compression({
  threshold: 512,
  filter: (req, res) => {
    const type = String(res.getHeader('Content-Type') || '');
    if (/mpegurl/i.test(type)) return true;
    return compression.filter(req, res);
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src https:",
    "frame-ancestors 'self'",
    "media-src 'self' data: https:",
    "form-action 'self'"
  ].join('; '));
  if (PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/admin/api') || req.path === '/healthz') res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  const rawOrigin = String(req.headers.origin || '').trim();
  const origin = normalizeOrigin(rawOrigin);
  const own = selfOrigin(req);
  const isWeellzRelay = req.path === '/api/stream/weellz-embed' || req.path.startsWith('/api/stream/weellz-key/');
  const isStrippedEmbedRelay = isWeellzRelay
    || req.path === '/api/stream/embdlol-embed'
    || req.path === '/api/stream/strmfree-embed'
    || req.path.startsWith('/api/stream/strmfree-m3u8/')
    || req.path === '/api/stream/ppv-embed'
    || req.path.startsWith('/api/stream/ppv-m3u8/');
  res.setHeader('Vary', 'Origin');
  if (origin && origin !== own && !(isStrippedEmbedRelay ? isRelayOrigin(origin) : isPublicSiteOrigin(origin))) return res.status(403).json({ error: 'Forbidden origin' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.path.startsWith('/api/stream/') ? 'Content-Type, Authorization, X-FreeF1-Client' : 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', isWeellzRelay ? 'Date, Retry-After' : 'Retry-After');
    // Browsers can reuse approved stream preflights; each actual request is
    // still checked against the current origin and client policy.
    if (req.method === 'OPTIONS' && req.path.startsWith('/api/stream/')) res.setHeader('Access-Control-Max-Age', '600');
  } else if (rawOrigin === 'null' && isStrippedEmbedRelay) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', isWeellzRelay ? 'Date, Retry-After' : 'Retry-After');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '40kb' }));
app.use('/admin/api/login', express.urlencoded({ extended: false, limit: '8kb' }));
app.use('/admin', (req, res, next) => {
  if (adminIpAllowed(req.ip || req.socket.remoteAddress)) return next();
  return res.status(404).end();
});
const sessionMiddleware = cookieSession({
  name: 'f1admin.sid',
  keys: [ADMIN_SECRET],
  httpOnly: true,
  sameSite: 'strict',
  secure: PRODUCTION,
  maxAge: 8 * 60 * 60 * 1000
});
app.use('/admin/api', sessionMiddleware);

let stateReady = CONTROL_ROLE === 'standalone' ? loadSiteState() : loadSharedState();
// Headquarters never exposes an unconfirmed in-flight mutation via public APIs.
app.use((req, _res, next) => {
  if (CONTROL_ROLE !== 'headquarters' || req.path.startsWith('/admin') || req.path === '/healthz') return next();
  adminWriteTail.then(next, next);
});

// Incoming authenticated notifications trigger a single shared-store read; no polling.
app.post('/internal/headquarters/sync', async (req, res) => {
  if (CONTROL_ROLE !== 'replica') return res.status(404).end();
  const auth = String(req.headers.authorization || '');
  if (!isSafeEqual(auth, `Bearer ${HQ_PUSH_SECRET}`)) return res.status(401).json({ error: 'Unauthorized' });
  await stateReady;
  const pending = replicaSyncTail.then(() => syncSharedState());
  replicaSyncTail = pending.catch(() => false);
  const ok = await pending;
  res.setHeader('Cache-Control', 'no-store');
  return ok ? res.json({ ok: true }) : res.status(503).json({ error: 'Shared state unavailable; last confirmed state retained.' });
});

// Block all stripped-player documents, playlist relays and key relays before
// any resolver or upstream fetch. Metadata and direct embeds remain available.
const RELAY_PATH = /^\/api\/stream\/(?:weellz-embed\/?|weellz-key(?:\/|$)|embdlol-embed\/?|strmfree-embed\/?|strmfree-m3u8(?:\/|$)|ppv-embed\/?|ppv-m3u8(?:\/|$))/i;
app.use(async (req, res, next) => {
  if (!RELAY_PATH.test(req.path)) return next();
  await stateReady;
  if (!state.sources.relaysDisabled) return next();
  setNoStore(res);
  res.setHeader('Netlify-CDN-Cache-Control', 'no-store');
  return res.status(503).json({ error: 'Stream relays are disabled by Race Control.', code: 'relays-disabled' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* 4K feed resolver — public, no Discord membership required. The site asks for the
   address and plays it; joining the Discord is an optional nudge in the UI. */
const streamResolver = require('./stream-resolver').createStreamResolver();
const { singleFlight } = require('./single-flight');
// Prevent a cold catalogue refresh from fanning out to the provider once per
// concurrent visitor. No result is cached here; existing resolver TTLs apply.
const getWeeloState = singleFlight(() => streamResolver.weeloState());
const getTaifoodChannels = singleFlight(() => streamResolver.taifoodChannels());
const getEmbdlolChannels = singleFlight(() => streamResolver.embdlolPublicChannels());

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Netlify-CDN-Cache-Control', 'no-store');
}

function setNetlifyEdgeCache(res, sMaxAge, { swr = 0, varyQuery = null, varyHeader = null } = {}) {
  const directives = [`public`, `s-maxage=${sMaxAge}`];
  if (swr > 0) directives.push(`stale-while-revalidate=${swr}`);
  res.setHeader('Netlify-CDN-Cache-Control', directives.join(', '));
  const varyParts = [];
  if (typeof varyQuery === 'string' && varyQuery) varyParts.push(`query=${varyQuery}`);
  if (typeof varyHeader === 'string' && varyHeader) varyParts.push(`header=${varyHeader}`);
  if (varyParts.length) res.setHeader('Netlify-Vary', varyParts.join(','));
}

function matchesIfNoneMatch(req, etag) {
  const inm = String(req.headers['if-none-match'] || '').trim();
  if (!inm || !etag) return false;
  if (inm === '*') return true;
  const cleanTarget = etag.replace(/^W\//, '');
  return inm.split(',').some((part) => part.trim().replace(/^W\//, '') === cleanTarget);
}

function sendPacked(req, res, pack, contentType) {
  if (!pack) return false;
  res.setHeader('ETag', pack.etag);
  res.append('Vary', 'Accept-Encoding');
  if (matchesIfNoneMatch(req, pack.etag)) {
    res.status(304).end();
    return true;
  }
  res.setHeader('Content-Type', contentType);
  const ae = String(req.headers['accept-encoding'] || '');
  const viaNetlifyProxy = Boolean(req.headers['x-nf-request-id']);
  if (!viaNetlifyProxy && /\bbr\b/i.test(ae) && pack.br) {
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Content-Length', String(pack.br.length));
    res.status(200).end(pack.br);
    return true;
  }
  if (/\bgzip\b/i.test(ae) && pack.gzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(pack.gzip.length));
    res.status(200).end(pack.gzip);
    return true;
  }
  res.setHeader('Content-Length', String(pack.raw.length));
  res.status(200).end(pack.raw);
  return true;
}

function isTrustedStreamClientRequest(req) {
  const clientHeader = String(req.headers['x-freef1-client'] || '').trim().toLowerCase();
  if (clientHeader !== 'cockpit') return false;
  const secDest = String(req.headers['sec-fetch-dest'] || '').trim().toLowerCase();
  const secMode = String(req.headers['sec-fetch-mode'] || '').trim().toLowerCase();
  if (secDest === 'document' || secDest === 'iframe' || secMode === 'navigate') return false;
  const reqOrigin = normalizeOrigin(req.headers.origin || req.headers.referer || '');
  if (!reqOrigin) return false;
  return isPublicSiteOrigin(reqOrigin) || (!PRODUCTION && reqOrigin === selfOrigin(req));
}

function isTrustedStreamEmbedRequest(req) {
  const secDest = String(req.headers['sec-fetch-dest'] || '').trim().toLowerCase();
  if (secDest !== 'iframe') return false;
  const refererOrigin = normalizeOrigin(req.headers.referer || '');
  if (!refererOrigin) return false;
  return isRelayOrigin(refererOrigin) || (!PRODUCTION && refererOrigin === selfOrigin(req));
}

app.get('/api/stream/resolve', async (req, res) => {
  setNoStore(res);
  const path = String(req.query.path || '').trim().slice(0, 120);
  if (!path) return res.status(400).json({ error: 'A provider path is required.', code: 'bad-request' });
  try {
    const result = await streamResolver.resolveDynamic(path);
    if (!result.url) {
      return res.status(503).json({
        error: result.code === 'link-expired' ? 'That provider link expired; ask again.' : 'That provider is not serving right now.',
        code: result.code || 'unavailable',
        retry: Boolean(result.retry)
      });
    }
    return res.json({ url: result.url, cached: Boolean(result.cached) });
  } catch (error) {
    console.error('[streams] resolve failed:', error?.message || error);
    return res.status(503).json({ error: 'That provider could not be resolved.', code: 'unavailable' });
  }
});

app.get('/api/stream/health', async (_req, res) => {
  try {
    const report = await streamResolver.getHealth();
    res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=60');
    setNetlifyEdgeCache(res, 120, { swr: 60 });
    return res.json({ checkedAt: report.at, providers: report.providers, uhdResolved: report.uhdResolved });
  } catch (error) {
    setNoStore(res);
    console.error('[streams] health failed:', error?.message || error);
    return res.status(503).json({ error: 'Health check unavailable.', code: 'unavailable' });
  }
});

/* Every source the player draws, with the links it may use right now. This is the answer to
   "is the backend in step with the site": one list, published by the server, matched 1:1 with the
   chips in netlifyf1/src/app.ts. Providers that publish mirrors (strmfree) contribute their
   current ones on top of the static pool. */
app.get('/api/stream/auto', async (_req, res) => {
  await stateReady;
  const result = await resolveAutoStreams({ enabled:state.sources.autoStreams === true, weekend:raceWeekend, resolver:autoResolver });
  const window = result.window;
  if (window.reason === 'mode-disabled') res.setHeader('Cache-Control', 'no-store');
  else {
    const remaining = Math.max(0, Math.floor((window.nextCheckAt - Date.now()) / 1000));
    res.setHeader('Cache-Control', `public, max-age=${Math.min(window.active ? 600 : 60, remaining)}`);
  }
  return res.json(result);
});

app.get('/api/stream/sources', async (_req, res) => {
  try {
    const sources = await streamResolver.listSources();
    res.setHeader('Cache-Control', 'public, max-age=60');
    setNetlifyEdgeCache(res, 60, { swr: 30 });
    return res.json({ sources, count: sources.length, minQuality: 720 });
  } catch (error) {
    setNoStore(res);
    console.error('[streams] sources failed:', error?.message || error);
    return res.status(503).json({ error: 'Source list unavailable.', code: 'unavailable' });
  }
});

/* weelo's status map, relayed. The browser cannot fetch it itself: the file is served with
   `access-control-allow-origin: *` but the edge refuses the cross-origin request outright, which
   shows up in the console as a CORS failure and left every onboard stuck on "unknown". */
/* PPV F1 channel list (built from https://api.ppv.st/api/streams with 540p variants excluded). */
app.get(['/api/stream/taifood', '/api/stream/ppv'], async (_req, res) => {
  try {
    const { list, ppv, at } = await getTaifoodChannels();
    res.setHeader('Cache-Control', 'public, max-age=60');
    setNetlifyEdgeCache(res, 60, { swr: 30 });
    return res.json({ channels: list, ppv: ppv || '', count: list.length, updatedAt: at || null });
  } catch (error) {
    setNoStore(res);
    console.error('[streams] ppv list failed:', error?.message || error);
    return res.status(503).json({ error: 'Channel list unavailable.', code: 'unavailable' });
  }
});

/* EMB F1 channel map relay (excludes UHD, backs up direct api.embdlol.st/struct browser fetches). */
app.get('/api/stream/embdlol', async (_req, res) => {
  try {
    const { channels, at } = await getEmbdlolChannels();
    res.setHeader('Cache-Control', 'public, max-age=60');
    setNetlifyEdgeCache(res, 60, { swr: 30 });
    return res.json({ channels, count: Object.keys(channels).length, updatedAt: at });
  } catch (error) {
    setNoStore(res);
    console.error('[streams] embdlol list failed:', error?.message || error);
    return res.status(503).json({ error: 'Channel list unavailable.', code: 'unavailable' });
  }
});

app.get('/api/stream/weelo', async (req, res) => {
  res.append('Vary', 'X-FreeF1-Client, Sec-Fetch-Dest, Referer');
  if (!isTrustedStreamClientRequest(req)) {
    setNoStore(res);
    return res.status(403).json({ error: 'Direct access is not permitted.', code: 'forbidden' });
  }
  try {
    const state = await getWeeloState();
    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');
    setNetlifyEdgeCache(res, 30, { swr: 30, varyHeader: 'x-freef1-client|sec-fetch-dest' });
    return res.json({ state, count: Object.keys(state).length });
  } catch (error) {
    setNoStore(res);
    console.error('[streams] weelo state failed:', error?.message || error);
    return res.status(503).json({ error: 'Status unavailable.', code: 'unavailable' });
  }
});

/* Stripped (ad-free) weellz.live embed document + 16-byte AES-128 key relay.
   Video manifests and segments stream directly from weelo.live to the viewer's browser;
   only the cached player HTML shell and 16-byte decryption keys touch this process. */
const WEELLZ_EMBED_FRAME_ANCESTORS = "https://freef1-live.vercel.app";
function relayEmbedPolicy(req, res, policy) {
  const refererOrigin = normalizeOrigin(req.headers.referer || '');
  const preview = refererOrigin && isRelayOrigin(refererOrigin) && refererOrigin !== RELAY_LIVE_ORIGIN
    ? ` ${refererOrigin}` : '';
  res.setHeader('Content-Security-Policy', policy.replace(
    `frame-ancestors ${WEELLZ_EMBED_FRAME_ANCESTORS}`,
    `frame-ancestors ${WEELLZ_EMBED_FRAME_ANCESTORS}${preview}`
  ));
  // Policies vary by requesting page; never share a cached response across sites.
  res.append('Vary', 'Referer');
  setNoStore(res);
}

const WEELLZ_EMBED_CSP = [
  "default-src 'self' https: blob: data:",
  "base-uri https://weellz.live 'self'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://ssl.p.jwpcdn.com https://*.jwpcdn.com${PRODUCTION ? '' : ' http://ssl.p.jwpcdn.com'} https://weellz.live blob:`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://weellz.live",
  "font-src 'self' data: https://weellz.live",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' https: wss:",
  `frame-ancestors ${WEELLZ_EMBED_FRAME_ANCESTORS}`,
  "form-action 'none'",
  ...(PRODUCTION ? ['upgrade-insecure-requests'] : [])
].join('; ');

const EMBDLOL_EMBED_CSP = [
  "default-src 'self' https: blob: data:",
  "base-uri 'self'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://embdlol.st https://cdn.jsdelivr.net https://ssl.p.jwpcdn.com https://*.jwpcdn.com${PRODUCTION ? '' : ' http://ssl.p.jwpcdn.com'} blob:`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' https: wss:",
  `frame-ancestors ${WEELLZ_EMBED_FRAME_ANCESTORS}`,
  "form-action 'none'",
  ...(PRODUCTION ? ['upgrade-insecure-requests'] : [])
].join('; ');

const STRMFREE_EMBED_CSP = [
  "default-src 'self' https: blob: data:",
  "base-uri https://strmfree.st https://streamfree.top 'self'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://strmfree.st https://streamfree.top https://*.strmfree.st https://cdn.jwplayer.com https://cdn.jsdelivr.net https://ssl.p.jwpcdn.com https://*.jwpcdn.com https://*.connatix.com${PRODUCTION ? '' : ' http://ssl.p.jwpcdn.com'} blob:`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://strmfree.st https://streamfree.top",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' https: wss:",
  `frame-ancestors ${WEELLZ_EMBED_FRAME_ANCESTORS}`,
  "form-action 'none'",
  ...(PRODUCTION ? ['upgrade-insecure-requests'] : [])
].join('; ');

const PPV_EMBED_CSP = [
  "default-src 'self' https: blob: data:",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' https: wss:",
  `frame-ancestors ${WEELLZ_EMBED_FRAME_ANCESTORS}`,
  "form-action 'none'",
  ...(PRODUCTION ? ['upgrade-insecure-requests'] : [])
].join('; ');

app.get('/api/stream/strmfree-embed', async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  relayEmbedPolicy(req, res, STRMFREE_EMBED_CSP);
  const variant = String(req.query.variant || 'skyf11080p').trim();
  const host = String(req.query.host || 'strmfree.st').trim();
  if (/2160p|540p/i.test(variant) || !/^(?:skyf11080p|skyf1)$/i.test(variant)) {
    setNoStore(res);
    return res.status(400).json({ error: 'A valid HD stream variant is required.', code: 'bad-request' });
  }
  const result = await streamResolver.strmfreeStrippedHtml(variant, host);
  if (!result.ok) {
    setNoStore(res);
    const status = result.status || 503;
    if (req.accepts(['json', 'html']) === 'html') {
      return res.status(status).type('html').send('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#000;color:rgba(255,255,255,.72);font:500 14px/1.4 system-ui,sans-serif}</style><body><div>Feed temporarily unavailable — switching mirror…</div></body>');
    }
    return res.status(status).json({ error: result.error || 'Stripped player unavailable.', code: 'unavailable' });
  }
  if (sendPacked(req, res, result.pack, 'text/html; charset=utf-8')) return;
  return res.type('html').send(result.html);
});

app.get('/api/stream/strmfree-m3u8/:mode/:variant/index.m3u8', async (req, res) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const result = await streamResolver.strmfreePlaylist(req.params.mode, req.params.variant, req.query.host);
  if (!result.ok) {
    setNoStore(res);
    res.setHeader('Netlify-CDN-Cache-Control', 'no-store');
    return res.status(result.status || 502).json({ error: result.error || 'Playlist unavailable.', code: 'unavailable' });
  }
  res.setHeader('Cache-Control', 'private, max-age=3');
  setNetlifyEdgeCache(res, 3, { swr: 2, varyQuery: 'host' });
  if (sendPacked(req, res, result.pack, 'application/vnd.apple.mpegurl; charset=utf-8')) return;
  return res.type('application/vnd.apple.mpegurl').status(200).send(result.body);
});

app.get('/api/stream/ppv-embed', (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  relayEmbedPolicy(req, res, PPV_EMBED_CSP);
  const slug = String(req.query.slug || '').trim();
  const host = String(req.query.host || '').trim();
  const result = streamResolver.ppvStrippedHtml(slug, host);
  if (!result.ok) {
    setNoStore(res);
    return res.status(result.status || 400).json({ error: result.error || 'A valid HD PPV stream slug is required.', code: 'bad-request' });
  }
  if (sendPacked(req, res, result.pack, 'text/html; charset=utf-8')) return;
  return res.type('html').send(result.html);
});

app.get('/api/stream/ppv-m3u8/index.m3u8', async (req, res) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const result = await streamResolver.ppvMasterPlaylist(req.query.slug, req.query.host);
  if (!result.ok) {
    setNoStore(res);
    res.setHeader('Netlify-CDN-Cache-Control', 'no-store');
    return res.status(result.status || 502).json({ error: result.error || 'PPV playlist unavailable.', code: 'unavailable' });
  }
  res.setHeader('Cache-Control', 'private, max-age=20');
  setNetlifyEdgeCache(res, 30, { swr: 15, varyQuery: 'slug|host' });
  if (sendPacked(req, res, result.pack, 'application/vnd.apple.mpegurl; charset=utf-8')) return;
  return res.type('application/vnd.apple.mpegurl').status(200).send(result.body);
});

app.get('/api/stream/ppv-m3u8/sub.m3u8', async (req, res) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const result = await streamResolver.ppvSubPlaylist(req.query.slug, req.query.sub, req.query.host);
  if (!result.ok) {
    setNoStore(res);
    res.setHeader('Netlify-CDN-Cache-Control', 'no-store');
    return res.status(result.status || 502).json({ error: result.error || 'PPV media playlist unavailable.', code: 'unavailable' });
  }
  res.setHeader('Cache-Control', 'private, max-age=2');
  setNetlifyEdgeCache(res, 3, { swr: 2, varyQuery: 'slug|host|sub' });
  if (sendPacked(req, res, result.pack, 'application/vnd.apple.mpegurl; charset=utf-8')) return;
  return res.type('application/vnd.apple.mpegurl').status(200).send(result.body);
});

app.get('/api/stream/embdlol-embed', (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  relayEmbedPolicy(req, res, EMBDLOL_EMBED_CSP);
  const id = String(req.query.id || '').trim();
  const result = streamResolver.embdlolStrippedHtml(id);
  if (!result.ok) {
    setNoStore(res);
    return res.status(result.status || 400).json({ error: result.error || 'A valid EMB channel id is required.', code: 'bad-request' });
  }
  if (sendPacked(req, res, result.pack, 'text/html; charset=utf-8')) return;
  return res.type('html').send(result.html);
});

app.get('/api/stream/weellz-embed', async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  relayEmbedPolicy(req, res, WEELLZ_EMBED_CSP);
  res.append('Vary', 'Sec-Fetch-Dest, Referer');
  const rawStream = req.query.stream;
  if (rawStream !== undefined && !/^[A-Za-z0-9_-]{4,160}$/.test(String(rawStream).trim())) {
    setNoStore(res);
    return res.status(400).json({ error: 'A valid stream id is required.', code: 'bad-request' });
  }
  if (!isTrustedStreamEmbedRequest(req)) {
    setNoStore(res);
    return res.status(403).json({ error: 'Direct embed access is not permitted.', code: 'forbidden' });
  }
  try {
    const { html, pack } = await streamResolver.weellzStrippedHtml();
    if (sendPacked(req, res, pack, 'text/html; charset=utf-8')) return;
    res.type('html').send(html);
  } catch (error) {
    console.error('[streams] weellz stripped embed failed:', error?.message || error);
    setNoStore(res);
    if (req.accepts(['json', 'html']) === 'html') {
      return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#000;color:rgba(255,255,255,.72);font:500 14px/1.4 system-ui,sans-serif}</style><body><div>Feed temporarily unavailable.</div></body>');
    }
    return res.status(503).json({ error: 'Stripped player unavailable right now.', code: 'unavailable' });
  }
});

app.get('/api/stream/weellz-key/:kid', async (req, res) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Expose-Headers', 'Date, Retry-After');
  const result = await streamResolver.weellzAesKey(req.params.kid, req.query.t);
  if (result.date) res.setHeader('Date', result.date);
  if (!result.ok) {
    setNoStore(res);
    return res.status(result.status || 502).json({ error: result.error || 'Key unavailable.', code: 'unavailable' });
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  setNetlifyEdgeCache(res, 7200, { swr: 600, varyQuery: 't' });
  res.type('application/octet-stream').status(200).send(result.body);
});

app.get('/api/stream/uhd', async (_req, res) => {
  try {
    const url = await streamResolver.resolveUhdUrl();
    if (!url) {
      setNoStore(res);
      return res.status(503).json({
        error: 'The 4K channel is not listed upstream right now.',
        code: 'unavailable'
      });
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    setNetlifyEdgeCache(res, 120, { swr: 30 });
    return res.json({ url, source: 'emb-uhd' });
  } catch (error) {
    setNoStore(res);
    console.error('[4K] resolve failed:', error?.message || error);
    return res.status(503).json({ error: 'The 4K channel could not be resolved.', code: 'unavailable' });
  }
});


app.get('/api/site/config', async (_req, res) => {
  await stateReady;
  res.setHeader('Cache-Control', `public, max-age=${SITE_CONFIG_MAX_AGE_SECONDS}`);
  setNetlifyEdgeCache(res, 60, { swr: 30 });
  res.json(publicConfig());
});

app.get('/api/site/updates', async (_req, res) => {
  await stateReady;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const removeStream = () => siteConfigStreams.delete(res);
  res.once('close', removeStream);
  res.once('error', removeStream);
  siteConfigStreams.add(res);
  // This is a one-time retry hint, not a periodic heartbeat. Every reconnect
  // receives a fresh snapshot before listening for subsequent Race Control edits.
  res.write(': config stream open\nretry: 30000\n\n');
  res.flush?.();
  sendSiteConfigEvent(res);
});

function isHelpPausedByAdmin() {
  return Boolean(state.maintenance?.active) || state.pages.disabled.includes('help');
}

app.get('/api/help/config', async (_req, res) => {
  await helpTicketService.ready;
  const pausedByAdmin = isHelpPausedByAdmin();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    available: !pausedByAdmin && helpTicketService.availability().available,
    pausedByAdmin,
    categories: HELP_CATEGORIES,
    limits: { initialMessage: 4000, chatMessage: 2000, messagesPerMinute: 10 },
    uploadsEnabled: false,
  });
});

app.post('/api/help/tickets', async (req, res) => {
  if (isHelpPausedByAdmin()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'The Help desk is temporarily paused by Race Control.' });
  }
  try {
    const result = await helpTicketService.createTicket({
      token: helpTokenFromRequest(req),
      body: req.body || {},
      ipKey: helpRateKey(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  } catch (error) {
    sendHelpError(res, error);
  }
});

app.get('/api/help/ticket/status', async (req, res) => {
  try {
    const result = await helpTicketService.getStatus(helpTokenFromRequest(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    sendHelpError(res, error);
  }
});

app.get('/api/help/ticket', async (req, res) => {
  try {
    const result = await helpTicketService.getTicket(helpTokenFromRequest(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    sendHelpError(res, error);
  }
});

app.post('/api/help/ticket/messages', async (req, res) => {
  if (isHelpPausedByAdmin()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'The Help desk is temporarily paused by Race Control.' });
  }
  try {
    const result = await helpTicketService.sendMessage({ token: helpTokenFromRequest(req), text: req.body?.text });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  } catch (error) {
    sendHelpError(res, error);
  }
});

app.delete('/api/help/ticket', async (req, res) => {
  try {
    const result = await helpTicketService.deleteTicket(helpTokenFromRequest(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    sendHelpError(res, error);
  }
});

app.get('/api/help/events', async (req, res) => {
  try {
    const token = helpTokenFromRequest(req);
    await helpTicketService.getStatus(token);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    helpTicketService.subscribe(token, res);
  } catch (error) {
    if (!res.headersSent) sendHelpError(res, error);
    else res.end();
  }
});

function adminSameOrigin(req, res, next) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const raw = req.headers.origin || req.headers.referer || '';
  const origin = normalizeOrigin(raw);
  if (PRODUCTION && !origin) return res.status(403).json({ error: 'Missing request origin' });
  if (origin && origin !== selfOrigin(req)) return res.status(403).json({ error: 'Cross-origin admin request refused' });
  next();
}

const loginAttempts = new Map();
const LOGIN_LIMIT = 6;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function checkLoginRate(req, res, next) {
  const ip = sanitizeIp(req.ip || req.socket.remoteAddress);
  const now = Date.now();
  if (loginAttempts.size > 2000) {
    for (const [key, record] of loginAttempts) {
      if (record.resetAt <= now && record.lockedUntil <= now) loginAttempts.delete(key);
    }
    while (loginAttempts.size > 2000) loginAttempts.delete(loginAttempts.keys().next().value);
  }
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.lockedUntil > now) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((attempt.lockedUntil - now) / 1000))));
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
  }
  if (!attempt || attempt.resetAt <= now) loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS, lockedUntil: 0 });
  req.loginIp = ip;
  next();
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS, lockedUntil: 0 };
  if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + LOGIN_WINDOW_MS; }
  attempt.count++;
  if (attempt.count >= LOGIN_LIMIT) {
    attempt.lockedUntil = now + LOGIN_WINDOW_MS;
    attempt.count = 0;
  }
  loginAttempts.set(ip, attempt);
}

app.post('/admin/api/login', adminSameOrigin, checkLoginRate, (req, res) => {
  const isFormPost = !req.is('application/json') && req.accepts(['html', 'json']) === 'html';
  const username = safeText(req.body?.username, 100);
  const password = String(req.body?.password || '').slice(0, 500);
  if (!isSafeEqual(username, ADMIN_USER) || !isSafeEqual(password, ADMIN_PASS)) {
    recordLoginFailure(req.loginIp);
    if (isFormPost) return res.redirect(303, '/admin/?auth=failed');
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }
  loginAttempts.delete(req.loginIp);
  req.session = { isAdmin: true, loginAt: Date.now() };
  if (isFormPost) return res.redirect(303, '/admin/');
  res.json({ success: true });
});

app.get('/admin/api/status', (req, res) => {
  res.json({ authenticated: Boolean(req.session?.isAdmin), loginAt: req.session?.loginAt || null });
});

function requireAdmin(req, res, next) {
  const trustedForward = CONTROL_ROLE === 'headquarters' && req.method === 'POST' && FORWARDABLE_ADMIN_PATHS.has(req.path) && isSafeEqual(req.headers.authorization || '', `Bearer ${HQ_PUSH_SECRET}`);
  if (!req.session?.isAdmin && !trustedForward) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
app.use('/admin/api', adminSameOrigin, (req, res, next) => {
  if (req.path === '/login' || req.path === '/status') return next();
  return requireAdmin(req, res, next);
});

// Only Headquarters may change shared Race Control state. Serialize writes so
// a failed write can safely roll back without erasing a concurrent change.
app.use('/admin/api', (req, res, next) => {
  if (req.method !== 'POST' || req.path === '/logout') return next();
  if (CONTROL_ROLE === 'replica') {
    if (!FORWARDABLE_ADMIN_PATHS.has(req.path)) return res.status(403).json({ error: 'This action is only available on Headquarters.' });
    if (!HQ_URL) return res.status(503).json({ error: 'HQ_URL is not configured on this backend.' });
    // Require the replica's admin session above; forward only whitelisted control operations.
    return (async () => {
      try {
        const response = await fetch(`${HQ_URL}/admin/api${req.path}`, {
          method: 'POST', headers: { authorization: `Bearer ${HQ_PUSH_SECRET}`, origin: HQ_URL, 'content-type': 'application/json' },
          body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(45000), redirect: 'error'
        });
        const payload = await response.json();
        res.setHeader('Cache-Control', 'no-store');
        return res.status(response.status).json(payload);
      } catch (_) {
        return res.status(503).json({ error: 'Could not reach Headquarters. Your change was not confirmed; check Headquarters before retrying.' });
      }
    })();
  }
  if (CONTROL_ROLE !== 'headquarters') return next();
  const previous = adminWriteTail;
  let release;
  adminWriteTail = new Promise(resolve => { release = resolve; });
  previous.then(() => {
    if (res.destroyed || res.writableEnded) return release();
    // A disconnected client must not release the lock while its write is still running.
    // Express eventually calls end after the handler has committed or rolled back.
    const end = res.end;
    let done = false;
    res.end = function (...args) {
      try { return end.apply(this, args); }
      finally { if (!done) { done = true; release(); } }
    };
    next();
  });
});

// Fetch public aggregate statistics on demand for an authenticated dashboard.
app.get('/admin/api/viewer-peaks', async (_req, res) => {
  try {
    const results = await Promise.all(['main', 'backup'].map(async site => {
      const response = await fetch(`https://freef1-viewer-counter.calvinbotha1julie.workers.dev/admin/peaks?site=${site}`, {
        signal: AbortSignal.timeout(10000), redirect: 'error'
      });
      if (!response.ok) throw new Error('Counter unavailable');
      const data = await response.json();
      return { site, peaks: Array.isArray(data.peaks) ? data.peaks : [], current: data.current && typeof data.current === 'object' ? data.current : null };
    }));
    return res.json({ sites: results });
  } catch { return res.status(503).json({ error: 'Could not load viewer peaks. Check the counter service.' }); }
});

app.get('/admin/api/headquarters', async (_req, res) => {
  if (CONTROL_ROLE !== 'headquarters') return res.json({ enabled: false });
  const targets = await require('./headquarters').checkTargets(HQ_TARGETS);
  res.json({ enabled: true, checkedAt: Date.now(), storageConnected: redisReady, lastSharedSync, targets, delivery: lastPushResults });
});

app.post('/admin/api/headquarters/sync', async (_req, res) => {
  if (CONTROL_ROLE !== 'headquarters') return res.status(404).end();
  await stateReady;
  if (!sharedInitialized) return res.status(503).json({ error: 'Shared settings are not initialized.' });
  lastPushResults = await require('./headquarters').pushUpdates(HQ_PUSH_TARGETS, HQ_PUSH_SECRET);
  res.json({ success: true, delivery: lastPushResults });
});

app.post('/admin/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

async function buildAdminLinkReport({ fast = false } = {}) {
  let rows = null;
  if (!(fast && process.env.NODE_ENV === 'test')) {
    try {
      rows = fast
        ? await Promise.race([
            streamResolver.chipAddresses(),
            new Promise((resolve) => setTimeout(() => resolve(null), 2200))
          ])
        : await streamResolver.chipAddresses();
    } catch (error) {
      if (!fast) throw error;
      rows = null;
    }
  }
  const byId = rows ? new Map(rows.map((row) => [row.id, row])) : null;
  const streams = adminSourceList().map((source) => {
    const live = byId ? (byId.get(source.id) || { addresses: [], current: '', wouldUse: '', state: '', online: false }) : null;
    const fallbackUrl = source.defaultUrl || '';
    const shipped = live
      ? live.addresses.map((entry) => ({ url: entry.url, quality: entry.quality, from: entry.from }))
      : (fallbackUrl ? [{ url: fallbackUrl, quality: 1080, from: 'configured' }] : []);
    const current = source.customUrl || (live ? (live.current || '') : fallbackUrl);
    const wouldUse = (live ? live.wouldUse : '') || fallbackUrl || '';
    return {
      id: source.id,
      label: source.label,
      provider: source.provider,
      tab: source.tab,
      disabled: state.sources.disabled.includes(source.id),
      /* A chip Race Control typed an address for shows BOTH: the typed one wins in the player. */
      customUrl: source.customUrl || '',
      shipped,
      current,
      wouldUse,
      state: live?.state || '',
      online: Boolean(source.customUrl) || (live ? Boolean(live.online) : Boolean(fallbackUrl))
    };
  });
  return { checkedAt: Date.now(), siteUrl: SITE_URL, streams };
}

app.get('/admin/api/config', async (_req, res) => {
  await stateReady;
  const linkReport = await buildAdminLinkReport({ fast: true });
  res.json({ controlRole: CONTROL_ROLE, ...publicConfig(), sources: adminSourcesState(), pageList: CONTROLLABLE_PAGES, sourceList: adminSourceList(), linkReport, storage: storageSummary(), fourK: streamResolver.summary() });
});

app.post('/admin/api/failover', async (req, res) => {
  await stateReady;
  if (CONTROL_ROLE !== 'headquarters') return res.status(403).json({ error: 'Use Headquarters for failover.' });
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
  state.failover = { active: req.body.active, updatedAt: Date.now() };
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, failover: state.failover, ...persisted });
});

app.get('/admin/api/pages', async (_req, res) => {
  await stateReady;
  res.json({ pages: publicPages(), pageList: CONTROLLABLE_PAGES, ...storageSummary() });
});
app.post('/admin/api/pages', async (req, res) => {
  await stateReady;
  if (!Array.isArray(req.body?.disabled)) return res.status(400).json({ error: 'disabled must be an array of page IDs.' });
  const cleaned = req.body.disabled.map(id => String(id).trim().toLowerCase());
  const unknown = cleaned.filter(id => !CONTROLLABLE_PAGE_IDS.has(id));
  if (unknown.length) return res.status(400).json({ error: `Unknown page ID(s): ${unknown.join(', ')}` });
  state.pages = normalizePages({ disabled: cleaned, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, pages: publicPages(), pageList: CONTROLLABLE_PAGES, ...persisted });
});

app.get('/admin/api/maintenance', async (_req, res) => {
  await stateReady;
  res.json({ maintenance: state.maintenance, ...storageSummary() });
});
app.post('/admin/api/maintenance', async (req, res) => {
  await stateReady;
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
  const wasActive = state.maintenance.active;
  state.maintenance = normalizeMaintenance({
    ...state.maintenance,
    active: req.body.active,
    message: req.body.message === undefined ? state.maintenance.message : req.body.message,
    eta: req.body.eta === undefined ? state.maintenance.eta : req.body.eta,
    startedAt: req.body.active ? (wasActive ? state.maintenance.startedAt : Date.now()) : null,
    updatedAt: Date.now()
  });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, maintenance: state.maintenance, ...persisted });
});

app.get('/admin/api/stream/window', async (_req, res) => {
  await stateReady;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ streamWindow: state.streamWindow, ...storageSummary() });
});
app.post('/admin/api/stream/window', async (req, res) => {
  await stateReady;
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
  const wasActive = state.streamWindow.active;
  state.streamWindow = normalizeStreamWindow({
    active: req.body.active,
    reason: req.body.active ? req.body.reason : '',
    startedAt: req.body.active ? (wasActive ? state.streamWindow.startedAt : Date.now()) : null,
    updatedAt: Date.now()
  });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, streamWindow: state.streamWindow, ...persisted });
});

app.get('/admin/api/stream/status', async (_req, res) => {
  await stateReady;
  res.json({ ...state.streamOverride, ...storageSummary() });
});
app.post('/admin/api/stream/override', async (req, res) => {
  await stateReady;
  const parsed = classifyStreamUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: 'Enter a valid HTTPS YouTube, MP4, WebM, or embed URL.' });
  state.streamOverride = {
    ...parsed,
    active: true,
    startedAt: state.streamOverride.active ? state.streamOverride.startedAt : Date.now(),
    updatedAt: Date.now()
  };
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, override: state.streamOverride, ...persisted });
});
app.post('/admin/api/stream/stop', async (_req, res) => {
  await stateReady;
  state.streamOverride = { ...state.streamOverride, active: false, startedAt: null, updatedAt: Date.now() };
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, override: state.streamOverride, ...persisted });
});
app.post('/admin/api/stream/normal', async (_req, res) => {
  await stateReady;
  state.streamOverride = { active: false, input: null, url: null, type: null, startedAt: null, updatedAt: Date.now() };
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, override: state.streamOverride, ...persisted });
});

app.post('/admin/api/stream/auto', async (req, res) => {
  await stateReady;
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.' });
  state.sources = normalizeSources({ ...state.sources, autoStreams: req.body.enabled, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, sources: adminSourcesState(), ...persisted });
});

app.post('/admin/api/stream/relays', async (req, res) => {
  await stateReady;
  if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be a boolean.' });
  state.sources = normalizeSources({ ...state.sources, relaysDisabled: req.body.disabled, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, sources: adminSourcesState(), ...persisted });
});

app.get('/admin/api/stream/sources', async (_req, res) => {
  await stateReady;
  res.json({ sources: FEED_SOURCES, ...state.sources, ...storageSummary() });
});
app.post('/admin/api/stream/sources', async (req, res) => {
  await stateReady;
  if (!Array.isArray(req.body?.disabled)) return res.status(400).json({ error: 'disabled must be an array of source IDs.' });
  const cleanedDisabled = req.body.disabled.map(String).filter(id => !RETIRED_COMPAT_SOURCE_IDS.has(id));
  const knownSourceIds = new Set([...FEED_SOURCE_IDS, ...state.sources.custom.map(source => source.id)]);
  const unknown = cleanedDisabled.filter(id => !knownSourceIds.has(id));
  if (unknown.length) return res.status(400).json({ error: `Unknown source ID(s): ${unknown.join(', ')}` });
  state.sources = normalizeSources({ ...state.sources, disabled: cleanedDisabled, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, sources: FEED_SOURCES, sourceList: adminSourceList(), ...state.sources, ...persisted });
});

// One atomic catalogue update. IDs for shipped sources remain stable for old clients.
app.post('/admin/api/stream/catalogue', async (req, res) => {
  await stateReady;
  const body = req.body || {};
  if (!Array.isArray(body.custom) || !Array.isArray(body.disabled) || !Array.isArray(body.removed) || !Array.isArray(body.order) || !body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) return res.status(400).json({ error: 'Invalid source catalogue.' });
  if (body.custom.length > 50) return res.status(400).json({ error: 'At most 50 custom sources are allowed.' });
  const ids = new Set(FEED_SOURCE_IDS);
  for (const item of body.custom) {
    const id = String(item?.id || '');
    const url = httpsUrl(item?.url);
    if (!/^custom-[a-z0-9-]{1,60}$/.test(id) || ids.has(id) || !safeText(item?.label, 40) || !url || url.href.length > 500 || !['en','other'].includes(item?.tab)) return res.status(400).json({ error: 'Each custom source needs a unique ID, name, HTTPS link, and valid group.' });
    ids.add(id);
  }
  if (body.disabled.some(id => !ids.has(id)) || body.order.some(id => !ids.has(id)) || body.removed.some(id => !FEED_SOURCE_IDS.has(id)) || new Set(body.order).size !== body.order.length) return res.status(400).json({ error: 'The source list contains unknown or duplicate IDs.' });
  for (const [id, entry] of Object.entries(body.overrides)) {
    if (!FEED_SOURCE_IDS.has(id) || !entry || typeof entry !== 'object' || (entry.url && (!httpsUrl(entry.url) || String(entry.url).length > 500))) return res.status(400).json({ error: 'Custom links must be full HTTPS addresses.' });
  }
  state.sources = normalizeSources({ ...body, autoStreams: state.sources.autoStreams, relaysDisabled: state.sources.relaysDisabled, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, sources: adminSourcesState(), sourceList: adminSourceList(), ...persisted });
});

/* Bulk availability: 'disable'/'enable' + a group (emb / weelo / taifood / strmfree / all …) or an
   explicit id list. One request, so a group toggle cannot half-apply. */
app.post('/admin/api/stream/sources/bulk', async (req, res) => {
  await stateReady;
  const action = String(req.body?.action || '');
  if (action !== 'disable' && action !== 'enable') return res.status(400).json({ error: "action must be 'disable' or 'enable'." });
  const group = String(req.body?.group || '');
  const explicit = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  const inGroup = (source) => {
    if (explicit) return explicit.includes(source.id);
    if (!group) return false;
    if (group === 'all') return true;
    /* 'emb' covers embdlol chips; 'ppv'/'taifood' covers PPV chips; every other name matches provider. */
    if (group === 'emb') return source.provider === 'embdlol';
    if (group === 'ppv' || group === 'taifood') return source.provider === 'ppv' || source.provider === 'taifood';
    if (group === 'other') return source.tab === 'other';
    if (group === 'special') return Boolean(source.special);
    return String(source.provider || '') === group;
  };
  const pending = new Set(state.sources.disabled.map(String));
  let touched = 0;
  for (const source of FEED_SOURCES) {
    if (!inGroup(source)) continue;
    touched += 1;
    if (action === 'disable') pending.add(source.id);
    else pending.delete(source.id);
  }
  if (!touched) return res.status(400).json({ error: 'That group matched no sources.' });
  state.sources = normalizeSources({ ...state.sources, disabled: [...pending], updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, action, group: group || null, touched, sources: FEED_SOURCES, ...state.sources, ...persisted });
});

/* What each chip would open right now, next to the address it is configured to use. Read-only. */
app.get('/admin/api/stream/links', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.json(await buildAdminLinkReport({ fast: false }));
  } catch (error) {
    console.error('[streams] link report failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not read the current links.' });
  }
});

/* One chip: its custom name and its custom link. Distinct from /stream/override, which forces the
   whole site onto one address. */
app.post('/admin/api/stream/chip', async (req, res) => {
  await stateReady;
  const id = String(req.body?.id || '');
  if (!FEED_SOURCE_IDS.has(id)) return res.status(400).json({ error: 'Unknown source ID.' });
  const raw = { ...state.sources.overrides[id] };
  /* An empty string clears the field; leaving the key out of the body leaves it untouched. */
  if ('label' in (req.body || {})) {
    const label = safeText(req.body.label, OVERRIDE_TEXT);
    if (label) raw.label = label;
    else delete raw.label;
  }
  if ('url' in (req.body || {})) {
    const value = String(req.body.url || '').trim();
    if (!value) delete raw.url;
    else {
      const url = httpsUrl(value);
      if (!url) return res.status(400).json({ error: 'The custom link must be a full https:// address.' });
      raw.url = url.href.slice(0, 500);
    }
  }
  const overrides = { ...state.sources.overrides };
  if (raw.label || raw.url) overrides[id] = { ...raw, updatedAt: Date.now() };
  else delete overrides[id];
  state.sources = normalizeSources({ ...state.sources, overrides, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, sourceList: adminSourceList(), ...state.sources, ...persisted });
});

app.post('/admin/api/reset-all', async (_req, res) => {
  await stateReady;
  /* Everything Race Control can change goes back to the shipped default: nothing hidden, no custom
     names or links, no forced stream, no maintenance, no page outages. Storage settings are left alone. */
  state.sources = normalizeSources({ disabled: [], overrides: {}, updatedAt: Date.now() });
  state.pages = normalizePages({ disabled: [], updatedAt: Date.now() });
  state.streamOverride = { active: false, input: null, url: null, type: null, startedAt: null, updatedAt: Date.now() };
  state.maintenance = normalizeMaintenance({ active: false, updatedAt: Date.now() });
  const persisted = await persistState();
  if (persisted.error) return res.status(503).json({ error: persisted.error });
  res.json({ success: true, ...publicConfig(), pageList: CONTROLLABLE_PAGES, sourceList: adminSourceList(), ...persisted });
});

const ADMIN_ASSET_VERSION = (() => {
  const hash = crypto.createHash('sha256');
  for (const name of ['fonts.css', 'admin.css', 'admin.js', 'index.html']) {
    try { hash.update(fs.readFileSync(path.join(ADMIN_DIR, name))); } catch (_) {}
  }
  return hash.digest('hex').slice(0, 10);
})();
const ADMIN_INDEX_HTML = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8')
  .replace(/\/admin\/(fonts\.css|admin\.css|admin\.js)(?:\?[^"']*)?/g, `/admin/$1?v=${ADMIN_ASSET_VERSION}`);

function sendAdminIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(ADMIN_INDEX_HTML);
}
app.get(['/admin', '/admin/', '/admin/login'], sendAdminIndex);
/* Shared asset folder (fonts, bot emoji) lives at the repo root and is
   referenced root-relative from the admin pages (/assets/...). Bundled
   documentation ships alongside the files, so markdown never leaves the box. */
const PUBLIC_DOC_FILE = /\.(?:md|markdown)$/i;
const assetOptions = {
  index: false,
  fallthrough: true,
  etag: true,
  maxAge: PRODUCTION ? '1h' : 0,
  setHeaders(res, filePath) {
    if (PUBLIC_DOC_FILE.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
};
const denyDocs = (req, res, next) =>
  PUBLIC_DOC_FILE.test(req.path) ? res.status(404).json({ error: 'Not found' }) : next();
app.use('/assets', denyDocs, express.static(ASSETS_DIR, assetOptions));
app.use('/admin/assets', denyDocs, express.static(ASSETS_DIR, assetOptions));
app.use('/admin', express.static(ADMIN_DIR, {
  index: false,
  fallthrough: true,
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/', (_req, res) => res.redirect(302, CONTROL_ROLE === 'headquarters' ? '/admin/' : `${SITE_URL}/`));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, _req, res, _next) => {
  console.error('[Race Control]', error?.message || error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

/* Discord bot remains an independent optional worker inside this process.
   Ticket metadata is limited to support, with no visitor analytics. */
if (process.env.DISCORD_BOT_TOKEN) {
  try {
    discordBot = require('./bot/discord-bot.js').start({
      token: process.env.DISCORD_BOT_TOKEN,
      guildId: process.env.DISCORD_GUILD_ID || '',
      siteUrl: SITE_URL,
      discordInvite: process.env.DISCORD_INVITE || 'https://discord.gg/KYXHCAzhN4',
      ownerId: process.env.DISCORD_OWNER_ID || '',
      ticketsEnabled: HELP_TICKETS_ENABLED,
      ticketCategoryId: process.env.DISCORD_TICKET_CATEGORY_ID || '',
      ticketStaffRoleId: process.env.DISCORD_TICKET_STAFF_ROLE_ID || '',
      getOpenTicketChannelIds: async () => {
        await helpTicketService.ready;
        return helpTicketService.openChannelIds();
      },
      onTicketReply: message => helpTicketService.handleStaffReply(message),
      readLocalJson,
      writeLocalJson,
      upstash: UPSTASH_ENABLED ? upstashRequest : null,
      redisKey: 'freef1:discordbot:v1',
      fileKey: path.join(DATA_DIR, 'discord-bot.json'),
      log: (...args) => console.log('[Bot]', ...args)
    });
  } catch (error) {
    console.error('[Bot] failed to start:', error.message);
  }
} else {
  console.log('[Bot] disabled (DISCORD_BOT_TOKEN is not set)');
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Race Control] listening on port ${PORT}; site=${SITE_URL}`);
  console.log(`[Race Control] storage=${UPSTASH_ENABLED ? 'Upstash configured' : fileStoreReady ? 'local disk only' : 'memory only'}`);
  if (!UPSTASH_ENABLED) console.warn('[Storage] Configure Upstash or a Render persistent disk if control settings must survive redeploys.');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 15_000;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Race Control] ${signal}; graceful shutdown.`);
  try { discordBot?.stop?.(); } catch (_) {}
  const botFlush = Promise.resolve(discordBot?.flush?.()).catch(() => false);
  server.close(() => {
    botFlush.finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref?.();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
