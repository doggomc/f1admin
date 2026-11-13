'use strict';

/* Link resolution and health for stream providers — no Discord, no membership.
   ---------------------------------------------------------------------------
   GET /api/stream/resolve?path=ehgembxe/f596f98r-4089
     Follows the provider's redirect chain server-side and returns the final player URL.
     ehgembxe mints a JWT per request (302 -> /play/<jwe>), so the address cannot be stored
     in the bundle; it is fetched here, cached briefly, and handed to the browser.

   GET /api/stream/uhd
     The 4K channel from embdlol's directory, or the URL pinned in FOURK_URL.

   GET /api/stream/health
     Per-provider status. Only providers that actually answer with something meaningful are
     reported as live; a 200 that is really an error page is not counted as healthy.
   Resolver map and operational notes: docs/stream-resolver.md.
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

function packTextPayload(text, prevPack = null, { brotliQuality = 6, gzipLevel = 9 } = {}) {
  const str = String(text || '');
  if (prevPack && prevPack.text === str) return prevPack;
  const raw = Buffer.from(str, 'utf8');
  const seqMatch = str.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  const hash = crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 14);
  const etag = seqMatch ? `"s${seqMatch[1]}-${hash.slice(0, 8)}"` : `"${hash}"`;
  const gzip = zlib.gzipSync(raw, { level: gzipLevel });
  const br = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
    }
  });
  return { text: str, raw, gzip, br, etag };
}

const EMBDLOL_STRUCT = 'https://api.embdlol.st/struct';
const EMBDLOL_EMBED = 'https://embdlol.st/embed/';
/* embdlol names its F1 channels per event: f1friuhd, f1mexicosatuhd, f1vegasuhd...  So the UHD
   channel is matched by shape, never by a fixed name — a fixed name is what made the 4K chip
   report "not upstream" while a 4K channel was sitting in the directory. */
const UHD_CHANNEL_NAME = 'f1friuhd';                 // kept for the summary output

/* F1 channel names, normalised to the feed they carry, whichever event prefix or separator they use
   (e.g. 'f1mexicosatuhd' OR 'F1 - Sao Paulo - Saturday - UHD' / 'ATV' / 'Sky' / 'DAZN' / 'SkyIT' / 'SkyDE'). */
const FEED_SUFFIXES = [
  'fullhd1', 'fullhd2', 'fullhd3',
  'italian', 'spanish', 'german',
  'skyita', 'skydeu', 'skyit', 'skyde', 'skyuk',
  'appletv', 'apple', 'f1tv', 'world', 'dazn',
  'atv', 'sky', 'esp', 'ita', 'deu', 'uhd', '4k'
];
const FEED_PATTERN = new RegExp(`^f1[a-z0-9]*?(${FEED_SUFFIXES.join('|')})$`);
const FEED_ALIASES = {
  fullhd2: 'fullhd3',
  skyuk: 'sky',
  atv: 'apple',
  appletv: 'apple',
  f1tv: 'apple',
  skyita: 'skyit',
  skydeu: 'skyde',
  esp: 'spanish',
  ita: 'italian',
  deu: 'german',
  skyit: 'skyit',
  skyde: 'skyde',
  '4k': 'uhd'
};
function feedKey(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw || /(?:360|480|540)p\b/.test(raw)) return '';
  if (/^(?:f[234]\b|formula\s*[234e]\b)/.test(raw)) return '';
  const flat = raw.replace(/^formula[\s_-]*1\b/, 'f1').replace(/[\s_-]+/g, '');
  if (!/^[a-z0-9]+$/.test(flat)) return '';
  if (FEED_SUFFIXES.includes(flat)) return FEED_ALIASES[flat] || flat;
  const match = flat.match(FEED_PATTERN);
  return match ? (FEED_ALIASES[match[1]] || match[1]) : '';
}
const isUhdChannel = (name) => feedKey(name) === 'uhd';
/* The provider may list dated recordings next to a row explicitly marked live. */
function isEmbdlolRecording(name) {
  const text = String(name || '').toLowerCase();
  return !/live/.test(text) && /(mon|tue|wed|thu|fri|sat|sun|replay|highlights)/.test(text);
}
const CDNLIVE_CATALOGUE = 'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free';

/* How long the published channel list is trusted. This used to be 30 minutes, which is far too
   long around a session: embdlol publishes its F1 feeds minutes before they matter and drops them
   afterwards, so a half-hour cache reported 'no channel' for the first half hour of the race.
   Also used as the ceiling for a resolved 4K address. */
/* Overridable so the guard can be exercised without waiting two minutes in a test. */
const CHANNEL_REFRESH_MS = Number(process.env.EMBDLOL_REFRESH_MS) || 2 * 60_000;
const UHD_REFRESH_MS = CHANNEL_REFRESH_MS;
/* How long an address that DID resolve stays trusted. Ids rotate per session. */
const UHD_RESOLVED_TTL_MS = 5 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
/* ehgembxe mints a JWT that dies after ~15-30 seconds (measured: 200 at t+15s, 403 'Link Expired'
   at t+30s), so a five-minute cache guaranteed every visitor got a dead address. A resolved dynamic
   address is now only trusted for a few seconds, and the player is expected to mint at click time. */
const RESOLVE_TTL_MS = 8_000;
const HEALTH_TTL_MS = 120_000;
const FETCH_TIMEOUT_MS = 9000;
const HEALTH_TIMEOUT_MS = 6000;

/* ehgembxe paths are opaque to the client, so they are allowlisted here instead. */
const WIKISPORT_PAGES = Object.freeze({
  'wikisport/1': 'https://wikisport.info/strm/f1.php',
  'wikisport/2': 'https://wikisport.info/fsl/f1s2.php',
  'wikisport/3': 'https://wikisport.info/fsl/f1s3.php',
  'wikisport/4': 'https://wikisport.info/fsl/f1s4.php',
  'wikisport/5': 'https://wikisport.info/fsl/f1s5.php'
});
const DYNAMIC_ALLOWLIST = new Set(['ehgembxe/f596f98r-7758', 'ehgembxe/f596f98r-4089', 'ehgembxe/f596f98r-5690', ...Object.keys(WIKISPORT_PAGES)]);
const WIKISPORT_TARGETS = Object.freeze({
  'wikisport/1': ['siempreon.shop', /^\/fslivepro\.php$/i],
  'wikisport/2': ['taifood-blog.asia', /^\/embed\/[a-z0-9_/%-]+$/i],
  'wikisport/3': ['embedsports.me', /^\/streams\/[a-z0-9_-]+$/i],
  'wikisport/4': ['thedaddy.li', /^\/stream\/stream-[0-9]+\.php$/i],
  'wikisport/5': ['tvpclive.com', /^\/embed\/stream-[0-9]+\.php$/i]
});
function iframeSrc(html) {
  return String(html || '').match(/<iframe\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
}
function wikiTarget(path, raw) {
  const rule = WIKISPORT_TARGETS[path];
  if (!rule) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== rule[0] || url.port || url.username || url.password || url.hash || !rule[1].test(url.pathname)) return '';
    return url.href;
  } catch { return ''; }
}

/* The embdlol feeds whose commentary is not English. */
const EMB_OTHER = ['dazn', 'skyit', 'skyde', 'german', 'spanish', 'italian'];
/* A feed may only fail over to another feed of its own language — the old pool offered every F1
   feed, so the Spanish chip played English Sky. */
const EMB_LANG = { dazn: 'es', spanish: 'es', skyit: 'it', italian: 'it', skyde: 'de', german: 'de' };
/* `channels` is a Map when the catalogue answered and `false` when it did not — never assume a Map. */
const embPool = (feed, channels) => (channels instanceof Map ? [...channels] : [])
  .filter(([name]) => EMB_LANG[name] === EMB_LANG[feed]).map(([, id]) => id);

/* label + feed key for each embdlol chip, in the same order as the player's row. 'sky' and 'apple'
   are gone: embdlol publishes ONE English F1 channel (today f1mexicofullhd1/3) and those two chips
   could never resolve to anything the fullhd chips do not, so they were empty for their whole life. */
const EMB_FEEDS = [['fullhd1', 'Full HD 1'], ['fullhd3', 'Full HD 3'], ['dazn', 'DAZN ES'],
  ['skyit', 'Sky Italia'], ['skyde', 'Sky DE'], ['world', 'F1 World'], ['german', 'German'],
  ['spanish', 'Spanish'], ['italian', 'Italian']];

/* weelo relays the onboards and the data channel: one id per feed, and /players/state.json says
   whether it is up. That file refuses cross-origin requests (it answers only on weelo.live itself),
   so the server reads it and the browser asks /api/stream/weelo instead. `tab` is the English/Other filter the player draws; `special` keeps these out
   of the broadcaster run and in their own block. */
const WEELO_STATE = 'https://weelo.live/players/state.json';
/* The feed is the truth: this URL is an HLS master playlist whenever the stream is up. */
const WEELO_FEED = 'https://weelo.live/';

/* PPV publishes the Formula 1 stream list at https://api.ppv.st/api/streams: a main HD stream
   (Sky Sports F1) plus a substreams[] list per broadcaster in both HD and SD (_540p). Every 540p /
   SD variant is excluded so only >=720p PPV streams are ever served or shown in Race Control. */
const PPV_STREAMS = 'https://api.ppv.st/api/streams';
const TAIFOOD_CHANNELS_FALLBACKS = [
  'https://cdn.flive.cc.cd/channels.json'
];
/* PPV groups its substreams by the first word of the broadcaster name; this is which bucket and
   commentary language each PPV chip reads, mirroring netlifyf1/src/app.ts. */
const TAIFOOD_BUCKET = { appletv: 'apple', dazn: 'dazn', viaplay: 'viaplay', 'sky-italia': 'sky',
  'sky-de': 'sky', 'v-sport': 'v', sport: 'v', eleven: 'eleven', nova: 'nova' };
const PPV_CHIP_LANG = {
  ppv: 'english',
  appletv: 'english',
  dazn: 'spanish',
  viaplay: 'dutch',
  'sky-italia': 'italian',
  'sky-de': 'german',
  'v-sport': 'swedish',
  eleven: 'polish',
  nova: 'czech'
};
const PPV_LOCALE_MAP = {
  en: 'english', 'en-gb': 'english', 'en-us': 'english', 'en-au': 'english', 'en-ca': 'english', english: 'english',
  es: 'spanish', 'es-es': 'spanish', 'es-mx': 'spanish', spanish: 'spanish',
  nl: 'dutch', 'nl-nl': 'dutch', dutch: 'dutch',
  de: 'german', 'de-de': 'german', 'de-at': 'german', german: 'german',
  it: 'italian', 'it-it': 'italian', italian: 'italian',
  sv: 'swedish', 'sv-se': 'swedish', swedish: 'swedish',
  cs: 'czech', 'cs-cz': 'czech', cz: 'czech', czech: 'czech',
  pl: 'polish', 'pl-pl': 'polish', polish: 'polish'
};
function normalizePpvLang(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  if (!clean) return '';
  if (PPV_LOCALE_MAP[clean]) return PPV_LOCALE_MAP[clean];
  const base = clean.split(/[-_]/)[0] || '';
  return PPV_LOCALE_MAP[base] || clean;
}
function isPpv540p(item) {
  if (!item || typeof item !== 'object') return true;
  const uri = String(item.iframe || item.uri || '');
  const uriName = String(item.uri_name || '');
  const tag = String(item.source_tag || item.title || '');
  const name = String(item.name || '');
  if (/540p/i.test(uri) || /540p/i.test(uriName)) return true;
  if (/\b540p\b|^\s*SD\s*\|/i.test(tag) || /\b540p\b|^\s*SD\s*\|/i.test(name)) return true;
  return false;
}
const PPV_F1_PATTERNS = [
  /formula[\s-]?1|\bf1\b|grand\s?prix/i,
  /\/embed\/f1\//i,
  /---(?:race|qualifying|sprint|practice)[-\w]*/i
];
const PPV_NON_F1_SERIES = /\b(?:moto\s*gp|moto\s*[23]|formula\s*[23e]\b|f[23]\s+championship|indycar|nascar|supercars|wrc|wec)\b/i;
const WEELO_PLAYER = 'https://weellz.live/beta?stream=';
const WEELLZ_BETA_URL = 'https://weellz.live/beta';
const REWND_KEY_BASE = 'https://rewnd.live/k/';
const WEELO_STRIPPED_EMBED = '/api/stream/weellz-embed?stream=';
const EMBDLOL_STRIPPED_EMBED = '/api/stream/embdlol-embed?id=';
const STRMFREE_STRIPPED_EMBED = '/api/stream/strmfree-embed';
const PPV_STRIPPED_EMBED = '/api/stream/ppv-embed';
const PPV_DEFAULT_HOST = 'taifood-blog.asia';
const PPV_ALLOWED_HOSTS = new Set([PPV_DEFAULT_HOST]);
const PPV_MASTER_TTL_MS = 8 * 60_000;
const PPV_MASTER_M3U8_TTL_MS = 30_000;
const PPV_M3U8_TTL_MS = 2_200;
const PPV_WORKER_IDLE_MS = 10 * 60_000;

