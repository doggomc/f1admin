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

/* Providers worth probing, with the address a browser would actually request. */
const PROVIDER_PROBES = [
  { provider: 'strmfree', label: 'strmfree 2160p', url: 'https://strmfree.st/embed/racing/skyf12160p' },
  { provider: 'streamfree', label: 'streamfree 1080p', url: 'https://streamfree.top/embed/racing/skyf11080p' },
  { provider: 'wikisport', label: 'WikiSport 1', url: 'https://wikisport.info/strm/f1.php' },
  { provider: 'westream', label: 'WeStream', url: 'https://westreamf1.com/westreamf1.php' },
  { provider: 'hakunamatata', label: 'hakunamatata', url: 'https://hakunamatata5.org/hakunamatata5.html' },
  { provider: 'ehgembxe', label: 'ehgembxe', url: 'https://ehgembxe.cfd/f596f98r-4089', follow: true }
];

function createStreamResolver({ log = console } = {}) {
  const uhd = { url: '', at: 0, failedAt: 0 };
  const dynamic = new Map();      // path -> { url, at }
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

  return { resolveUhdUrl, resolveDynamic, getHealth, summary };
}

module.exports = { createStreamResolver, UHD_CHANNEL_NAME, DYNAMIC_ALLOWLIST, PROVIDER_PROBES };
