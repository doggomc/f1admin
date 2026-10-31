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
const UHD_CHANNEL_NAME = 'f1friuhd';
const CDNLIVE_CATALOGUE = 'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free';

const UHD_REFRESH_MS = 30 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const RESOLVE_TTL_MS = 5 * 60_000;
const HEALTH_TTL_MS = 120_000;
const FETCH_TIMEOUT_MS = 9000;
const HEALTH_TIMEOUT_MS = 6000;

/* ehgembxe paths are opaque to the client, so they are allowlisted here instead. */
const DYNAMIC_ALLOWLIST = new Set(['ehgembxe/f596f98r-4089']);

/* The player's own source list, in the same order as `sources` in netlifyf1/src/app.ts.
   GET /api/stream/sources publishes it so Race Control and the player cannot drift apart: every
   chip the player draws is switchable here, and every switch here is drawn by the player.

   `minQuality` is the floor a link has to clear to appear in this provider's pool. */
const STREAM_SOURCES = [
  { id: 'sky-uk', label: 'Sky HD', main: true, provider: 'strmfree', minQuality: 720, links: [
    { quality: 1080, url: 'https://strmfree.st/embed/racing/skyf11080p' },
    { quality: 1080, url: 'https://streamfree.top/embed/racing/skyf11080p' },
    { quality: 1080, url: 'https://strmfree.st/embed/racing/skyf1' },
    { quality: 1080, url: 'https://streamfree.top/embed/racing/skyf1?server=origin&quality=1080p&category=racing' }
  ] },
  { id: 'sky-uhd', label: 'Sky UHD', provider: 'strmfree', minQuality: 720, links: [
    { quality: 2160, url: 'https://strmfree.st/embed/racing/skyf12160p' },
    { quality: 2160, url: 'https://streamfree.top/embed/racing/skyf12160p' }
  ] },
  { id: 'sky-f1-uk', label: 'Sky Sports F1 UK', provider: 'cdnlivetv', minQuality: 720, links: [
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sports%20F1%20FHD%20UK&code=&user=cdnlivetv&plan=free' },
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=DAZN%20F1%20FHD&code=&user=cdnlivetv&plan=free' },
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=Viaplay%20Sports%201%20FHD%20UK&code=&user=cdnlivetv&plan=free' },
    { quality: 1080, url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=Viaplay%20Sports%202%20FHD%20UK&code=&user=cdnlivetv&plan=free' }
  ] },
  { id: 'emb-sky', label: 'Sky F1 (EMB)', provider: 'embdlol', channel: 'f1frisky', minQuality: 0, links: [] },
  { id: 'emb-apple', label: 'Apple TV (EMB)', provider: 'embdlol', channel: 'f1friapple', minQuality: 0, links: [] },
  { id: 'emb-dazn', label: 'DAZN ES (EMB)', provider: 'embdlol', channel: 'f1fridazn', minQuality: 0, links: [] },
  { id: 'emb-italia', label: 'Sky Italia (EMB)', provider: 'embdlol', channel: 'f1friskyit', minQuality: 0, links: [] },
  { id: 'emb-de', label: 'Sky DE (EMB)', provider: 'embdlol', channel: 'f1friskyde', minQuality: 0, links: [] },
  { id: 'emb-uhd', label: 'F1 UHD 4K', provider: 'embdlol', channel: UHD_CHANNEL_NAME, minQuality: 0, links: [] },
  { id: 'ehgembxe', label: 'Sky Sports F1 HD (EHG)', provider: 'ehgembxe', minQuality: 720, retryOnExpiry: true, links: [
    { quality: 1080, url: 'ehgembxe/f596f98r-4089' }
  ] },
  { id: 'sky-sports', label: 'Sky Sports', provider: 'hakunamatata', minQuality: 0, links: [
    { quality: 0, url: 'https://hakunamatata5.org/hakunamatata5.html' }
  ] },
  { id: 'appletv', label: 'AppleTV', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31385 }, { quality: 720, taid: 31374 }
  ] },
  { id: 'dazn', label: 'DAZN', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31387 }, { quality: 720, taid: 31376 }
  ] },
  { id: 'viaplay', label: 'Viaplay', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31391 }, { quality: 720, taid: 31380 }
  ] },
  { id: 'sky-italia', label: 'Sky Sport Italia', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31389 }, { quality: 720, taid: 31378 }
  ] },
  { id: 'sky-de', label: 'Sky Sport F1 DE', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31388 }, { quality: 720, taid: 31377 }
  ] },
  { id: 'v-sport', label: 'V Sport Motor SE', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31390 }
  ] },
  { id: 'czech', label: 'Czech F1', provider: 'taifood', minQuality: 720, links: [
    { quality: 720, taid: 31381 }
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
        const channel = (json?.channels || []).find((entry) => String(entry?.channelname || '').toLowerCase() === UHD_CHANNEL_NAME);
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
      const next = new Set();
      for (const channel of Array.isArray(json?.channels) ? json.channels : []) {
        const name = String(channel?.channelname || '').toLowerCase();
        if (name) next.add(name);
      }
      catalogueChannels = next;
      catalogueAt = Date.now();
    } catch (_) {
      /* Directory unreachable: report unknown rather than claiming a channel is missing. */
    }
    return catalogueChannels;
  }

  /* Every source the player draws, plus whatever the provider is publishing as live right now. */
  async function listSources() {
    const [skyMirrors, uhdUrl, channels] = await Promise.all([mirrorsFor('skyf1'), resolveUhdUrl(), embdlolChannels()]);
    const hasChannel = (name) => (channels instanceof Set ? channels.has(String(name).toLowerCase()) : false);
    const knownChannels = channels instanceof Set ? channels.size > 0 : false;
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
        links,
        /* An EMB chip is only playable when its channel is listed upstream; the 4K chip has its
           own resolution path. Reporting this is what stops the site drawing dead EMB chips. */
        upstream: source.provider !== 'embdlol'
          ? true
          : source.id === 'emb-uhd' ? Boolean(uhdUrl) : knownChannels ? hasChannel(source.channel) : null
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

  return { resolveUhdUrl, resolveDynamic, getHealth, summary, listSources, mirrorsFor };
}

module.exports = { createStreamResolver, UHD_CHANNEL_NAME, DYNAMIC_ALLOWLIST, PROVIDER_PROBES, STREAM_SOURCES, MIRROR_KEYS };