let sharedImpit = null;
function getPpvBrowserClient(timeoutMs = 8_000) {
  if (!sharedImpit) {
    const { Impit } = require('impit');
    sharedImpit = new Impit({ browser: 'chrome', timeout: timeoutMs });
  }
  return sharedImpit;
}
const STRMFREE_HOSTS = ['strmfree.st', 'streamfree.top'];
const STRMFREE_VARIANTS = ['skyf11080p', 'skyf1'];
const STRMFREE_MODES = new Set(['live', 'live-cdn', 'live-externalcdn']);
const STRMFREE_HTML_TTL_MS = 10 * 60_000;
const STRMFREE_M3U8_TTL_MS = 2_800;
const WEELLZ_HTML_TTL_MS = 15 * 60_000;
const WEELLZ_KEY_TTL_MS = 2 * 60 * 60_000;
const WEELLZ_KEY_MAX_ENTRIES = 500;

function isSafePublicHostname(host) {
  const clean = String(host || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(clean)) return false;
  if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(clean)) return false;
  if (/\.(?:local|internal|localhost)$/.test(clean)) return false;
  return true;
}

function registerAllowedPpvHost(rawHost) {
  const clean = String(rawHost || '').trim().toLowerCase().replace(/^www\./, '');
  if (isSafePublicHostname(clean)) PPV_ALLOWED_HOSTS.add(clean);
}

function normalizePpvHost(rawHost) {
  const clean = String(rawHost || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return PPV_ALLOWED_HOSTS.has(clean) ? clean : PPV_DEFAULT_HOST;
}

function normalizePpvSlug(rawSlug) {
  const clean = String(rawSlug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!clean || clean.length > 160 || /540p|\.\.|[\s?#\\]/i.test(clean)) return '';
  if (/^f1\/20\d\d\/[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(clean)) return clean;
  if (/^[a-z0-9][a-z0-9_-]{1,150}$/i.test(clean)) return clean;
  return '';
}

function toStrippedPpvUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!isSafePublicHostname(host)) return '';
    const match = parsed.pathname.match(/^\/embed\/(.+)$/i);
    if (!match) return '';
    const slug = normalizePpvSlug(match[1]);
    if (!slug) return '';
    registerAllowedPpvHost(host);
    return `${PPV_STRIPPED_EMBED}?slug=${encodeURIComponent(slug)}&host=${encodeURIComponent(host)}`;
  } catch (_) {
    return '';
  }
}

function buildPpvStrippedHtml(rawSlug, rawHost = PPV_DEFAULT_HOST) {
  const slug = normalizePpvSlug(rawSlug);
  if (!slug) return '';
  const host = String(rawHost || '').trim()
    ? (PPV_ALLOWED_HOSTS.has(String(rawHost).trim().toLowerCase()) ? String(rawHost).trim().toLowerCase() : '')
    : PPV_DEFAULT_HOST;
  if (!host) return '';
  const m3u8Path = `/api/stream/ppv-m3u8/index.m3u8?slug=${encodeURIComponent(slug)}&host=${encodeURIComponent(host)}`;
  const safePathJson = JSON.stringify(m3u8Path);
  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>',
    '<link rel="preconnect" href="https://p16-common-sign.tiktokcdn.com" crossorigin>',
    `<script>try{fetch(window.location.origin+${safePathJson},{credentials:"omit"}).catch(function(){});}catch(_){}</script>`,
    '<title>FreeF1 Live Feed</title>',
    '<style>',
    'html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}',
    '#player{width:100%;height:100%;display:block;background:#000;object-fit:contain;outline:none}',
    '#err{display:none;position:fixed;inset:0;align-items:center;justify-content:center;background:#000;color:rgba(255,255,255,.78);font:500 14px/1.45 Inter,system-ui,sans-serif;text-align:center;padding:20px;z-index:5}',
    '</style>',
    '</head><body>',
    '<video id="player" controls autoplay playsinline></video><div id="err"></div>',
    '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>',
    '<script>(function(){',
    'window.open=function(){return null;};',
    'var video=document.getElementById("player");',
    'var params=new URLSearchParams(window.location.search||window.location.hash.slice(1));',
    "var startMuted=params.get('mute')==='1'||params.get('tile')==='side';",
    'video.muted=startMuted;',
    'function setErr(msg){var el=document.getElementById("err");if(el){el.textContent=msg;el.style.display="flex";}}',
    'function applyMute(m){startMuted=Boolean(m);video.muted=startMuted;}',
    'window.addEventListener("message",function(ev){try{var d=typeof ev.data==="string"?JSON.parse(ev.data):ev.data;if(!d)return;if(d.type==="freef1-audio"){applyMute(Boolean(d.muted));}else if(d.source==="pitsport-host"&&d.command==="tile"){applyMute(d.tile==="side");}}catch(_){}});',
    `var src=window.location.origin+${safePathJson};`,
    'function tryPlay(){var p=video.play();if(p&&typeof p.catch==="function"){p.catch(function(){video.muted=true;video.play().catch(function(){});});}}',
    'if(window.Hls&&window.Hls.isSupported()){',
    'var BaseLoader=window.Hls.DefaultConfig.loader;',
    'function TsSyncLoader(cfg){BaseLoader.call(this,cfg);}',
    'TsSyncLoader.prototype=Object.create(BaseLoader.prototype);',
    'TsSyncLoader.prototype.constructor=TsSyncLoader;',
    'TsSyncLoader.prototype.load=function(context,config,callbacks){',
    'var origSuccess=callbacks.onSuccess;',
    'callbacks.onSuccess=function(response,stats,ctx,net){',
    'if(response&&response.data instanceof ArrayBuffer){',
    'var u8=new Uint8Array(response.data);',
    'if(u8.length>564&&u8[0]!==0x47){',
    'for(var i=0;i<=512&&i+376<u8.length;i++){',
    'if(u8[i]===0x47&&u8[i+188]===0x47&&u8[i+376]===0x47){response.data=response.data.slice(i);break;}',
    '}}}',
    'return origSuccess.call(this,response,stats,ctx,net);',
    '};',
    'return BaseLoader.prototype.load.call(this,context,config,callbacks);',
    '};',
    'var netRetries=0,mediaRetries=0;',
    'var hls=new window.Hls({fLoader:TsSyncLoader,enableWorker:true,lowLatencyMode:false,startFragPrefetch:true,liveSyncDurationCount:2,liveMaxLatencyDurationCount:5,backBufferLength:8,maxBufferLength:12,maxMaxBufferLength:20});',
    'hls.loadSource(src);',
    'hls.attachMedia(video);',
    'hls.on(window.Hls.Events.MANIFEST_PARSED,function(){applyMute(startMuted);tryPlay();});',
    'hls.on(window.Hls.Events.ERROR,function(_e,data){',
    'if(!data||!data.fatal)return;',
    'if(data.type===window.Hls.ErrorTypes.NETWORK_ERROR&&netRetries<3){netRetries++;setTimeout(function(){hls.startLoad();},800);return;}',
    'if(data.type===window.Hls.ErrorTypes.MEDIA_ERROR&&mediaRetries<2){mediaRetries++;hls.recoverMediaError();return;}',
    'setErr("Stream is currently offline");',
    '});',
    '}else if(video.canPlayType("application/vnd.apple.mpegurl")){',
    'video.src=src;video.addEventListener("loadedmetadata",function(){applyMute(startMuted);tryPlay();});',
    '}else{setErr("HLS playback unsupported in this browser");}',
    '})();</script>',
    '</body></html>'
  ].join('');
}

let sharedPpvWorker = null;
let sharedPpvSeq = 0;
let sharedPpvIdleTimer = null;
const sharedPpvPending = new Map();

function resetSharedPpvWorker(reason = 'Worker terminated') {
  if (sharedPpvIdleTimer) {
    clearTimeout(sharedPpvIdleTimer);
    sharedPpvIdleTimer = null;
  }
  const w = sharedPpvWorker;
  sharedPpvWorker = null;
  if (w) {
    try { w.terminate(); } catch (_) {}
  }
  for (const [, entry] of sharedPpvPending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: reason });
  }
  sharedPpvPending.clear();
}

function touchSharedPpvIdle() {
  if (sharedPpvIdleTimer) clearTimeout(sharedPpvIdleTimer);
  sharedPpvIdleTimer = setTimeout(() => {
    if (sharedPpvPending.size === 0) resetSharedPpvWorker('Idle timeout');
  }, PPV_WORKER_IDLE_MS);
  if (sharedPpvIdleTimer && typeof sharedPpvIdleTimer.unref === 'function') {
    sharedPpvIdleTimer.unref();
  }
}

function resolvePpvViaWorker(embedOrigin, slug, { forceRefresh = false, timeoutMs = 10_000 } = {}) {
  if (!sharedPpvWorker) {
    const worker = new Worker(path.join(__dirname, 'ppv-wasm-worker.js'));
    if (typeof worker.unref === 'function') worker.unref();
    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const pending = sharedPpvPending.get(msg.id);
      if (!pending) return;
      sharedPpvPending.delete(msg.id);
      clearTimeout(pending.timer);
      touchSharedPpvIdle();
      pending.resolve(msg);
    });
    worker.on('error', (err) => resetSharedPpvWorker(err?.message || 'WASM worker error'));
    worker.on('exit', () => {
      if (sharedPpvWorker === worker) resetSharedPpvWorker('WASM worker exited');
    });
    sharedPpvWorker = worker;
  }
  touchSharedPpvIdle();
  return new Promise((resolve) => {
    const id = ++sharedPpvSeq;
    const timer = setTimeout(() => {
      sharedPpvPending.delete(id);
      resolve({ ok: false, error: 'PPV WASM resolution timed out.' });
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    sharedPpvPending.set(id, { resolve, timer });
    sharedPpvWorker.postMessage({ id, embedOrigin, slug, forceRefresh });
  });
}

function normalizeStrmfreeHost(rawHost) {
  const clean = String(rawHost || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return STRMFREE_HOSTS.includes(clean) ? clean : STRMFREE_HOSTS[0];
}

function normalizeStrmfreeVariant(rawVariant) {
  const clean = String(rawVariant || '').trim().toLowerCase();
  return STRMFREE_VARIANTS.includes(clean) ? clean : '';
}

function toStrippedStrmfreeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!STRMFREE_HOSTS.includes(host)) return '';
    const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (/2160p|540p/i.test(slug)) return '';
    const variant = normalizeStrmfreeVariant(slug) || 'skyf11080p';
    return `${STRMFREE_STRIPPED_EMBED}?variant=${encodeURIComponent(variant)}&host=${encodeURIComponent(host)}`;
  } catch (_) {
    return '';
  }
}

