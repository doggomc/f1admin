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
   --------------------------------------------------------------------------- */

const crypto = require('crypto');

const EMBDLOL_STRUCT = 'https://api.embdlol.st/struct';
const EMBDLOL_EMBED = 'https://embdlol.st/embed/';
/* embdlol names its F1 channels per event: f1friuhd, f1mexicosatuhd, f1vegasuhd...  So the UHD
   channel is matched by shape, never by a fixed name — a fixed name is what made the 4K chip
   report "not upstream" while a 4K channel was sitting in the directory. */
const UHD_CHANNEL_NAME = 'f1friuhd';                 // kept for the summary output
const UHD_PATTERN = /^f1[a-z]*uhd$/;
const isUhdChannel = (name) => UHD_PATTERN.test(String(name || '').trim().toLowerCase());

/* F1 channel names, normalised to the feed they carry, whichever event prefix they use. */
/* Longest first, and the short codes ('ita', 'deu') are included: embdlol renames its F1 channels
   for every race, and Mexico published f1mexicosatita / f1mexicosatdeu rather than the long names.
   Matched against a feed key, these aliases are what a chip's key is compared to. */
const FEED_SUFFIXES = ['fullhd1', 'fullhd3', 'italian', 'spanish', 'german', 'skyit', 'skyde',
  'apple', 'world', 'dazn', 'sky', 'ita', 'deu', 'uhd'];
const FEED_PATTERN = new RegExp(`^f1[a-z]*?(${FEED_SUFFIXES.join('|')})$`);
/* The short codes embdlol uses today and the long key a chip uses. Without this, today's
   f1mexicosatita never matches the 'italian' chip and the whole EMB block reads "no channel". */
const FEED_ALIASES = { ita: 'italian', deu: 'german', skyit: 'skyit', skyde: 'skyde' };
function feedKey(name) {
  /* Some entries are bare ('german', 'fullhd3'), others carry the race prefix ('f1frigerman'). */
  const flat = String(name || '').trim().toLowerCase().replace(/[\s_]/g, '');
  if (FEED_SUFFIXES.includes(flat)) return flat;
  const match = flat.match(FEED_PATTERN);
  return match ? (FEED_ALIASES[match[1]] || match[1]) : '';
}
const CDNLIVE_CATALOGUE = 'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free';

const UHD_REFRESH_MS = 30 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const RESOLVE_TTL_MS = 5 * 60_000;
const HEALTH_TTL_MS = 120_000;
const FETCH_TIMEOUT_MS = 9000;
const HEALTH_TIMEOUT_MS = 6000;

/* ehgembxe paths are opaque to the client, so they are allowlisted here instead. */
const DYNAMIC_ALLOWLIST = new Set(['ehgembxe/f596f98r-7758', 'ehgembxe/f596f98r-4089']);

/* The embdlol feeds whose commentary is not English. */
const EMB_OTHER = ['dazn', 'skyit', 'skyde', 'german', 'spanish', 'italian'];

/* label + feed key for each embdlol chip, in the same order as the player's row. */
const EMB_FEEDS = [['sky', 'Sky F1'], ['apple', 'Apple TV'], ['dazn', 'DAZN ES'], ['skyit', 'Sky Italia'],
  ['skyde', 'Sky DE'], ['world', 'F1 World'], ['german', 'German'], ['spanish', 'Spanish'],
  ['italian', 'Italian'], ['fullhd1', 'Full HD 1'], ['fullhd3', 'Full HD 3']];

/* weelo relays the onboards and the data channel: one id per feed, and /players/state.json says
   whether it is up. That file refuses cross-origin requests (it answers only on weelo.live itself),
   so the server reads it and the browser asks /api/stream/weelo instead. `tab` is the English/Other filter the player draws; `special` keeps these out
   of the broadcaster run and in their own block. */
