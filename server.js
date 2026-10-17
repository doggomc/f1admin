'use strict';

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
const PRODUCTION = process.env.NODE_ENV === 'production' || process.env.REQUIRE_PRODUCTION_SECRETS === '1';
const SITE_URL = String(process.env.SITE_URL || 'https://freef1.netlify.app').replace(/\/+$/, '');
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
const CONTROL_FILE = path.join(DATA_DIR, 'race-control.json');
const HELP_TICKETS_FILE = path.join(DATA_DIR, 'help-tickets.json');
const HELP_TICKETS_REDIS_KEY = 'freef1:help-tickets:v1';
const HELP_TICKETS_ENABLED = String(process.env.DISCORD_TICKETS_ENABLED || '').toLowerCase() === 'true';
const PUBLIC_NEWS_ENABLED = String(process.env.PUBLIC_NEWS_ENABLED || '').toLowerCase() === 'true';
const LEGACY_FILES = {
  maintenance: path.join(DATA_DIR, 'maintenance.json'),
  news: path.join(DATA_DIR, 'news.json'),
  sources: path.join(DATA_DIR, 'stream-sources.json'),
  streamOverride: path.join(DATA_DIR, 'stream-override.json'),
  streamWindow: path.join(DATA_DIR, 'stream-window.json')
};
const CONTROL_REDIS_KEY = 'freef1:race-control:v1';
const LEGACY_REDIS_KEYS = {
  maintenance: 'freef1:maintenance:v1',
  news: 'freef1:news:v1',
  sources: 'freef1:stream-sources:v1',
  streamOverride: 'freef1:stream-override:v1',
  streamWindow: process.env.STREAM_WINDOW_REDIS_KEY || 'freef1:stream-window:v1'
};
const UPSTASH_URL = cleanEnv('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL').replace(/\/+$/, '');
const UPSTASH_TOKEN = cleanEnv('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN');
const UPSTASH_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const DEFAULT_ALLOWED_ORIGINS = PRODUCTION
  ? 'https://freef1.netlify.app'
  : 'https://freef1.netlify.app,http://localhost:4173,http://127.0.0.1:4173';
const ALLOWED_ORIGINS = new Set(parseOrigins(process.env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGINS));
const MAX_NEWS_ITEMS = Math.max(1, Math.min(100, Number.parseInt(process.env.NEWS_MAX_ITEMS || '50', 10) || 50));
const SITE_CONFIG_MAX_AGE_SECONDS = 300;
const ADMIN_IP_ALLOWLIST = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(value => value.trim()).filter(Boolean);
const LEGACY_REMOTE_KEYS_TO_DELETE = [
  process.env.UNIQUE_VISITOR_REDIS_KEY || 'freef1:unique-visitors:v1',
  process.env.ANALYTICS_REDIS_KEY || 'freef1:analytics:v1',
  process.env.LOGIN_GUARD_REDIS_KEY || 'freef1:login-guard:v1',
  process.env.STREAM_TARGETS_REDIS_KEY || 'freef1:stream-targets:v1'
];
const LEGACY_LOCAL_FILES_TO_DELETE = ['unique-visitors.json', 'analytics.json', 'login-guard.json', 'stream-targets.json'];

const FEED_SOURCES = [
  { id: 'westream', label: 'WeStream F1' },
  { id: 'sky-uk', label: 'Sky UHD' },
  { id: 'f1tv', label: 'F1TV' },
  { id: 'appletv', label: 'AppleTV' },
  { id: 'dazn', label: 'DAZN' },
  { id: 'wikisport', label: 'WikiSport' }
];
const FEED_SOURCE_IDS = new Set(FEED_SOURCES.map(source => source.id));

const DEFAULT_MAINTENANCE = Object.freeze({
  active: false,
  message: "We'll be back before the race.",
  eta: 'Before lights out',
  startedAt: null,
  updatedAt: null
});

const state = {
  maintenance: { ...DEFAULT_MAINTENANCE },
  news: [],
  sources: { disabled: [], updatedAt: null },
  streamOverride: { active: false, input: null, url: null, type: null, startedAt: null, updatedAt: null },
  streamWindow: { active: false, reason: '', startedAt: null, updatedAt: null },
  experimental: { enabled: true }
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
  // Netlify deploy previews for this project share the production suffix.
  return /^https:\/\/[a-z0-9-]+--freef1\.netlify\.app$/i.test(origin);
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

function normalizeNewsItem(raw = {}, index = 0) {
  const now = Date.now();
  const id = safeText(raw.id, 80).replace(/[^A-Za-z0-9_-]/g, '') || `news_${now.toString(36)}_${index}`;
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  return {
    id,
    title: safeText(raw.title, 100),
    body: safeText(raw.body, 600, { lines: true }),
    tag: safeText(raw.tag, 32) || 'Race Control',
    published: raw.published !== false,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now
  };
}

function normalizeNews(raw) {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.news) ? raw.news : Array.isArray(raw?.items) ? raw.items : [];
  return items.map(normalizeNewsItem).filter(item => item.title && item.body)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NEWS_ITEMS);
}