function parseStrmfreeTokens(rawHtml) {
  const match = String(rawHtml || '').match(/const\s+_0x\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function stripStrmfreeHtml(rawHtml, { host = 'strmfree.st' } = {}) {
  const safeHost = normalizeStrmfreeHost(host);
  let html = String(rawHtml || '');
  /* Strip Adcash 620KB popunder script (/analytics.js), inline aclib.runPop(...),
     periodic /ad.html injector, and <object id="sandDetect"> anti-sandbox trap. */
  html = html.replace(/<script\b[^>]*\bsrc=["']\/analytics\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi, '');
  html = html.replace(/<script\b[^>]*>[\s\S]*?aclib\.runPop[\s\S]*?<\/script>/gi,
    '<script>window.__isOwnSite=true;window.open=function(){return null;};</script>');
  html = html.replace(/window\.sandDetect\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/g, 'window.sandDetect = () => {};');
  html = html.replace(/<object\b[^>]*\bid=["']sandDetect["'][^>]*>[\s\S]*?<\/object>/gi, '');
  html = html.replace(/\(\(\)=>\{let a=\(\)=>\{document\.body\.insertAdjacentHTML\([\s\S]*?\/ad\.html[\s\S]*?\}\)\(\);/g, '');
  /* Route the tiny .m3u8 playlist fetch through f1admin (/api/stream/strmfree-m3u8/:mode/:variant/index.m3u8)
     so server-fetched _0x tokens always match the playlist requester's IP and auto-refresh on expiry,
     while keeping '/live-externalcdn/' in the path so JWPlayer selects its TikTok direct-segment mode. */
  const hostParam = `host=${encodeURIComponent(safeHost)}`;
  html = html.replace(/url\s*=\s*`\/(live(?:-externalcdn|-cdn)?)\/\$\{VARIANT\}\/index\.m3u8`/g,
    `url = \`\${window.location.origin}/api/stream/strmfree-m3u8/$1/\${VARIANT}/index.m3u8?${hostParam}\``);
  html = html.replace(/url\s*\+=\s*`\?_t=\$\{p\._t\}&_e=\$\{p\._e\}&_n=\$\{p\._n\}`/g,
    'url += `&_t=${p._t}&_e=${p._e}&_n=${p._n}`');
  html = html.replace(/return\s*`\/live\/\$\{VARIANT\}\/index\.m3u8`/g,
    `return \`\${window.location.origin}/api/stream/strmfree-m3u8/live/\${VARIANT}/index.m3u8?${hostParam}\``);
  html = html.replace(/const\s+AUTOSTART\s*=\s*getAutostartFromURL\(\);/g, 'const AUTOSTART = true;');
  html = html.replace(/mute:\s*false\s*,/g, "mute: new URLSearchParams(window.location.search).get('mute') === '1',");

  const headShim = `<base href="https://${safeHost}/"><meta name="referrer" content="no-referrer"><link rel="preconnect" href="https://p16-common-sign.tiktokcdn.com" crossorigin>`;
  html = html.replace(/<head\b[^>]*>/i, (m) => `${m}${headShim}`);

  const bodyShim = [
    '<script>(function(){',
    'window.open=function(){return null;};',
    'var bound=false;',
    'function bindJw(){if(bound)return;try{if(typeof window.jwplayer==="function"){var p=window.jwplayer("jwplayer");if(p&&typeof p.on==="function"){bound=true;p.on("autostartNotAllowed",function(){try{p.setMute(true);p.play(true);}catch(_){}});return;}}}catch(_){}setTimeout(bindJw,250);}',
    'bindJw();',
    'window.addEventListener("message",function(ev){try{var d=typeof ev.data==="string"?JSON.parse(ev.data):ev.data;if(d&&d.type==="freef1-audio"){var m=Boolean(d.muted);if(typeof window.jwplayer==="function"){var p=window.jwplayer("jwplayer");if(p&&typeof p.setMute==="function")p.setMute(m);}document.querySelectorAll("video").forEach(function(v){v.muted=m;});}}catch(_){}});',
    '})();</script>'
  ].join('');
  return html.replace(/<\/body>/i, `${bodyShim}</body>`);
}

function extractEmbdlolId(rawUrlOrId) {
  const clean = String(rawUrlOrId || '').trim();
  if (!clean) return '';
  const match = clean.match(/\/embed\/([A-Za-z0-9_-]{4,80})(?:[/?#]|$)/i);
  const candidate = match ? match[1] : clean;
  return /^[A-Za-z0-9_-]{4,80}$/.test(candidate) ? candidate : '';
}

function toStrippedEmbdlolUrl(rawUrlOrId) {
  const id = extractEmbdlolId(rawUrlOrId);
  return id ? `${EMBDLOL_STRIPPED_EMBED}${encodeURIComponent(id)}` : '';
}

function buildEmbdlolStrippedHtml(watchId) {
  const cleanId = extractEmbdlolId(watchId);
  if (!cleanId) return '';
  const safeIdJson = JSON.stringify(cleanId);
  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="preconnect" href="https://api.embdlol.st" crossorigin>',
    '<link rel="preconnect" href="https://embdlol.st" crossorigin>',
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>',
    `<script>window.__f1WatchReq=fetch("https://api.embdlol.st/watch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({watchId:${safeIdJson}})});</script>`,
    '<title>FreeF1 Live Feed</title>',
    '<style>',
    'html,body,#player{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}',
    '#err{display:none;position:fixed;inset:0;align-items:center;justify-content:center;background:#000;color:rgba(255,255,255,.78);font:500 14px/1.45 Inter,system-ui,sans-serif;text-align:center;padding:20px}',
    '</style>',
    '</head><body>',
    '<div id="player"></div><div id="err"></div>',
    '<script src="https://embdlol.st/jwplayer.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/swarmcloud-jwplayer-hlsjs@0.1.3/dist/jwplayer.hlsjs.min.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/@swarmcloud/hls@2.18.0/hls.min.js"></script>',
    '<script>(function(){',
    'window.open=function(){return null;};',
    'var params=new URLSearchParams(window.location.search||window.location.hash.slice(1));',
    "var startMuted=params.get('mute')==='1'||params.get('tile')==='side';",
    'var pInstance=null;',
    'function setErr(msg){var el=document.getElementById("err");if(el){el.textContent=msg;el.style.display="flex";}}',
    'function applyMute(m){startMuted=Boolean(m);try{if(pInstance&&typeof pInstance.setMute==="function")pInstance.setMute(startMuted);}catch(_){}document.querySelectorAll("video").forEach(function(v){v.muted=startMuted;});}',
    'window.addEventListener("message",function(ev){try{var d=typeof ev.data==="string"?JSON.parse(ev.data):ev.data;if(!d)return;if(d.type==="freef1-audio"){applyMute(Boolean(d.muted));}else if(d.source==="pitsport-host"&&d.command==="tile"){applyMute(d.tile==="side");}}catch(_){}});',
    '(async function(){try{',
    `var res=await (window.__f1WatchReq||fetch("https://api.embdlol.st/watch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({watchId:${safeIdJson}})}));`,
    'if(!res.ok)throw new Error("Upstream feed returned "+res.status);',
    'var data=await res.json();',
    'if(!data||!data.url)throw new Error("Channel is currently offline");',
    'if(typeof window.jwplayer!=="function")throw new Error("Player library unavailable");',
    'window.jwplayer.key="uoW6qHjBL3KNudxKVnwa3rt5LlTakbko9e6aQ6VUyKQ=";',
    'if(window.jwplayer_hls_provider&&typeof window.jwplayer_hls_provider.attach==="function")window.jwplayer_hls_provider.attach();',
    'var chCode=data.channel&&data.channel.channelCode;',
    'var p2pCfg={logLevel:"error",p2pEnabled:true,live:true,announce:"https://ann.cdn-lab.shop/v1",token:"pitsport",channelId:function(u){if(chCode)return chCode;var m=String(u||"").match(/channel\\(([^)]+)\\)/);return m?m[1]:u;},startFromSegmentOffset:0,dcDownloadTimeout:45,httpLoadTime:7.5,trickleICE:true};',
    'pInstance=window.jwplayer("player").setup({file:data.url,width:"100%",height:"100%",type:"hls",autostart:true,mute:startMuted,hlsjsdefault:true,hlsjsConfig:{debug:false,p2pConfig:p2pCfg}});',
    'pInstance.on("ready",function(){applyMute(startMuted);});',
    'pInstance.on("autostartNotAllowed",function(){try{pInstance.setMute(true);pInstance.play(true);}catch(_){}});',
    '}catch(err){setErr(err&&err.message?err.message:"Stream unavailable");}})();',
    '})();</script>',
    '</body></html>'
  ].join('');
}
/* [key, label, special, id, tab]. Every id and language is from weelo's own event feed
   (weelo.live/feed/events.json): 'Multi-audio' feeds carry several commentaries, so they are Other. */
const WEELO_FEEDS = [
  ['kimi', 'Kimi Antonelli', 'onboard', 'peogcgpgbgchegaciclejgngjgacbeogehpgogfgmgmgjgjcacieee', 'en'],
  ['charles', 'Charles Leclerc', 'onboard', 'peogcgpgbgchegacicdeigbgchmgfgdhacmefgdgmgfgchdgjcacieee', 'en'],
  ['max', 'Max Verstappen', 'onboard', 'peogcgpgbgchegacicnebgihacgffgchdhehbgahahfgogjcacieee', 'en'],
  ['drivers', 'Drivers Track', 'onboard', 'gebdacefgfaciceechjgghfgchacefchbgdglgfgchjcacieee', 'en'],
  ['data', 'Data Channel', 'data', 'gebdacefgfaciceebgehbgacdeigbgogogfgmgjcacieee', 'en'],
  ['intl', 'International Feed', 'feed', 'jeogehfgchogbgehjgpgogbgmgacgefgfgegacicgebdjcacieee', 'other'],
  ['f1tvworld', 'F1 TV (World)', 'feed', 'gebdacefgfacieee', 'other'],
  ['skyweelo', 'Sky Sports (weelo)', 'feed', 'dflgjhacdfahpgchehacbdacoekfacieee', 'en'],
  ['shows', 'F1 TV (Shows)', 'feed', 'gebdacefgfacicdfigpghhdhjcacieee', 'en']
];

const { mutedAutoplayScript } = require('./weellz-autoplay');

function stripWeellzHtml(rawHtml) {
  let html = String(rawHtml || '');
  html = html.replace(/<template\b[^>]*\bid=["']rl-pu["'][^>]*>[\s\S]*?<\/template>/gi, '');
  html = html.replace(/<script\b[^>]*(?:capitalhospitals\.org|cloudflareinsights\.com)[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/\bfunction\s+rlGuard\s*\(/g, 'function _disabledRlGuard(');
  const shim = [
    '<base href="https://weellz.live/">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="preconnect" href="https://weelo.live" crossorigin>',
    '<script>(function(){',
    "if(window.location.hash.length>1&&window.location.search.indexOf('stream=')===-1){try{history.replaceState(null,'',window.location.pathname+'?'+window.location.hash.slice(1));}catch(_){}}",
    "var keyBase=window.location.origin+window.location.pathname.replace(/\\/weellz-embed\\/?$/,'/weellz-key/');",
    'var origOpen=XMLHttpRequest.prototype.open;',
    "XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&u.indexOf('https://rewnd.live/k/')===0){arguments[1]=keyBase+u.slice(21);}return origOpen.apply(this,arguments);};",
    "var origFetch=window.fetch;if(origFetch){window.fetch=function(i,o){if(typeof i==='string'&&i.indexOf('https://rewnd.live/k/')===0){i=keyBase+i.slice(21);}return origFetch.call(this,i,o);};}",
    'window.open=function(){return null;};',
    mutedAutoplayScript,
    "window.addEventListener('message',function(ev){try{var d=typeof ev.data==='string'?JSON.parse(ev.data):ev.data;if(d&&d.type==='freef1-audio'){var m=Boolean(d.muted);if(typeof window.jwplayer==='function'){var p=window.jwplayer();if(p&&typeof p.setMute==='function')p.setMute(m);}document.querySelectorAll('video').forEach(function(v){v.muted=m;});}}catch(_){}});",
    '})();</script>'
  ].join('');
  return html.replace(/<head\b[^>]*>/i, (match) => `${match}${shim}`);
}

/* taifood addresses are <event>---<session>-<id><mark>: the mark is part of the address, and the
   provider publishes several. SD is the base; the crisp mark is offered after it. The mark is a
   property of the address, not of the chip, so it is added here rather than on each link. */
const TAID_MARKS = ['SD', 'SD1080pHD'];
function taidUrl(event, session, id, mark) {
  const kebab = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://taifood-blog.asia/embed/${kebab(event)}---${kebab(session)}-${id}${mark}`;
}

/* The player's own source list, in the same order as `sources` in netlifyf1/src/app.ts.
   GET /api/stream/sources publishes it so Race Control and the player cannot drift apart: every
   chip the player draws is switchable here, and every switch here is drawn by the player.

   `minQuality` is the floor a link has to clear to appear in this provider's pool. */
const STREAM_SOURCES = [
  { id: 'sky-uk', label: 'Sky HD', main: true, stripped: true, provider: 'strmfree', minQuality: 720, tab: 'en', links: [
    { quality: 1080, url: `${STRMFREE_STRIPPED_EMBED}?variant=skyf11080p&host=strmfree.st` },
    { quality: 1080, url: `${STRMFREE_STRIPPED_EMBED}?variant=skyf11080p&host=streamfree.top` },
    { quality: 1080, url: `${STRMFREE_STRIPPED_EMBED}?variant=skyf1&host=strmfree.st` },
    { quality: 1080, url: `${STRMFREE_STRIPPED_EMBED}?variant=skyf1&host=streamfree.top` }
  ] },
  /* The feeds whose commentary is not English draw under the Other tab, in the player and here. */
  ...EMB_FEEDS.map(([feed, label]) => ({ id: `emb-${feed}`, label: `${label} (EMB)`, provider: 'embdlol', channel: feed, minQuality: 0, tab: EMB_OTHER.includes(feed) ? 'other' : 'en', links: [] })),
  { id: 'emb-uhd', label: 'F1 UHD 4K', provider: 'embdlol', channel: UHD_CHANNEL_NAME, minQuality: 0, tab: 'en', links: [] },
  /* Stripped (ad-free) counterparts of every EMB feed, relayed via /api/stream/embdlol-embed. */
  ...EMB_FEEDS.map(([feed, label]) => ({ id: `emb-stripped-${feed}`, label: `${label} (EMB Stripped)`, provider: 'embdlol-stripped', stripped: true, channel: feed, minQuality: 0, tab: EMB_OTHER.includes(feed) ? 'other' : 'en', links: [] })),
  { id: 'emb-stripped-uhd', label: 'F1 UHD 4K (Stripped)', provider: 'embdlol-stripped', stripped: true, channel: UHD_CHANNEL_NAME, minQuality: 0, tab: 'en', links: [] },
  /* Onboards and the data channel. `special` chips are drawn apart from the broadcasters. */
  ...WEELO_FEEDS.map(([id, label, special, weelo, tab]) => ({
    id: `weelo-${id}`, label, provider: 'weelo', weelo, special, tab, minQuality: 720,
    links: [{ quality: 1080, url: WEELO_PLAYER + weelo }]
  })),
  /* Stripped (ad-free) counterparts of every Weelo feed, relayed via /api/stream/weellz-embed. */
  ...WEELO_FEEDS.map(([id, label, special, weelo, tab]) => ({
    id: `weelo-stripped-${id}`, label: `${label} (Stripped)`, provider: 'weelo-stripped', stripped: true, weelo, special, tab, minQuality: 720,
    links: [{ quality: 1080, url: WEELO_STRIPPED_EMBED + weelo }]
  })),
  /* Works, but serves heavy advertising, so it sits below the EMB feeds. */
  { id: 'sky-f1-uk', label: 'Sky Sports F1 UK', provider: 'cdnlivetv', minQuality: 720, links: [
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sports%20F1%20FHD%20UK&code=&user=cdnlivetv&plan=free' },
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=DAZN%20F1%20FHD&code=&user=cdnlivetv&plan=free' },
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=Viaplay%20Sports%201%20FHD%20UK&code=&user=cdnlivetv&plan=free' },
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=Viaplay%20Sports%202%20FHD%20UK&code=&user=cdnlivetv&plan=free' }
  ] },
  { id: 'ehgembxe', label: 'Sky Sports F1 HD (EHG)', provider: 'ehgembxe', minQuality: 720, retryOnExpiry: true, links: [
    { quality: 1080, url: 'ehgembxe/f596f98r-7758' },
    { quality: 1080, url: 'ehgembxe/f596f98r-4089' },
    { quality: 1080, url: 'ehgembxe/f596f98r-5690' }
  ] },
  { id: 'sky-sports', label: 'Sky Sports', provider: 'hakunamatata', minQuality: 0, links: [
    { quality: 0, url: 'https://hakunamatata5.org/sky-main-event/clean.html' }
  ] },
  /* PPV streams built from https://api.ppv.st/api/streams (main HD feed + non-540p substreams).
     Fallback ids rotate every session, so they are only a parachute under the live PPV catalogue. */
  { id: 'ppv', label: 'Sky Sports (PPV)', provider: 'ppv', minQuality: 720, links: [{ quality: 1080, ppv: true }] },
  { id: 'appletv', label: 'AppleTV (PPV)', provider: 'ppv', minQuality: 720, links: [
    { quality: 1080, taid: 31865 }, { quality: 1080, taid: 31854 }
  ] },
  { id: 'dazn', label: 'DAZN (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31867 }, { quality: 1080, taid: 31856 }
  ] },
  { id: 'viaplay', label: 'Viaplay (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31871 }, { quality: 1080, taid: 31860 }
  ] },
  { id: 'sky-italia', label: 'Sky Sport Italia (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31869 }, { quality: 1080, taid: 31858 }
  ] },
  { id: 'sky-de', label: 'Sky Sport F1 DE (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31868 }, { quality: 1080, taid: 31857 }
  ] },
  { id: 'v-sport', label: 'V Sport Motor SE (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31870 }, { quality: 1080, taid: 31859 }
  ] },
  { id: 'eleven', label: 'Eleven Sports PL (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31873 }, { quality: 1080, taid: 31862 }
  ] },
  { id: 'nova', label: 'Nova Sport CZ (PPV)', provider: 'ppv', minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31872 }, { quality: 1080, taid: 31861 }
  ] },
  /* Stripped (ad-free) counterparts of every PPV feed, resolved server-side via gasm.wasm + /api/stream/ppv-embed. */
  { id: 'ppv-stripped', label: 'Sky Sports (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, links: [{ quality: 1080, ppv: true }] },
  { id: 'appletv-stripped', label: 'AppleTV (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, links: [
    { quality: 1080, taid: 31865 }, { quality: 1080, taid: 31854 }
  ] },
  { id: 'dazn-stripped', label: 'DAZN (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31867 }, { quality: 1080, taid: 31856 }
  ] },
  { id: 'viaplay-stripped', label: 'Viaplay (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31871 }, { quality: 1080, taid: 31860 }
  ] },
  { id: 'sky-italia-stripped', label: 'Sky Sport Italia (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31869 }, { quality: 1080, taid: 31858 }
  ] },
  { id: 'sky-de-stripped', label: 'Sky Sport F1 DE (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31868 }, { quality: 1080, taid: 31857 }
  ] },
  { id: 'v-sport-stripped', label: 'V Sport Motor SE (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31870 }, { quality: 1080, taid: 31859 }
  ] },
  { id: 'eleven-stripped', label: 'Eleven Sports PL (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31873 }, { quality: 1080, taid: 31862 }
  ] },
  { id: 'nova-stripped', label: 'Nova Sport CZ (PPV Stripped)', provider: 'ppv-stripped', stripped: true, minQuality: 720, tab: 'other', links: [
    { quality: 1080, taid: 31872 }, { quality: 1080, taid: 31861 }
  ] },
  /* Resolve the real player behind each WikiSport wrapper on demand; no WikiSport page is embedded. */
  ...[1, 2, 3, 4, 5].map(number => ({
    id: number === 1 ? 'wikisport' : `wikisport-${number}`,
    label: `WikiSport · Stream ${number}`, provider: 'wikisport', minQuality: 0,
    links: [{ quality: 0, addressing: 'dynamic', url: `wikisport/${number}` }]
  })),
  { id: 'westream', label: 'WeStream F1', provider: 'westream', minQuality: 0, links: [
    { quality: 0, url: 'https://westreamf1.com/westreamf1.php' }
  ] }
];