const WEELO_STATE = 'https://weelo.live/players/state.json';
const WEELO_PLAYER = 'https://weellz.live/beta?stream=';
const WEELO_FEEDS = [
  ['kimi', 'Kimi Antonelli', 'onboard', 'peogcgpgbgchegaciclejgngjgacbeogehpgogfgmgmgjgjcacieee'],
  ['charles', 'Charles Leclerc', 'onboard', 'peogcgpgbgchegacicdeigbgchmgfgdhacmefgdgmgfgchdgjcacieee'],
  ['max', 'Max Verstappen', 'onboard', 'peogcgpgbgchegacicnebgihacgffgchdhehbgahahfgogjcacieee'],
  ['drivers', 'Drivers Track', 'onboard', 'gebdacefgfaciceechjgghfgchacefchbgdglgfgchjcacieee'],
  ['data', 'Data Channel', 'data', 'gebdacefgfaciceebgehbgacdeigbgogogfgmgjcacieee']
];

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
  { id: 'sky-uk', label: 'Sky HD', main: true, provider: 'strmfree', minQuality: 720, tab: 'en', links: [
    { quality: 1080, url: 'https://strmfree.st/embed/racing/skyf11080p' },
    { quality: 1080, url: 'https://streamfree.top/embed/racing/skyf11080p' },
    { quality: 1080, url: 'https://strmfree.st/embed/racing/skyf1' },
    { quality: 1080, url: 'https://streamfree.top/embed/racing/skyf1?server=origin&quality=1080p&category=racing' }
  ] },
  { id: 'sky-uhd', label: 'Sky UHD', provider: 'strmfree', minQuality: 720, tab: 'en', links: [
    { quality: 2160, url: 'https://strmfree.st/embed/racing/skyf12160p' },
    { quality: 2160, url: 'https://streamfree.top/embed/racing/skyf12160p' }
  ] },
  /* The feeds whose commentary is not English draw under the Other tab, in the player and here. */
  ...EMB_FEEDS.map(([feed, label]) => ({ id: `emb-${feed}`, label: `${label} (EMB)`, provider: 'embdlol', channel: feed, minQuality: 0, tab: EMB_OTHER.includes(feed) ? 'other' : 'en', links: [] })),
  { id: 'emb-uhd', label: 'F1 UHD 4K', provider: 'embdlol', channel: UHD_CHANNEL_NAME, minQuality: 0, tab: 'en', links: [] },
  /* Onboards and the data channel. `special` chips are drawn apart from the broadcasters. */
  ...WEELO_FEEDS.map(([id, label, special, weelo]) => ({
    id: `weelo-${id}`, label, provider: 'weelo', weelo, special, tab: 'en', minQuality: 720,
    links: [{ quality: 1080, url: WEELO_PLAYER + weelo }]
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
    { quality: 1080, url: 'ehgembxe/f596f98r-4089' }
  ] },
  { id: 'sky-sports', label: 'Sky Sports', provider: 'hakunamatata', minQuality: 0, links: [
    { quality: 0, url: 'https://hakunamatata5.org/hakunamatata5.html' }
  ] },
  { id: 'appletv', label: 'AppleTV', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31385 }, { quality: 720, taid: 31374 }
  ] },
  { id: 'dazn', label: 'DAZN', provider: 'taifood', minQuality: 720, tab: 'other', links: [
    { quality: 720, taid: 31387 }, { quality: 720, taid: 31376 }
  ] },
  { id: 'viaplay', label: 'Viaplay', provider: 'taifood', minQuality: 720, tab: 'other', links: [
    { quality: 720, taid: 31391 }, { quality: 720, taid: 31380 }
  ] },
  { id: 'sky-italia', label: 'Sky Sport Italia', provider: 'taifood', minQuality: 720, tab: 'other', links: [
    { quality: 720, taid: 31389 }, { quality: 720, taid: 31378 }
  ] },
  { id: 'sky-de', label: 'Sky Sport F1 DE', provider: 'taifood', minQuality: 720, tab: 'other', links: [
    { quality: 720, taid: 31388 }, { quality: 720, taid: 31377 }
  ] },
  { id: 'v-sport', label: 'V Sport Motor SE', provider: 'taifood', minQuality: 720, tab: 'other', links: [
    { quality: 720, taid: 31390 }
  ] },
  { id: 'wikisport', label: 'WikiSport', provider: 'wikisport', minQuality: 0, links: [
    { quality: 0, url: 'https://wikisport.info/strm/f1.php' },
    { quality: 0, url: 'https://wikisport.info/fsl/f1s2.php' },
    { quality: 0, url: 'https://wikisport.info/fsl/f1s3.php' }
  ] },
  { id: 'westream', label: 'WeStream F1', provider: 'westream', minQuality: 0, links: [
    { quality: 0, url: 'https://westreamf1.com/westreamf1.php' }
  ] },
  { id: 'ppv', label: 'F1 PPV', provider: 'taifood', minQuality: 720, links: [{ quality: 720, ppv: true }] }
];

/* A provider's published mirrors, used to grow a pool without a redeploy. */
const MIRROR_KEYS = { skyf1: ['https://strmfree.st', 'https://streamfree.top'] };

/* Providers worth probing, with the address a browser would actually request. */
const PROVIDER_PROBES = [
  { provider: 'strmfree', label: 'strmfree 1080p', url: 'https://strmfree.st/embed/racing/skyf11080p' },
  { provider: 'strmfree', label: 'strmfree 2160p', url: 'https://strmfree.st/embed/racing/skyf12160p' },
  { provider: 'streamfree', label: 'streamfree 1080p', url: 'https://streamfree.top/embed/racing/skyf11080p' },
  { provider: 'streamfree', label: 'streamfree 2160p', url: 'https://streamfree.top/embed/racing/skyf12160p' },
  { provider: 'wikisport', label: 'WikiSport 1', url: 'https://wikisport.info/strm/f1.php' },
  { provider: 'westream', label: 'WeStream', url: 'https://westreamf1.com/westreamf1.php' },
  { provider: 'hakunamatata', label: 'hakunamatata', url: 'https://hakunamatata5.org/hakunamatata5.html' },
  { provider: 'ehgembxe', label: 'ehgembxe', url: 'https://ehgembxe.cfd/f596f98r-4089', follow: true }
];