function normalizeSources(raw = {}) {
  const disabled = Array.isArray(raw.disabled) ? raw.disabled.map(String).filter(id => FEED_SOURCE_IDS.has(id)) : [];
  return { disabled: [...new Set(disabled)], updatedAt: Number(raw.updatedAt) || null };
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
  if (raw.news !== undefined) state.news = normalizeNews(raw.news);
  if (raw.sources) state.sources = normalizeSources(raw.sources);
  if (raw.streamOverride || raw.override) state.streamOverride = normalizeOverride(raw.streamOverride || raw.override);
  if (raw.streamWindow) state.streamWindow = normalizeStreamWindow(raw.streamWindow);
  if (raw.experimental !== undefined) state.experimental = normalizeExperimental(raw.experimental);
}

function currentSnapshot() {
  return {
    maintenance: state.maintenance,
    news: state.news,
    sources: state.sources,
    streamOverride: state.streamOverride,
    streamWindow: state.streamWindow,
    experimental: state.experimental
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
  const news = readLocalJson(LEGACY_FILES.news);
  const sources = readLocalJson(LEGACY_FILES.sources);
  const streamOverride = readLocalJson(LEGACY_FILES.streamOverride);
  const streamWindow = readLocalJson(LEGACY_FILES.streamWindow);
  if (maintenance) state.maintenance = normalizeMaintenance(maintenance);
  if (news) state.news = normalizeNews(news);
  if (sources) state.sources = normalizeSources(sources);
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
    lastStateWrite = { durable: false, store: fileStoreReady ? 'local' : 'memory' };
    return false;
  }

  const redisKeys = [
    CONTROL_REDIS_KEY,
    LEGACY_REDIS_KEYS.maintenance,
    LEGACY_REDIS_KEYS.news,
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
      if (values[2]) state.news = normalizeNews(values[2]);
      if (values[3]) state.sources = normalizeSources(values[3]);
      if (values[4]) state.streamOverride = normalizeOverride(values[4]);
      if (values[5]) state.streamWindow = normalizeStreamWindow(values[5]);
    }
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

let persistQueue = Promise.resolve();
function persistState() {
  const snapshot = currentSnapshot();
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
    redisConfigured: UPSTASH_ENABLED,
    localWritable: fileStoreReady
  };
}