/* A provider's published mirrors, used to grow a pool without a redeploy. */
const MIRROR_KEYS = { skyf1: ['https://strmfree.st', 'https://streamfree.top'] };

/* Providers worth probing, with the address a browser would actually request. */
const PROVIDER_PROBES = [
  { provider: 'strmfree', label: 'strmfree 1080p', url: 'https://strmfree.st/embed/racing/skyf11080p' },
  { provider: 'streamfree', label: 'streamfree 1080p', url: 'https://streamfree.top/embed/racing/skyf11080p' },
  { provider: 'westream', label: 'WeStream', url: 'https://westreamf1.com/westreamf1.php' },
  { provider: 'hakunamatata', label: 'hakunamatata', url: 'https://hakunamatata5.org/sky-main-event/clean.html' },
  { provider: 'ehgembxe', label: 'ehgembxe', url: 'https://ehgembxe.cfd/f596f98r-4089', follow: true }
];

function createStreamResolver({ log = console, fetchImpl = fetch, ppvResolveImpl = null } = {}) {
  const uhd = { url: '', at: 0, failedAt: 0 };
  const dynamic = new Map();      // path -> { url, at }
  const mirrorCache = new Map();  // stream key -> { at, list }
  let catalogueAt = 0;
  const weelo = { at: 0, state: {} };
  let catalogueChannels = {};
  let health = { at: 0, providers: {} };
  let healthInFlight = null;

  const override = () => String(process.env.DISCORD_4K_URL || process.env.FOURK_URL || '').trim();

  async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, redirect = 'follow', headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        redirect,
        signal: controller.signal,
        /* Several providers reject unfamiliar agents with a 502 (verified against ehgembxe),
           so the probe and resolver present as an ordinary browser. */
        headers: {
          Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          ...headers
        }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── 4K ─────────────────────────────────────────────────────────────── */
  async function resolveUhdUrl() {
    const pinned = override();
    if (pinned) return pinned;
    /* A resolved address is only trusted for a few minutes, not the half hour a channel list is.
       embdlol repoints its ids between sessions and drops them when the channel goes off air, and a
       pinned address outlived the session it belonged to: the chip played yesterday's id today. */
    if (uhd.url && Date.now() - uhd.at < UHD_RESOLVED_TTL_MS) return uhd.url;
    if (!uhd.url && uhd.failedAt && Date.now() - uhd.failedAt < RETRY_AFTER_FAILURE_MS) return '';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchWithTimeout(EMBDLOL_STRUCT);
        if (!response.ok) throw new Error(`struct responded ${response.status}`);
        const json = await response.json();
        const uhdChannels = (Array.isArray(json?.channels) ? json.channels : []).filter(entry => entry?.id && isUhdChannel(entry.channelname));
        const channel = uhdChannels.find(entry => !isEmbdlolRecording(entry.channelname)) || uhdChannels[0];
        if (channel?.id) {
          uhd.url = `${EMBDLOL_EMBED}${channel.id}`;
          uhd.at = Date.now();
          uhd.failedAt = 0;
          return uhd.url;
        }
        break; // the directory answered; the channel simply is not listed
      } catch (error) {
        log.warn?.(`[streams] embdlol struct attempt ${attempt + 1} failed:`, error.message);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    uhd.failedAt = Date.now();
    return uhd.url;
  }

  /* ── Race Control: what each chip would actually open ───────────────── */
  /* The dashboard could not show a chip's live address before this, because the address only exists
     after the catalogue is consulted (taifood ids rotate per session, embdlol ids per race, and weelo
     publishes its own). This resolves the same way the player does and reports what it found. */
  async function chipAddresses() {
    const [channels, uhdUrl, state, taifood, wiki] = await Promise.all([embdlolChannels(), resolveUhdUrl(), weeloState(), taifoodChannels().catch(() => ({})), Promise.all(Object.keys(WIKISPORT_PAGES).map(path => resolveDynamic(path)))]);
    const wikiUrls = Object.fromEntries(Object.keys(WIKISPORT_PAGES).map((path, i) => [path, wiki[i]?.url || '']));
    return STREAM_SOURCES.map((source) => {
      const addresses = [];
      /* A fixed list: the shipped addresses, already ordered. A taid entry is a PPV id, which
         only becomes an address once the session is known, so it is shown as the id it will ask for. */
      for (const link of source.links || []) {
        if (link.addressing === 'dynamic' && source.provider === 'wikisport') {
          const resolved = wikiUrls[link.url];
          if (resolved) addresses.push({ url: resolved, quality: link.quality || 0, from: 'provider embed' });
        } else if (link.url) addresses.push({ url: link.url, quality: link.quality || 0, from: 'shipped' });
        else if (link.taid) addresses.push({ url: `ppv id ${link.taid}`, quality: link.quality || 0, from: 'ppv-id' });
      }
      /* What https://api.ppv.st/api/streams publishes for this chip right now (never 540p). */
      if (source.provider === 'ppv' || source.provider === 'taifood' || source.provider === 'ppv-stripped') {
        const baseId = source.provider === 'ppv-stripped' ? source.id.replace(/-stripped$/, '') : source.id;
        const mapUri = (uri) => (source.provider === 'ppv-stripped' ? toStrippedPpvUrl(uri) : uri);
        const fromTag = source.provider === 'ppv-stripped' ? 'ppv-stripped' : 'ppv-live';
        if (baseId === 'ppv') {
          const mapped = taifood.ppv ? mapUri(taifood.ppv) : '';
          if (mapped) addresses.unshift({ url: mapped, quality: 1080, from: fromTag });
        } else {
          const bucketKey = TAIFOOD_BUCKET[baseId];
          const wantedLang = PPV_CHIP_LANG[baseId] || '';
          const bucket = (bucketKey && taifood.key && taifood.key[bucketKey]) || [];
          const live = bucket
            .filter((entry) => entry && entry.uri && !/540p/i.test(entry.uri) && (!wantedLang || !entry.lang || entry.lang === wantedLang))
            .sort((a, b) => Number(Boolean(wantedLang && b.lang === wantedLang)) - Number(Boolean(wantedLang && a.lang === wantedLang)));
          addresses.unshift(...live.map((entry) => ({ url: mapUri(entry.uri), quality: 1080, from: fromTag })).filter((entry) => Boolean(entry.url)));
        }
      }
      /* embdlol: the id for THIS feed, exactly as the player picks it. */
      if (source.provider === 'embdlol' && source.id !== 'emb-uhd') {
        const id = channels instanceof Map ? channels.get(source.channel) : null;
        if (id) addresses.unshift({ url: `${EMBDLOL_EMBED}${id}`, quality: 0, from: 'embdlol' });
      }
      if (source.provider === 'embdlol-stripped' && source.id !== 'emb-stripped-uhd') {
        const id = channels instanceof Map ? channels.get(source.channel) : null;
        if (id) addresses.unshift({ url: toStrippedEmbdlolUrl(id), quality: 0, from: 'embdlol-stripped' });
      }
      if (source.id === 'emb-uhd' && uhdUrl) addresses.unshift({ url: uhdUrl, quality: 2160, from: 'embdlol' });
      if (source.id === 'emb-stripped-uhd' && uhdUrl) {
        const strippedUhd = toStrippedEmbdlolUrl(uhdUrl);
        if (strippedUhd) addresses.unshift({ url: strippedUhd, quality: 2160, from: 'embdlol-stripped' });
      }
      /* weelo: one address, and only while weelo reports the feed as up. The address is kept in
         `wouldUse` so the admin panel can still show what the chip will ask for once it is live. */
      let wouldUse = '';
      if (source.weelo) {
        addresses.length = 0;
        wouldUse = source.stripped
          ? `${WEELO_STRIPPED_EMBED}${source.weelo}`
          : `https://weellz.live/beta?stream=${source.weelo}`;
        if (weeloUp(state, source.weelo) !== 'off') {
          addresses.push({ url: wouldUse, quality: 1080, from: source.stripped ? 'weelo-stripped' : 'weelo' });
        }
      }
      /* A chip with nothing resolvable still shows what it WOULD ask for, so it is debuggable. */
      return {
        id: source.id,
        addresses,
        current: addresses[0]?.url || '',
        wouldUse: wouldUse || addresses[0]?.url || '',
        online: Boolean(addresses.length),
        /* Why there is no address, in the chips' own terms. */
        state: source.weelo ? `weelo: ${weeloUp(state, source.weelo)}` : ''
      };
    });
  }

  /* ── published mirrors ──────────────────────────────────────────────── */
  /* Both domains of the mirror pair publish the addresses they consider live for a stream key.
     Cached for the health TTL; a domain that is down simply contributes nothing. */
  async function mirrorsFor(key) {
    const hosts = MIRROR_KEYS[key];
    if (!hosts) return [];
    const cachedMirrors = mirrorCache.get(key);
    if (cachedMirrors && Date.now() - cachedMirrors.at < HEALTH_TTL_MS) return cachedMirrors.list;
    const found = [];
    for (const host of hosts) {
      try {
        const response = await fetchWithTimeout(`${host}/api/v1/sources/${encodeURIComponent(key)}`, { timeoutMs: HEALTH_TIMEOUT_MS, headers: { Accept: 'application/json' } });
        if (!response.ok) continue;
        const json = await response.json();
        for (const entry of Array.isArray(json?.live_sources) ? json.live_sources : []) {
          const url = String(entry?.url || entry || '');
          const match = String(entry?.quality || '').match(/(\d{3,4})p/i);
          const quality = match ? Number(match[1]) : 0;
          if (!url.startsWith('https://') || quality < 720) continue;
          if (!found.some((item) => item.url === url)) found.push({ url, quality });
        }
      } catch (_) {
        /* Domain down: the static links still cover the source. */
      }
    }
    mirrorCache.set(key, { at: Date.now(), list: found });
    return found;
  }

  /* embdlol's channel names, refreshed hourly. A chip whose channel is not listed has no link. */
  async function embdlolChannels() {
    if (catalogueAt && Date.now() - catalogueAt < CHANNEL_REFRESH_MS) return catalogueChannels;
    try {
      const response = await fetchWithTimeout(EMBDLOL_STRUCT, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`struct responded ${response.status}`);
      const json = await response.json();
      const rows = Array.isArray(json?.channels) ? json.channels : [];
      /* The directory answers {"code":200,"channels":[]} when it has withdrawn its feeds, and it has
         done that for hours. An empty answer is therefore not news: it must not replace the last good
         map, or one blip blanks every EMB chip until the next refresh. */
      if (!rows.length) {
        if (!catalogueAt) catalogueAt = Date.now();   // remember we asked, so it is not re-polled flat out
        return catalogueChannels;
      }
      const next = new Map();
      for (const channel of rows) {
        const key = feedKey(channel?.channelname);
        if (!key || !channel?.id) continue;
        /* The directory can list the same feed twice: once as a finished catch-up recording and once
           as the live channel. The recording cannot be watched as live, so a name carrying a day
           prefix and no 'live' marker loses to a plain live row. */
        const recording = isEmbdlolRecording(channel.channelname);
        if (recording) {
          if (!next.has(key)) next.set(key, String(channel.id));
          continue;
        }
        next.set(key, String(channel.id));
      }
      /* When embdlol names its two English HD feeds 'Sky' and 'ATV'/'Apple' rather than
         'fullhd1'/'fullhd3', map them onto the two English HD chips. */
      if (next.has('sky') && !next.has('fullhd1')) next.set('fullhd1', next.get('sky'));
      if (next.has('apple') && !next.has('fullhd3')) next.set('fullhd3', next.get('apple'));
      catalogueChannels = next;
      catalogueAt = Date.now();
    } catch (_) {
      /* Directory unreachable: report unknown rather than claiming a channel is missing. */
    }
    return catalogueChannels;
  }

  /* Public EMB channel map for browser fallback when api.embdlol.st/struct is unreachable directly.
     Excludes 'uhd' so 4K stays behind /api/stream/uhd. */
  async function embdlolPublicChannels() {
    const map = await embdlolChannels();
    const channels = {};
    if (map instanceof Map) {
      for (const [key, id] of map.entries()) {
        if (key && key !== 'uhd' && id) channels[key] = id;
      }
    }
    return { channels, at: catalogueAt || null };
  }

  /* weelo publishes its own status map, and that map is the only trustworthy word on whether an
     onboard is on air. Its PLAYER at least says so itself: an offline feed renders "STREAM IS
     OFFLINE" and retries, while weelo's state.json says 'dark'. Both agree between sessions — so the
     chip reports weelo's state instead of pretending everything is live. The map is per-id, so a feed
     that is missing from it is 'unknown', never 'offline': weelo adds ids only while a session runs. */
  async function weeloState() {
    if (weelo.at && Date.now() - weelo.at < HEALTH_TTL_MS) return weelo.state;
    try {
      const response = await fetchWithTimeout(WEELO_STATE, { headers: { Accept: 'application/json' } });
      if (response.ok) {
        const json = await response.json();
        const next = {};
        for (const [id, status] of Object.entries(json || {})) {
          if (!id.startsWith('_') && typeof status === 'string') next[id] = status.trim().toLowerCase();
        }
        /* An empty map is not news (weelo serves {..} between rounds); keep the last good one. */
        if (Object.keys(next).length) {
          weelo.state = next;
          weelo.at = Date.now();
        }
      }
    } catch (_) {
      /* Unreachable: leave the chips reported as unknown rather than claiming they are down. */
    }
    return weelo.state;
  }

  /* weelo's word, in plain language: 'live', 'soon' (up shortly) or 'off' (dark/offline/unknown). */
  function weeloUp(state, id) {
    const status = String(state[id] || '');
    if (!status) return 'unknown';
    if (/^(live|on|online|up)$/.test(status)) return 'live';
    if (/^(soon|starting|scheduled)$/.test(status)) return 'soon';
    return 'off';
  }

  /* Every source the player draws, plus whatever the provider is publishing as live right now. */
  async function listSources() {
    const [skyMirrors, uhdUrl, channels, state] = await Promise.all([mirrorsFor('skyf1'), resolveUhdUrl(), embdlolChannels(), weeloState()]);
    const hasChannel = (key) => (channels instanceof Map ? channels.has(key) : false);
    const knownChannels = channels instanceof Map ? channels.size > 0 : false;
    return STREAM_SOURCES.map((source) => {
      let links = source.links.slice();
      if (source.id === 'sky-uk') {
        const strippedMirrors = skyMirrors
          .filter((mirror) => mirror.quality === 1080)
          .map((mirror) => ({ quality: 1080, url: toStrippedStrmfreeUrl(mirror.url) }))
          .filter((mirror) => mirror.url && !links.some((link) => link.url === mirror.url));
        links = [...links.filter((link) => link.quality === 1080), ...strippedMirrors];
      }
      return {
        id: source.id,
        label: source.label,
        provider: source.provider,
        main: Boolean(source.main),
        minQuality: source.minQuality,
        channels: source.channel ? [source.channel] : [],
        /* Which language the chip speaks, and the feed ids it may fail over to: same language only. */
        lang: EMB_LANG[source.channel] || 'en',
        pool: (source.provider === 'embdlol' || source.provider === 'embdlol-stripped') ? embPool(source.channel, channels) : [],
        /* The tab the player filters on, and whether the chip is drawn apart from the broadcasters. */
        tab: source.tab || 'en',
        special: source.special || null,
        stripped: Boolean(source.stripped),
        state: (source.provider === 'weelo' || source.provider === 'weelo-stripped') ? weeloUp(state, source.weelo) : null,
        links: links.map((link) => (link.taid ? { ...link, marks: TAID_MARKS, shape: taidUrl('{event}', '{session}', link.taid, '{mark}') } : link)),
        /* An EMB chip is only playable when its channel is listed upstream; the 4K chip has its
           own resolution path. Reporting this is what stops the site drawing dead EMB chips. */
        upstream: (source.provider === 'weelo' || source.provider === 'weelo-stripped')
          ? weeloUp(state, source.weelo) !== 'off'
          : (source.provider !== 'embdlol' && source.provider !== 'embdlol-stripped')
          ? true
          : (source.id === 'emb-uhd' || source.id === 'emb-stripped-uhd') ? Boolean(uhdUrl) : knownChannels ? hasChannel(source.channel) : null,
        /* Where the chip would play, so a client can also build the pool itself. */
        resolvedUrl: source.provider === 'embdlol' && knownChannels && hasChannel(source.channel)
          ? EMBDLOL_EMBED + channels.get(source.channel)
          : source.provider === 'embdlol-stripped' && knownChannels && hasChannel(source.channel)
          ? toStrippedEmbdlolUrl(channels.get(source.channel))
          : null
      };
    });
  }

  /* PPV's current F1 channel list built from https://api.ppv.st/api/streams (main HD stream +
     non-540p substreams across broadcasters). Every 540p / SD variant is dropped. */
  const taifood = { at: 0, list: [], key: {}, ppv: '' };
  async function taifoodChannels() {
    if (taifood.at && Date.now() - taifood.at < HEALTH_TTL_MS) return taifood;
    try {
      let builtFromPpv = false;
      try {
        const ppvRes = await fetchWithTimeout(PPV_STREAMS, { headers: { Accept: 'application/json' }, redirect: 'follow' });
        if (ppvRes.ok) {
          const ppvJson = await ppvRes.json();
          const nowSec = Math.floor(Date.now() / 1000);
          const groups = Array.isArray(ppvJson?.streams) ? ppvJson.streams : [];
          const f1Events = [];
          for (const group of groups) {
            const entries = Array.isArray(group?.streams) ? group.streams : (group && typeof group === 'object' ? [group] : []);
            for (const stream of entries) {
              if (!stream || typeof stream !== 'object') continue;
              const uri = String(stream.iframe || stream.uri || '');
              const tagAndTitle = `${stream.tag || ''} ${stream.name || ''}`;
              if (!/formula[\s-]?1|\bf1\b/i.test(String(stream.tag || '')) && PPV_NON_F1_SERIES.test(tagAndTitle)) continue;
              const haystack = [stream.name, stream.tag, stream.source_tag, stream.category_name, stream.uri_name, uri].join(' ');
              if (!PPV_F1_PATTERNS.some((pattern) => pattern.test(haystack))) continue;
              f1Events.push(stream);
            }
          }
          const scoreEvent = (ev) => {
            const s = Number(ev.starts_at) || 0;
            const e = Number(ev.ends_at) || 0;
            if (!s && !e) return [1, 0];
            if (s - 1800 <= nowSec && (e ? nowSec <= e + 1800 : nowSec <= s + 10800)) return [0, s];
            if (s > nowSec) return [1, s];
            return [2, -(e || s)];
          };
          f1Events.sort((a, b) => {
            const [ra, ta] = scoreEvent(a);
            const [rb, tb] = scoreEvent(b);
            return ra !== rb ? ra - rb : ta - tb;
          });
          const list = [];
          const key = {};
          const seen = new Set();
          let mainPpv = '';
          const extractEmbedHost = (rawUri) => {
            try {
              const u = new URL(rawUri);
              if (u.protocol !== 'https:' || !/^\/embed\/.+/i.test(u.pathname)) return '';
              const h = u.hostname.toLowerCase().replace(/^www\./, '');
              if (!isSafePublicHostname(h)) return '';
              registerAllowedPpvHost(h);
              return h;
            } catch (_) {
              return '';
            }
          };
          const addItem = (item) => {
            if (isPpv540p(item)) return;
            const uri = String(item.iframe || item.uri || '').trim();
            if (!extractEmbedHost(uri)) return;
            if (/\/embed\/f1\//i.test(uri)) return;
            const rawTag = String(item.source_tag || item.title || item.name || '');
            const name = rawTag.replace(/^\[Embed\]\s*/i, '').replace(/^(?:HD|FHD|UHD|4K)\s*\|\s*/i, '').replace(/\s*\[[^\]]+\]/, '').trim();
            const slug = keyWord(name);
            if (!slug || seen.has(`${slug}:${uri}`)) return;
            seen.add(`${slug}:${uri}`);
            const entry = {
              id: String(item.id || ''),
              name,
              lang: normalizePpvLang(item.locale || item.lang),
              uri,
              status: 'online'
            };
            list.push(entry);
            (key[slug] ||= []).push(entry);
          };
          for (const ev of f1Events) {
            const mainUri = String(ev.iframe || ev.uri || '').trim();
            if (!isPpv540p(ev) && extractEmbedHost(mainUri)) {
              if (!mainPpv) mainPpv = mainUri;
              addItem(ev);
            }
            for (const sub of Array.isArray(ev.substreams) ? ev.substreams : []) {
              addItem(sub);
            }
          }
          taifood.list = list;
          taifood.key = key;
          taifood.ppv = mainPpv;
          taifood.at = Date.now();
          builtFromPpv = true;
        }
      } catch { /* fall through to fallback mirror if PPV is unreachable */ }

      if (!builtFromPpv) {
        let response = null;
        for (const url of TAIFOOD_CHANNELS_FALLBACKS) {
          try {
            const candidate = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, redirect: 'follow' });
            if (candidate.ok) { response = candidate; break; }
          } catch { /* try the next mirror */ }
        }
        if (response) {
          const json = await response.json();
          const list = (Array.isArray(json) ? json : [])
            .filter((c) => c && typeof c.uri === 'string' && /taifood/.test(c.uri) && !isPpv540p(c))
            .map((c) => {
              const bare = String(c.title || '').replace(/^\[Embed\]\s*/i, '');
              const lang = (bare.match(/\[([^\]]+)\]/) || [])[1] || '';
              const name = bare.replace(/^(?:HD|FHD|UHD|4K)\s*\|\s*/i, '').replace(/\s*\[[^\]]+\]/, '').trim();
              return { id: String(c.id), name, lang: normalizePpvLang(lang), uri: c.uri, status: String(c.status || '').toLowerCase(), updatedAt: c.updated_at || '' };
            });
          const key = {};
          for (const entry of list) {
            const slug = keyWord(entry.name);
            if (slug) (key[slug] ||= []).push(entry);
          }
          taifood.list = list;
          taifood.key = key;
          taifood.at = Date.now();
        }
      }
    } catch (_) { /* keep the last good list */ }
    return taifood;
  }

  /* 'Apple TV (F1TV)' → 'apple', 'Sky Sport F1' → 'sky', 'V Sport Motor' → 'v'. A quality prefix
     ('HD | Apple TV …') and a leading '[Embed]' tag are not broadcaster names, so both are stripped
     first — without that, every 'HD | …' row bucketed under 'hd' and the chips never saw it. */
  function keyWord(name) {
    const cleaned = String(name || '')
      .replace(/^\[Embed\]\s*/i, '')
      .replace(/^(?:HD|FHD|UHD|4K|SD)\s*\|\s*/i, '')
      .replace(/\(.*?\)/g, ' ')
      .trim();
    const first = cleaned.toLowerCase().split(/\s+/)[0];
    return /^[a-z]+$/.test(first) ? first : '';
  }

  /* ── dynamic providers ──────────────────────────────────────────────── */
  async function resolveDynamic(path) {
    if (!DYNAMIC_ALLOWLIST.has(path)) return { url: '', code: 'unknown-provider' };

    const cached = dynamic.get(path);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return { url: cached.url, cached: true };

    if (WIKISPORT_PAGES[path]) {
      try {
        const first = await fetchWithTimeout(WIKISPORT_PAGES[path], { redirect: 'manual', timeoutMs: 4000 });
        if (!first.ok) return { url: '', code: `provider-${first.status}` };
        let src = iframeSrc(await first.text());
        if (path === 'wikisport/1' && src === 'https://wikisport.info/strm/30.php') {
          const nested = await fetchWithTimeout('https://wikisport.info/strm/30.php', { redirect: 'manual', timeoutMs: 4000 });
          if (!nested.ok) return { url: '', code: `provider-${nested.status}` };
          src = iframeSrc(await nested.text());
        }
        const url = wikiTarget(path, src);
        if (!url) return { url: '', code: 'unsupported-embed' };
        dynamic.set(path, { url, at: Date.now() });
        return { url, cached: false };
      } catch (error) {
        log.warn?.('[streams] WikiSport source lookup failed:', error.message);
        return { url: '', code: 'unreachable' };
      }
    }

    const origin = String(process.env.EHGEMBXE_ORIGIN || 'https://ehgembxe.cfd').replace(/\/+$/, '');
    const entry = `${origin}/${path.slice('ehgembxe/'.length)}`;
    try {
      /* The provider answers 302 -> /play/<jwt>; following it yields the player document. */
      const response = await fetchWithTimeout(entry, { redirect: 'follow' });
      const finalUrl = response.url || entry;
      if (!response.ok) return { url: '', code: `provider-${response.status}` };
      const body = await response.text();
      /* ehgembxe tells you when its token has lapsed, and an expired page also carries player
         links, so this is checked before anything else. The caller must ask again rather than
         replay a dead address. */
      if (/link\s+expired|token\s+expired|session\s+expired/i.test(body)) {
        dynamic.delete(path);
        return { url: '', code: 'link-expired', retry: true };
      }
      /* A player page carries a player library and a container; an error page does not. */
      const looksLikePlayer = /jwplatform|jwplayer|hls|video|player/i.test(body) && body.length > 2000;
      if (!looksLikePlayer) return { url: '', code: 'not-a-player' };
      dynamic.set(path, { url: finalUrl, at: Date.now() });
      return { url: finalUrl, cached: false };
    } catch (error) {
      log.warn?.('[streams] dynamic resolve failed:', error.message);
      return { url: '', code: 'unreachable' };
    }
  }

  /* ── health ─────────────────────────────────────────────────────────── */
  async function probe(entry) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(entry.url, { timeoutMs: HEALTH_TIMEOUT_MS });
      const latency = Date.now() - startedAt;
      if (!response.ok) return { status: 'offline', http: response.status, latency };
      const type = String(response.headers.get('content-type') || '');
      const body = await response.text();
      /* A player shell is a real page; a tiny body or an error string is not. */
      if (/text\/html/i.test(type) || body.startsWith('<')) {
        const isPlayer = /jwplayer|jwplatform|hls|clappr|video|player|m3u8/i.test(body);
        if (!isPlayer) return { status: 'unusable', http: response.status, latency, reason: 'no player in document' };
      }
      return { status: 'live', http: response.status, latency };
    } catch (error) {
      return { status: 'unreachable', latency: Date.now() - startedAt, reason: error.message };
    }
  }

  async function cdnLiveChannels() {
    try {
      const response = await fetchWithTimeout(CDNLIVE_CATALOGUE, { timeoutMs: HEALTH_TIMEOUT_MS });
      if (!response.ok) return {};
      const json = await response.json();
      const out = {};
      for (const channel of Array.isArray(json?.channels) ? json.channels : []) {
        const name = String(channel?.name || '');
        if (!/f1|formula/i.test(name)) continue;
        out[name] = { status: channel?.status === 'online' ? 'live' : 'offline', source: 'catalogue' };
      }
      return out;
    } catch (_) {
      return {};
    }
  }

  async function getHealth() {
    if (health.at && Date.now() - health.at < HEALTH_TTL_MS) return health;
    if (healthInFlight) return healthInFlight;

    healthInFlight = (async () => {
      const [probes, catalogue] = await Promise.all([
        Promise.all(PROVIDER_PROBES.map(async (entry) => [entry.label, await probe(entry)])),
        cdnLiveChannels()
      ]);
      const providers = Object.fromEntries(probes);
      for (const [name, info] of Object.entries(catalogue)) providers[`cdnlivetv:${name}`] = info;
      const [uhdUrl, uhdProbe] = await Promise.all([
        resolveUhdUrl(),
        Promise.resolve(null)
      ]);
      providers['embdlol:f1friuhd'] = uhdUrl
        ? { status: 'live', source: 'catalogue' }
        : { status: 'offline', source: 'catalogue', reason: 'channel not listed upstream' };
      health = { at: Date.now(), providers, uhdResolved: Boolean(uhdUrl) };
      return health;
    })();

    try {
      return await healthInFlight;
    } finally {
      healthInFlight = null;
    }
  }

  /* ── stripped weellz.live embed & 16-byte AES key relay ─────────────── */
  const weellzShell = { html: '', pack: null, at: 0, inFlight: null };
  const weellzKeys = new Map(); // key + token -> { body: Buffer, date: string, at: number }
  const weellzKeyInFlight = new Map();

  async function weellzStrippedHtml() {
    if (weellzShell.html && Date.now() - weellzShell.at < WEELLZ_HTML_TTL_MS) {
      return { html: weellzShell.html, pack: weellzShell.pack, cached: true };
    }
    if (weellzShell.inFlight) return weellzShell.inFlight;
    weellzShell.inFlight = (async () => {
      try {
        const response = await fetchWithTimeout(WEELLZ_BETA_URL, {
          headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
        });
        if (!response.ok) throw new Error(`weellz beta responded ${response.status}`);
        const raw = await response.text();
        if (!/<head\b/i.test(raw) || !/jwplayer|hls\.js/i.test(raw)) {
          throw new Error('unexpected weellz player payload');
        }
        const stripped = stripWeellzHtml(raw);
        weellzShell.html = stripped;
        weellzShell.pack = packTextPayload(stripped, weellzShell.pack, { brotliQuality: 11 });
        weellzShell.at = Date.now();
        return { html: stripped, pack: weellzShell.pack, cached: false };
      } catch (error) {
        if (weellzShell.html) return { html: weellzShell.html, pack: weellzShell.pack, cached: true, stale: true };
        throw error;
      } finally {
        weellzShell.inFlight = null;
      }
    })();
    return weellzShell.inFlight;
  }

  async function weellzAesKey(kid, token) {
    const cleanKid = String(kid || '').trim();
    const cleanToken = String(token || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(cleanKid)) {
      return { ok: false, status: 400, error: 'Invalid key id.' };
    }
    if (!/^[0-9]{4,14}\.[0-9a-f]{16,64}$/i.test(cleanToken)) {
      return { ok: false, status: 400, error: 'Invalid key token.' };
    }
    const cacheKey = `${cleanKid}:${cleanToken}`;
    const cached = weellzKeys.get(cacheKey);
    if (cached && Date.now() - cached.at < WEELLZ_KEY_TTL_MS) {
      return { ok: true, status: 200, body: cached.body, date: cached.date || new Date().toUTCString(), cached: true };
    }
    if (weellzKeyInFlight.has(cacheKey)) return weellzKeyInFlight.get(cacheKey);
    const task = (async () => {
    try {
      const target = `${REWND_KEY_BASE}${encodeURIComponent(cleanKid)}?t=${encodeURIComponent(cleanToken)}`;
      const response = await fetchWithTimeout(target, {
        headers: {
          Accept: '*/*',
          Origin: 'https://weellz.live',
          Referer: 'https://weellz.live/'
        }
      });
      const dateHeader = response.headers?.get?.('date') || new Date().toUTCString();
      if (!response.ok) {
        return { ok: false, status: response.status || 502, date: dateHeader };
      }
      const ab = await response.arrayBuffer();
      const body = Buffer.from(ab);
      if (body.length === 16) {
        if (weellzKeys.size >= WEELLZ_KEY_MAX_ENTRIES) {
          const oldest = weellzKeys.keys().next().value;
          if (oldest !== undefined) weellzKeys.delete(oldest);
        }
        weellzKeys.set(cacheKey, { body, date: dateHeader, at: Date.now() });
      }
      return { ok: true, status: 200, body, date: dateHeader, cached: false };
    } catch (error) {
      log.warn?.('[streams] weellz key relay failed:', error.message);
      return { ok: false, status: 502, error: 'Upstream key server unreachable.' };
    }
    })();
    weellzKeyInFlight.set(cacheKey, task);
    try { return await task; } finally { weellzKeyInFlight.delete(cacheKey); }
  }

  function summary() {
    return {
      channelName: UHD_CHANNEL_NAME,
      pinned: Boolean(override()),
      resolved: Boolean(uhd.url),
      cachedAt: uhd.at || null,
      lastFailureAt: uhd.failedAt || null,
      dynamicCached: dynamic.size
    };
  }

  const embdlolShells = new Map(); // cleanId -> { html, pack }
  function embdlolStrippedHtml(watchId) {
    const cleanId = extractEmbdlolId(watchId);
    if (!cleanId) return { ok: false, status: 400, error: 'A valid EMB channel id is required.' };
    const memo = embdlolShells.get(cleanId);
    if (memo) return { ok: true, status: 200, html: memo.html, pack: memo.pack };
    const html = buildEmbdlolStrippedHtml(cleanId);
    if (!html) return { ok: false, status: 400, error: 'A valid EMB channel id is required.' };
    const pack = packTextPayload(html, null, { brotliQuality: 11 });
    if (embdlolShells.size >= 120) embdlolShells.delete(embdlolShells.keys().next().value);
    embdlolShells.set(cleanId, { html, pack });
    return { ok: true, status: 200, html, pack };
  }

  /* ── stripped strmfree embed & lightweight .m3u8 playlist relay ────── */
  const strmfreeShells = new Map(); // `${host}:${variant}` -> { html, pack, tokens, activeHost, at }
  const strmfreeShellInFlight = new Map();
  const strmfreePlaylists = new Map(); // `${host}:${mode}:${variant}` -> { body, pack, at }
  const strmfreePlInFlight = new Map();

  function strmfreeTokensFresh(tokens) {
    if (!tokens || typeof tokens !== 'object') return true;
    const tok = tokens['1080p'] || tokens['720p'];
    if (!tok || !tok._e) return true;
    return Number(tok._e) * 1000 - Date.now() > 120_000;
  }

  async function fetchStrmfreeShell(variant, preferredHost, { forceRefresh = false } = {}) {
    const cleanVariant = normalizeStrmfreeVariant(variant || 'skyf11080p');
    if (!cleanVariant) return { ok: false, status: 400, error: 'Unsupported strmfree stream variant.' };
    const host = normalizeStrmfreeHost(preferredHost);
    const cacheKey = `${host}:${cleanVariant}`;
    const cached = strmfreeShells.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.at < STRMFREE_HTML_TTL_MS && strmfreeTokensFresh(cached.tokens)) {
      return { ok: true, status: 200, ...cached, cached: true };
    }
    if (!forceRefresh && strmfreeShellInFlight.has(cacheKey)) {
      return strmfreeShellInFlight.get(cacheKey);
    }
    const task = (async () => {
      const candidates = [host, ...STRMFREE_HOSTS.filter((h) => h !== host)];
      let lastErr = null;
      for (const candidateHost of candidates) {
        try {
          const upstreamUrl = `https://${candidateHost}/embed/racing/${cleanVariant}`;
          /* Do NOT send a self-Referer on /embed/racing/* — strmfree's nginx blocks self-referred
             embed requests with 403 {"detail":"Violation..."} while answering 200 without Referer. */
          const response = await fetchWithTimeout(upstreamUrl, {
            headers: {
              Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
            }
          });
          if (!response.ok) throw new Error(`${candidateHost} responded ${response.status}`);
          const raw = await response.text();
          if (!/<head\b/i.test(raw) || !/jwplayer|getStreamSource/i.test(raw)) {
            throw new Error(`unexpected ${candidateHost} player payload`);
          }
          const tokens = parseStrmfreeTokens(raw);
          const html = stripStrmfreeHtml(raw, { host: candidateHost });
          const pack = packTextPayload(html, cached?.pack, { brotliQuality: 9 });
          const entry = { html, pack, tokens, activeHost: candidateHost, variant: cleanVariant, at: Date.now() };
          strmfreeShells.set(cacheKey, entry);
          strmfreeShells.set(`${candidateHost}:${cleanVariant}`, entry);
          return { ok: true, status: 200, ...entry, cached: false };
        } catch (err) {
          lastErr = err;
        }
      }
      if (cached) return { ok: true, status: 200, ...cached, cached: true, stale: true };
      log.warn?.('[streams] strmfree stripped embed failed:', lastErr?.message || lastErr);
      return { ok: false, status: 503, error: 'Stripped strmfree player unavailable right now.' };
    })();
    strmfreeShellInFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      strmfreeShellInFlight.delete(cacheKey);
    }
  }

  async function strmfreeStrippedHtml(variant = 'skyf11080p', host = 'strmfree.st') {
    const res = await fetchStrmfreeShell(variant, host);
    if (res.ok && fetchImpl === fetch) {
      void strmfreePlaylist('live-externalcdn', variant, res.activeHost || host).catch(() => {});
    }
    return res;
  }

  async function strmfreePlaylist(mode, variant, preferredHost = 'strmfree.st') {
    const cleanMode = String(mode || '').trim().toLowerCase();
    const cleanVariant = normalizeStrmfreeVariant(variant);
    if (!STRMFREE_MODES.has(cleanMode) || !cleanVariant) {
      return { ok: false, status: 400, error: 'Invalid strmfree playlist parameters.' };
    }
    const host = normalizeStrmfreeHost(preferredHost);
    const plKey = `${host}:${cleanMode}:${cleanVariant}`;
    const cachedPl = strmfreePlaylists.get(plKey);
    if (cachedPl && Date.now() - cachedPl.at < STRMFREE_M3U8_TTL_MS) {
      return { ok: true, status: 200, body: cachedPl.body, pack: cachedPl.pack, cached: true };
    }
    if (strmfreePlInFlight.has(plKey)) return strmfreePlInFlight.get(plKey);

    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const shell = await fetchStrmfreeShell(cleanVariant, host, { forceRefresh: attempt > 0 });
        if (!shell.ok) return { ok: false, status: shell.status || 503, error: shell.error || 'Playlist unavailable.' };
        const activeHost = shell.activeHost || host;
        const qualityKey = cleanVariant.includes('720p') ? '720p' : '1080p';
        const tok = shell.tokens && (shell.tokens[qualityKey] || shell.tokens['1080p']);
        const qs = tok && tok._t && tok._e && tok._n
          ? `?_t=${encodeURIComponent(tok._t)}&_e=${encodeURIComponent(tok._e)}&_n=${encodeURIComponent(tok._n)}`
          : '';
        const upstreamM3u8 = `https://${activeHost}/${cleanMode}/${cleanVariant}/index.m3u8${qs}`;
        try {
          const res = await fetchWithTimeout(upstreamM3u8, {
            headers: {
              Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
              Origin: `https://${activeHost}`,
              Referer: `https://${activeHost}/embed/racing/${cleanVariant}`
            }
          });
          if (res.status === 403 && attempt === 0) continue; // refresh expired _0x token once
          if (!res.ok) return { ok: false, status: res.status || 502, error: 'Upstream playlist unavailable.' };
          const rawText = await res.text();
          if (!rawText.includes('#EXTM3U')) {
            return { ok: false, status: 502, error: 'Invalid upstream playlist.' };
          }
          const basePlaylistUrl = `https://${activeHost}/${cleanMode}/${cleanVariant}/index.m3u8`;
          const rewritten = rawText
            .split(/\r?\n/)
            .filter((line) => {
              const t = line.trim();
              return t && !t.startsWith('##') && !/^#EXT-X-PROGRAM-DATE-TIME:/i.test(t);
            })
            .map((line) => {
              const trimmed = line.trim();
              if (trimmed.startsWith('#')) return trimmed;
              if (/^https?:\/\//i.test(trimmed)) return trimmed;
              try { return new URL(trimmed, basePlaylistUrl).href; } catch (_) { return trimmed; }
            })
            .join('\n');
          const pack = packTextPayload(rewritten, cachedPl?.pack, { brotliQuality: 6 });
          strmfreePlaylists.set(plKey, { body: rewritten, pack, at: Date.now() });
          return { ok: true, status: 200, body: rewritten, pack, cached: false };
        } catch (err) {
          if (attempt === 0) continue;
          log.warn?.('[streams] strmfree playlist relay failed:', err?.message || err);
          return { ok: false, status: 502, error: 'Upstream playlist unreachable.' };
        }
      }
      return { ok: false, status: 502, error: 'Upstream playlist unavailable.' };
    })();
    strmfreePlInFlight.set(plKey, task);
    try {
      return await task;
    } finally {
      strmfreePlInFlight.delete(plKey);
    }
  }

  /* ── stripped PPV (taifood-blog.asia -> indianservers.st -> tiktokcdn) ─ */
  const ppvMasters = new Map();     // `${host}:${slug}` -> { masterUrl, host, expiresAt, at }
  const ppvMastersInFlight = new Map();
  const ppvPlaylists = new Map();   // `${host}:${slug}:${sub}` -> { body, pack, at }
  const ppvPlInFlight = new Map();
  const ppvShells = new Map();      // `${host}:${slug}` -> { html, pack }

  function ppvStrippedHtml(rawSlug, rawHost = PPV_DEFAULT_HOST) {
    const cleanSlug = normalizePpvSlug(rawSlug);
    if (!cleanSlug) return { ok: false, status: 400, error: 'A valid HD PPV stream slug is required.' };
    const cleanHost = String(rawHost || '').trim()
      ? (PPV_ALLOWED_HOSTS.has(String(rawHost).trim().toLowerCase()) ? String(rawHost).trim().toLowerCase() : '')
      : PPV_DEFAULT_HOST;
    if (!cleanHost) return { ok: false, status: 400, error: 'Unsupported PPV embed host.' };
    const shellKey = `${cleanHost}:${cleanSlug}`;
    const memo = ppvShells.get(shellKey);
    if (memo) {
      if (fetchImpl === fetch && ppvResolveImpl === null) void ppvMasterPlaylist(cleanSlug, cleanHost).catch(() => {});
      return { ok: true, status: 200, html: memo.html, pack: memo.pack };
    }
    const html = buildPpvStrippedHtml(cleanSlug, cleanHost);
    if (!html) return { ok: false, status: 400, error: 'A valid HD PPV stream slug is required.' };
    const pack = packTextPayload(html, null, { brotliQuality: 11 });
    if (ppvShells.size >= 120) ppvShells.delete(ppvShells.keys().next().value);
    ppvShells.set(shellKey, { html, pack });
    if (fetchImpl === fetch && ppvResolveImpl === null) void ppvMasterPlaylist(cleanSlug, cleanHost).catch(() => {});
    return { ok: true, status: 200, html, pack };
  }

  async function resolvePpvMasterUrl(rawSlug, rawHost = PPV_DEFAULT_HOST, { forceRefresh = false } = {}) {
    const slug = normalizePpvSlug(rawSlug);
    if (!slug) return { ok: false, status: 400, error: 'Invalid PPV stream slug.' };
    const host = String(rawHost || '').trim()
      ? (PPV_ALLOWED_HOSTS.has(String(rawHost).trim().toLowerCase()) ? String(rawHost).trim().toLowerCase() : '')
      : PPV_DEFAULT_HOST;
    if (!host) return { ok: false, status: 400, error: 'Unsupported PPV embed host.' };

    const cacheKey = `${host}:${slug}`;
    const cached = ppvMasters.get(cacheKey);
    const now = Date.now();
    if (!forceRefresh && cached && now - cached.at < PPV_MASTER_TTL_MS && (!cached.expiresAt || now < cached.expiresAt - 60_000)) {
      return { ok: true, status: 200, ...cached, cached: true };
    }
    if (!forceRefresh && ppvMastersInFlight.has(cacheKey)) {
      return ppvMastersInFlight.get(cacheKey);
    }

    const task = (async () => {
      try {
        const embedOrigin = `https://${host}`;
        const result = typeof ppvResolveImpl === 'function'
          ? await ppvResolveImpl({ embedOrigin, slug, forceRefresh })
          : await resolvePpvViaWorker(embedOrigin, slug, { forceRefresh });
        if (!result?.ok || !result.masterUrl) {
          return { ok: false, status: 503, error: result?.error || 'PPV stream is offline right now.' };
        }
        const parsedMaster = new URL(result.masterUrl);
        if (parsedMaster.protocol !== 'https:' || !isSafePublicHostname(parsedMaster.hostname)) {
          return { ok: false, status: 502, error: 'Invalid upstream PPV playlist URL.' };
        }
        const expMatch = parsedMaster.pathname.match(/\/secure\/[^/]+\/\d+\/(\d{9,12})\//);
        const expiresAt = expMatch ? Number(expMatch[1]) * 1000 : 0;
        const entry = { masterUrl: parsedMaster.href, host, expiresAt, at: Date.now() };
        ppvMasters.set(cacheKey, entry);
        return { ok: true, status: 200, ...entry, cached: false };
      } catch (err) {
        if (cached && (!cached.expiresAt || Date.now() < cached.expiresAt - 10_000)) {
          return { ok: true, status: 200, ...cached, cached: true, stale: true };
        }
        log.warn?.('[streams] PPV master resolve failed:', err?.message || err);
        return { ok: false, status: 503, error: 'Stripped PPV stream unavailable right now.' };
      }
    })();

    ppvMastersInFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      ppvMastersInFlight.delete(cacheKey);
    }
  }

  async function fetchPpvPlaylistUpstream(targetUrl, host) {
    const hdrs = {
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      Origin: `https://${host}`,
      Referer: `https://${host}/`
    };
    if (fetchImpl !== fetch) {
      return fetchWithTimeout(targetUrl, { headers: hdrs });
    }
    try {
      const client = getPpvBrowserClient(FETCH_TIMEOUT_MS);
      const res = await client.fetch(targetUrl, { headers: hdrs });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    } catch (_) {
      return fetchWithTimeout(targetUrl, { headers: hdrs });
    }
  }

  async function ppvMasterPlaylist(rawSlug, rawHost = PPV_DEFAULT_HOST) {
    const slug = normalizePpvSlug(rawSlug);
    if (!slug) return { ok: false, status: 400, error: 'Invalid PPV stream slug.' };
    const host = String(rawHost || '').trim()
      ? (PPV_ALLOWED_HOSTS.has(String(rawHost).trim().toLowerCase()) ? String(rawHost).trim().toLowerCase() : '')
      : PPV_DEFAULT_HOST;
    if (!host) return { ok: false, status: 400, error: 'Unsupported PPV embed host.' };

    const plKey = `${host}:${slug}:master`;
    const cachedPl = ppvPlaylists.get(plKey);
    if (cachedPl && Date.now() - cachedPl.at < PPV_MASTER_M3U8_TTL_MS) {
      if (cachedPl.firstSub && fetchImpl === fetch && ppvResolveImpl === null) {
        void ppvSubPlaylist(slug, cachedPl.firstSub, host).catch(() => {});
      }
      return { ok: true, status: 200, body: cachedPl.body, pack: cachedPl.pack, cached: true };
    }
    if (ppvPlInFlight.has(plKey)) return ppvPlInFlight.get(plKey);

    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = await resolvePpvMasterUrl(slug, host, { forceRefresh: attempt > 0 });
        if (!resolved.ok) return { ok: false, status: resolved.status || 503, error: resolved.error || 'PPV stream unavailable.' };
        try {
          const res = await fetchPpvPlaylistUpstream(resolved.masterUrl, host);
          if ((res.status === 403 || res.status === 404 || res.status === 410) && attempt === 0) continue;
          if (!res.ok) return { ok: false, status: res.status || 502, error: 'Upstream PPV playlist unavailable.' };
          const rawText = await res.text();
          if (!rawText.includes('#EXTM3U')) {
            if (attempt === 0) continue;
            return { ok: false, status: 502, error: 'Invalid upstream PPV playlist.' };
          }
          const masterBase = new URL('.', resolved.masterUrl).href;
          let firstSub = '';
          const rewritten = rawText
            .split(/\r?\n/)
            .filter((line) => line.trim() && !line.trim().startsWith('##'))
            .map((line) => {
              const trimmed = line.trim();
              if (trimmed.startsWith('#')) return trimmed;
              if (/\.m3u8(?:\?.*)?$/i.test(trimmed)) {
                let subRel = trimmed;
                if (/^https?:\/\//i.test(trimmed)) {
                  try {
                    const u = new URL(trimmed);
                    if (u.href.startsWith(masterBase)) subRel = u.href.slice(masterBase.length);
                    else return trimmed;
                  } catch (_) { return trimmed; }
                }
                subRel = subRel.replace(/^\.?\//, '').split('?')[0];
                if (/^[A-Za-z0-9._/-]{1,160}\.m3u8$/.test(subRel) && !subRel.includes('..')) {
                  if (!firstSub) firstSub = subRel;
                  return `sub.m3u8?slug=${encodeURIComponent(slug)}&host=${encodeURIComponent(host)}&sub=${encodeURIComponent(subRel)}`;
                }
              }
              if (/^https?:\/\//i.test(trimmed)) return trimmed;
              try { return new URL(trimmed, resolved.masterUrl).href; } catch (_) { return trimmed; }
            })
            .join('\n');
          const pack = packTextPayload(rewritten, cachedPl?.pack, { brotliQuality: 9 });
          ppvPlaylists.set(plKey, { body: rewritten, pack, firstSub, at: Date.now() });
          if (firstSub && fetchImpl === fetch && ppvResolveImpl === null) {
            void ppvSubPlaylist(slug, firstSub, host).catch(() => {});
          }
          return { ok: true, status: 200, body: rewritten, pack, cached: false };
        } catch (err) {
          if (attempt === 0) continue;
          log.warn?.('[streams] PPV master playlist relay failed:', err?.message || err);
          return { ok: false, status: 502, error: 'Upstream PPV playlist unreachable.' };
        }
      }
      return { ok: false, status: 502, error: 'Upstream PPV playlist unavailable.' };
    })();
    ppvPlInFlight.set(plKey, task);
    try {
      return await task;
    } finally {
      ppvPlInFlight.delete(plKey);
    }
  }

  async function ppvSubPlaylist(rawSlug, rawSub, rawHost = PPV_DEFAULT_HOST) {
    const slug = normalizePpvSlug(rawSlug);
    const cleanSub = String(rawSub || '').trim().replace(/^\/+/, '');
    if (!slug || !cleanSub || cleanSub.includes('..') || !/^[A-Za-z0-9._/-]{1,160}\.m3u8$/.test(cleanSub)) {
      return { ok: false, status: 400, error: 'Invalid PPV sub-playlist parameters.' };
    }
    const host = String(rawHost || '').trim()
      ? (PPV_ALLOWED_HOSTS.has(String(rawHost).trim().toLowerCase()) ? String(rawHost).trim().toLowerCase() : '')
      : PPV_DEFAULT_HOST;
    if (!host) return { ok: false, status: 400, error: 'Unsupported PPV embed host.' };

    const plKey = `${host}:${slug}:${cleanSub}`;
    const cachedPl = ppvPlaylists.get(plKey);
    if (cachedPl && Date.now() - cachedPl.at < PPV_M3U8_TTL_MS) {
      return { ok: true, status: 200, body: cachedPl.body, pack: cachedPl.pack, cached: true };
    }
    if (ppvPlInFlight.has(plKey)) return ppvPlInFlight.get(plKey);

    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = await resolvePpvMasterUrl(slug, host, { forceRefresh: attempt > 0 });
        if (!resolved.ok) return { ok: false, status: resolved.status || 503, error: resolved.error || 'PPV stream unavailable.' };
        let subUrl;
        try {
          subUrl = new URL(cleanSub, resolved.masterUrl).href;
        } catch (_) {
          return { ok: false, status: 400, error: 'Invalid PPV sub-playlist URL.' };
        }
        try {
          const res = await fetchPpvPlaylistUpstream(subUrl, host);
          if ((res.status === 403 || res.status === 404 || res.status === 410) && attempt === 0) continue;
          if (!res.ok) return { ok: false, status: res.status || 502, error: 'Upstream PPV media playlist unavailable.' };
          const rawText = await res.text();
          if (!rawText.includes('#EXTM3U')) {
            if (attempt === 0) continue;
            return { ok: false, status: 502, error: 'Invalid upstream PPV media playlist.' };
          }
          const rewritten = rawText
            .split(/\r?\n/)
            .filter((line) => {
              const t = line.trim();
              return t && !t.startsWith('##') && !/^#EXT-X-PROGRAM-DATE-TIME:/i.test(t);
            })
            .map((line) => {
              const trimmed = line.trim();
              if (trimmed.startsWith('#')) return trimmed;
              if (/^https?:\/\//i.test(trimmed)) return trimmed;
              try { return new URL(trimmed, subUrl).href; } catch (_) { return trimmed; }
            })
            .join('\n');
          const pack = packTextPayload(rewritten, cachedPl?.pack, { brotliQuality: 6 });
          ppvPlaylists.set(plKey, { body: rewritten, pack, at: Date.now() });
          return { ok: true, status: 200, body: rewritten, pack, cached: false };
        } catch (err) {
          if (attempt === 0) continue;
          log.warn?.('[streams] PPV media playlist relay failed:', err?.message || err);
          return { ok: false, status: 502, error: 'Upstream PPV media playlist unreachable.' };
        }
      }
      return { ok: false, status: 502, error: 'Upstream PPV media playlist unavailable.' };
    })();
    ppvPlInFlight.set(plKey, task);
    try {
      return await task;
    } finally {
      ppvPlInFlight.delete(plKey);
    }
  }

  /* The status map on its own: the browser cannot read it directly (weelo only answers its own
     origin), so it is relayed from here. */
  return {
    resolveUhdUrl,
    resolveDynamic,
    getHealth,
    summary,
    listSources,
    mirrorsFor,
    weeloState,
    taifoodChannels,
    embdlolPublicChannels,
    chipAddresses,
    weellzStrippedHtml,
    weellzAesKey,
    embdlolStrippedHtml,
    strmfreeStrippedHtml,
    strmfreePlaylist,
    ppvStrippedHtml,
    ppvMasterPlaylist,
    ppvSubPlaylist
  };
}

module.exports = { createStreamResolver, stripWeellzHtml, stripStrmfreeHtml, buildEmbdlolStrippedHtml, buildPpvStrippedHtml, toStrippedEmbdlolUrl, toStrippedStrmfreeUrl, toStrippedPpvUrl, normalizePpvHost, normalizePpvSlug, UHD_CHANNEL_NAME, DYNAMIC_ALLOWLIST, PROVIDER_PROBES, STREAM_SOURCES, MIRROR_KEYS };