function createStreamResolver({ log = console } = {}) {
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
      return await fetch(url, {
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
    if (uhd.url && Date.now() - uhd.at < UHD_REFRESH_MS) return uhd.url;
    if (!uhd.url && uhd.failedAt && Date.now() - uhd.failedAt < RETRY_AFTER_FAILURE_MS) return '';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchWithTimeout(EMBDLOL_STRUCT);
        if (!response.ok) throw new Error(`struct responded ${response.status}`);
        const json = await response.json();
        const channel = (json?.channels || []).find((entry) => isUhdChannel(entry?.channelname));
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
    if (catalogueAt && Date.now() - catalogueAt < UHD_REFRESH_MS) return catalogueChannels;
    try {
      const response = await fetchWithTimeout(EMBDLOL_STRUCT, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`struct responded ${response.status}`);
      const json = await response.json();
      const next = new Map();
      for (const channel of Array.isArray(json?.channels) ? json.channels : []) {
        const key = feedKey(channel?.channelname);
        if (key && channel?.id) next.set(key, String(channel.id));
      }
      catalogueChannels = next;
      catalogueAt = Date.now();
    } catch (_) {
      /* Directory unreachable: report unknown rather than claiming a channel is missing. */
    }
    return catalogueChannels;
  }

  /* weelo's own status map. Offline and dark are the only states that stop a chip playing; 'soon'
     means the feed is about to come up and is worth offering. */
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
        weelo.state = next;
        weelo.at = Date.now();
      }
    } catch (_) {
      /* Unreachable: leave the chips reported as unknown rather than claiming they are down. */
    }
    return weelo.state;
  }

  /* Every source the player draws, plus whatever the provider is publishing as live right now. */
  async function listSources() {
    const [skyMirrors, uhdUrl, channels, state] = await Promise.all([mirrorsFor('skyf1'), resolveUhdUrl(), embdlolChannels(), weeloState()]);
    const hasChannel = (key) => (channels instanceof Map ? channels.has(key) : false);
    const knownChannels = channels instanceof Map ? channels.size > 0 : false;
    return STREAM_SOURCES.map((source) => {
      let links = source.links.slice();
      if (source.id === 'sky-uk') {
        links = [...links.filter((link) => link.quality === 1080), ...skyMirrors.filter((mirror) => mirror.quality === 1080 && !links.some((link) => link.url === mirror.url))];
      }
      if (source.id === 'sky-uhd') {
        links = [...skyMirrors.filter((mirror) => mirror.quality >= 2160), ...links.filter((link) => link.quality === 1080 || link.quality >= 2160)];
        links = links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index);
      }
      return {
        id: source.id,
        label: source.label,
        provider: source.provider,
        main: Boolean(source.main),
        minQuality: source.minQuality,
        channels: source.channel ? [source.channel] : [],
        /* The tab the player filters on, and whether the chip is drawn apart from the broadcasters. */
        tab: source.tab || 'en',
        special: source.special || null,
        state: source.provider === 'weelo' ? state[source.weelo] || '' : null,
        links: links.map((link) => (link.taid ? { ...link, marks: TAID_MARKS, shape: taidUrl('{event}', '{session}', link.taid, '{mark}') } : link)),
        /* An EMB chip is only playable when its channel is listed upstream; the 4K chip has its
           own resolution path. Reporting this is what stops the site drawing dead EMB chips. */
        upstream: source.provider === 'weelo'
          ? !/^(offline|dark)$/.test(state[source.weelo] || '')
          : source.provider !== 'embdlol'
          ? true
          : source.id === 'emb-uhd' ? Boolean(uhdUrl) : knownChannels ? hasChannel(source.channel) : null,
        /* Where the chip would play, so a client can also build the pool itself. */
        resolvedUrl: source.provider === 'embdlol' && knownChannels && hasChannel(source.channel)
          ? EMBDLOL_EMBED + channels.get(source.channel)
          : null
      };
    });
  }

  /* ── dynamic providers ──────────────────────────────────────────────── */
  async function resolveDynamic(path) {
    if (!DYNAMIC_ALLOWLIST.has(path)) return { url: '', code: 'unknown-provider' };

    const cached = dynamic.get(path);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return { url: cached.url, cached: true };

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
      catalogueChannels = out;
      catalogueAt = Date.now();
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

  /* The status map on its own: the browser cannot read it directly (weelo only answers its own
     origin), so it is relayed from here. */
  return { resolveUhdUrl, resolveDynamic, getHealth, summary, listSources, mirrorsFor, weeloState };
}

module.exports = { createStreamResolver, UHD_CHANNEL_NAME, DYNAMIC_ALLOWLIST, PROVIDER_PROBES, STREAM_SOURCES, MIRROR_KEYS };