function publicSources() {
  return { disabled: [...state.sources.disabled], updatedAt: state.sources.updatedAt };
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

function publicNews() {
  return state.news.filter(item => item.published && item.title && item.body)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
}

function adminNews() {
  return state.news.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function createNews(body = {}) {
  const item = normalizeNewsItem({ ...body, id: `news_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}` });
  if (!item.title) return { error: 'A headline is required.' };
  if (!item.body) return { error: 'An update is required.' };
  state.news.unshift(item);
  state.news = state.news.slice(0, MAX_NEWS_ITEMS);
  return { item };
}

function updateNews(id, patch = {}) {
  const index = state.news.findIndex(item => item.id === String(id));
  if (index < 0) return null;
  const existing = state.news[index];
  const item = normalizeNewsItem({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() }, index);
  if (!item.title || !item.body) return { error: 'A headline and update are required.' };
  state.news[index] = item;
  state.news.sort((a, b) => b.createdAt - a.createdAt);
  return { item };
}

function deleteNews(id) {
  const before = state.news.length;
  state.news = state.news.filter(item => item.id !== String(id));
  return before !== state.news.length;
}

function publicConfig() {
  return {
    maintenance: state.maintenance,
    news: PUBLIC_NEWS_ENABLED ? publicNews() : [],
    sources: publicSources(),
    streamOverride: publicOverride(),
    streamWindow: state.streamWindow,
    experimental: state.experimental
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
app.use(compression({ threshold: 1024 }));
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
  const origin = normalizeOrigin(req.headers.origin || '');
  const own = selfOrigin(req);
  res.setHeader('Vary', 'Origin');
  if (origin && origin !== own && !isPublicSiteOrigin(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '40kb' }));
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

let stateReady = loadSiteState();

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/site/config', async (_req, res) => {
  await stateReady;
  res.setHeader('Cache-Control', `public, max-age=${SITE_CONFIG_MAX_AGE_SECONDS}`);
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

app.get('/api/help/config', async (_req, res) => {
  await helpTicketService.ready;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    available: helpTicketService.availability().available,
    categories: HELP_CATEGORIES,
    limits: { initialMessage: 4000, chatMessage: 2000, messagesPerMinute: 10 },
    uploadsEnabled: false,
  });
});

app.post('/api/help/tickets', async (req, res) => {
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
  const username = safeText(req.body?.username, 100);
  const password = String(req.body?.password || '').slice(0, 500);
  if (!isSafeEqual(username, ADMIN_USER) || !isSafeEqual(password, ADMIN_PASS)) {
    recordLoginFailure(req.loginIp);
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }
  loginAttempts.delete(req.loginIp);
  req.session = { isAdmin: true, loginAt: Date.now() };
  res.json({ success: true });
});

app.get('/admin/api/status', (req, res) => {
  res.json({ authenticated: Boolean(req.session?.isAdmin), loginAt: req.session?.loginAt || null });
});

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
app.use('/admin/api', adminSameOrigin, (req, res, next) => {
  if (req.path === '/login' || req.path === '/status') return next();
  return requireAdmin(req, res, next);
});

app.post('/admin/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/admin/api/config', async (_req, res) => {
  await stateReady;
  res.json({ ...publicConfig(), sourceList: FEED_SOURCES, adminNews: adminNews(), storage: storageSummary() });
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
  res.json({ success: true, override: state.streamOverride, ...persisted });
});
app.post('/admin/api/stream/stop', async (_req, res) => {
  await stateReady;
  state.streamOverride = { ...state.streamOverride, active: false, startedAt: null, updatedAt: Date.now() };
  const persisted = await persistState();
  res.json({ success: true, override: state.streamOverride, ...persisted });
});
app.post('/admin/api/stream/normal', async (_req, res) => {
  await stateReady;
  state.streamOverride = { active: false, input: null, url: null, type: null, startedAt: null, updatedAt: Date.now() };
  const persisted = await persistState();
  res.json({ success: true, override: state.streamOverride, ...persisted });
});

app.get('/admin/api/stream/sources', async (_req, res) => {
  await stateReady;
  res.json({ sources: FEED_SOURCES, ...state.sources, ...storageSummary() });
});
app.post('/admin/api/stream/sources', async (req, res) => {
  await stateReady;
  if (!Array.isArray(req.body?.disabled)) return res.status(400).json({ error: 'disabled must be an array of source IDs.' });
  const unknown = req.body.disabled.map(String).filter(id => !FEED_SOURCE_IDS.has(id));
  if (unknown.length) return res.status(400).json({ error: `Unknown source ID(s): ${unknown.join(', ')}` });
  state.sources = normalizeSources({ disabled: req.body.disabled, updatedAt: Date.now() });
  const persisted = await persistState();
  res.json({ success: true, sources: FEED_SOURCES, ...state.sources, ...persisted });
});

app.get('/admin/api/news', async (_req, res) => {
  await stateReady;
  res.json({ news: adminNews(), ...storageSummary() });
});
app.post('/admin/api/news', async (req, res) => {
  await stateReady;
  const result = createNews(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  const persisted = await persistState();
  res.status(201).json({ success: true, news: result.item, ...persisted });
});
app.patch('/admin/api/news/:id', async (req, res) => {
  await stateReady;
  const result = updateNews(req.params.id, req.body || {});
  if (!result) return res.status(404).json({ error: 'News item not found.' });
  if (result.error) return res.status(400).json({ error: result.error });
  const persisted = await persistState();
  res.json({ success: true, news: result.item, ...persisted });
});
app.delete('/admin/api/news/:id', async (req, res) => {
  await stateReady;
  if (!deleteNews(req.params.id)) return res.status(404).json({ error: 'News item not found.' });
  const persisted = await persistState();
  res.json({ success: true, ...persisted });
});

function sendAdminIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
}
app.get(['/admin', '/admin/', '/admin/login'], sendAdminIndex);
app.use('/admin', express.static(ADMIN_DIR, {
  index: false,
  fallthrough: true,
  etag: true,
  maxAge: PRODUCTION ? '1h' : 0,
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
}));

app.get('/', (_req, res) => res.redirect(302, `${SITE_URL}/`));
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
