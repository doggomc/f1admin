'use strict';

/* ════════════════════════════════════════════════════════════════════
   Discord gate — 4K for server members, unlocked with /link <code>
   ════════════════════════════════════════════════════════════════════
   No OAuth. No redirects. No cookies. The browser and the Discord bot
   meet in the middle through a five-digit code.

   Flow
     1. Browser: POST /api/discord/link/start
          → { code: "48213", pollToken: "<32-byte secret>", expiresInMs }
        The code is what the human copies. pollToken never leaves this
        browser and is required to collect the result, so a code alone
        cannot be used to steal somebody else's session.
     2. Human runs  /link 48213  in #4k-access.
     3. Bot: POST /api/discord/link/claim  { code, userId, userName }
        authenticated with the shared bot secret. The server confirms the
        account really is in the guild, then mints a session token and
        parks it against the code.
     4. Browser polls POST /api/discord/link/poll { code, pollToken } and
        collects the token once, stores it in localStorage, and keeps it.
        The token has no practical expiry: it lasts until the person is
        found to have left the server.
     5. GET /api/discord/status re-checks guild membership (cached five
        minutes) so leaving the server takes the 4K chip away again.
     6. GET /api/discord/4k returns the stream url only to verified
        members — the url is never in the public bundle.

   Trust model, stated plainly: this is a funnel, not DRM. api.embdlol.st
   lists channels publicly, so a determined visitor can find the stream.
   The gate keeps the url out of the bundle, makes joining the natural
   path, and revokes access when someone leaves.

   Env (required): DISCORD_GUILD_ID, DISCORD_BOT_TOKEN, DISCORD_BOT_SECRET
   Env (optional): DISCORD_GUILD_INVITE, DISCORD_LINK_CHANNEL_ID,
                   DISCORD_LINK_CHANNEL_NAME (default 4k-access),
                   DISCORD_REQUIRED_ROLE, DISCORD_SESSION_SECRET,
                   DISCORD_4K_URL, DISCORD_API_BASE,
                   DISCORD_GATE_ENABLED=false to switch it all off
   ════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const DISCORD_API = String(process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const EMBDLOL_STRUCT = 'https://api.embdlol.st/struct';
const EMBDLOL_EMBED = 'https://embdlol.st/embed/';
const UHD_CHANNEL_NAME = 'f1friuhd';

const CODE_TTL_MS = 15 * 60 * 1000;      // a code is good for fifteen minutes
const CODE_POLL_TTL_MS = 60 * 60 * 1000; // claimed codes stay collectable for an hour
/* How often a linked account is re-checked against the guild. Lower notices departures sooner
   at the cost of more Discord API calls; override with DISCORD_MEMBER_CACHE_SECONDS. */
const MEMBER_CACHE_MS = Math.max(5, Number.parseInt(process.env.DISCORD_MEMBER_CACHE_SECONDS || '300', 10) || 300) * 1000;
const SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // effectively "forever"

/* ── the session signing key ──────────────────────────────────────────
   Member sessions must survive a redeploy. Render's free tier has no persistent disk, so the key
   cannot be a file, and a random per-boot value would sign everybody out on every deploy.

   Order of preference:
     1. DISCORD_SESSION_SECRET — set it to pin the key yourself.
     2. ADMIN_SECRET          — stable, and already configured on a working deployment.
     3. Derived from DISCORD_BOT_TOKEN, which the gate cannot run without. Deterministic, so two
        deploys of the same token produce the same key and linked browsers never notice a restart.
   A gate that is configured (guild + bot token) therefore ALWAYS has a stable key; the random
   fallback below can only happen on a deployment where the gate would not run at all. */
function deriveSessionKey(env) {
  const explicit = String(env.DISCORD_SESSION_SECRET || env.ADMIN_SECRET || '').trim();
  if (explicit) return { key: explicit, source: 'env' };
  const botToken = String(env.DISCORD_BOT_TOKEN || '').trim();
  if (botToken) {
    return {
      key: crypto.createHmac('sha256', 'freef1-discord-session-v1').update(botToken).digest('hex'),
      source: 'bot-token'
    };
  }
  return { key: '', source: 'none' };
}

function readConfig(env) {
  const guildId = String(env.DISCORD_GUILD_ID || '').trim();
  const botToken = String(env.DISCORD_BOT_TOKEN || '').trim();
  const session = deriveSessionKey(env);
  return {
    enabled: String(env.DISCORD_GATE_ENABLED || 'true').toLowerCase() !== 'false',
    guildId,
    botToken,
    botSecret: String(env.DISCORD_BOT_SECRET || '').trim(),
    /* Defaulted, not optional: an empty invite makes the site's Join button do nothing. */
    invite: String(env.DISCORD_GUILD_INVITE || 'https://discord.gg/KYXHCAzhN4').trim(),
    channelId: String(env.DISCORD_LINK_CHANNEL_ID || '').trim(),
    channelName: String(env.DISCORD_LINK_CHANNEL_NAME || '4k-access').trim() || '4k-access',
    requiredRole: String(env.DISCORD_REQUIRED_ROLE || '').trim(),
    /* Never the minted DISCORD_BOT_SECRET: that changes on boot, which would sign everyone out. */
    secret: session.key || crypto.randomBytes(32).toString('hex'),
    secretSource: session.source,
    get configured() { return Boolean(this.guildId && this.botToken); }
  };
}

/* ── token helpers ─────────────────────────────────────────────────── */
function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function randomCode() {
  /* 100000–999999 keeps it a clean five digits with no leading-zero confusion. */
  return String(crypto.randomInt(100000, 1000000));
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── rate limiting (per instance, per key) ─────────────────────────── */
function makeLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((at) => now - at < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length <= limit;
  };
}

/* ── the gate ──────────────────────────────────────────────────────── */
function createDiscordGate({ app, siteUrl, log = console }) {
  const config = readConfig(process.env);
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const limitStart = makeLimiter(6, 60_000);     // a human needs one, maybe two goes
  const limitPoll = makeLimiter(240, 60_000);    // polling every 2s is ~30/min
  const limitClaim = makeLimiter(10, 60_000);    // per discord user

  /* code → { code, pollToken, at, exp, claimed|null } */
  const codes = new Map();
  /* userId → { member, roles, at } so /status does not hammer Discord */
  const members = new Map();
  /* embdlol channel cache */
  let uhd = { url: '', at: 0 };

  function pruneCodes() {
    const now = Date.now();
    for (const [code, entry] of codes) {
      const ttl = entry.claimed ? CODE_POLL_TTL_MS : CODE_TTL_MS;
      if (now - entry.at > ttl) codes.delete(code);
    }
  }

  async function fetchJson(url, options = {}, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
      return { ok: response.ok, status: response.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  function readSession(req) {
    const header = String(req.headers.authorization || '');
    let raw = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (!raw) {
      try { raw = String(new URL(req.url, 'http://x').searchParams.get('token') || ''); } catch (_) {}
    }
    if (!raw || !raw.includes('.')) return null;
    const [body, mac] = raw.split('.');
    if (!safeEqual(mac, sign(body, config.secret))) return null;
    try {
      const claims = JSON.parse(unb64url(body));
      if (!claims || typeof claims.userId !== 'string') return null;
      if (Number(claims.exp) && Number(claims.exp) < Date.now()) return null;
      if (String(claims.guildId || '') !== config.guildId) return null;
      return claims;
    } catch (_) {
      return null;
    }
  }

  function mintSession(userId, userName) {
    const claims = {
      userId: String(userId),
      userName: String(userName || 'member'),
      guildId: config.guildId,
      at: Date.now(),
      exp: Date.now() + SESSION_TTL_MS
    };
    const body = b64url(JSON.stringify(claims));
    return { claims, token: `${body}.${sign(body, config.secret)}` };
  }

  /* Is this user in the guild right now? Cached, because /status runs on every page load.
     'unknown' means Discord could not answer — callers keep whatever access they had. */
  async function membership(userId, { fresh = false } = {}) {
    if (!config.botToken) return { state: 'unknown', member: false };
    const cached = members.get(userId);
    if (!fresh && cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached;
    try {
      const response = await fetchJson(`${DISCORD_API}/guilds/${config.guildId}/members/${userId}`, {
        headers: { Authorization: `Bot ${config.botToken}` }
      }, 8000);
      if (response.status === 404) {
        const result = { state: 'absent', member: false, at: Date.now() };
        members.set(userId, result);
        return result;
      }
      if (!response.ok || !response.json) {
        return { state: 'unknown', member: false, at: Date.now() };
      }
      const roles = Array.isArray(response.json.roles) ? response.json.roles : [];
      const result = {
        state: 'member',
        member: config.requiredRole ? roles.includes(config.requiredRole) : true,
        roles,
        userName: response.json.user?.username || response.json.nick || '',
        at: Date.now()
      };
      members.set(userId, result);
      return result;
    } catch (error) {
      log.warn?.('[Discord gate] membership check failed:', error.message);
      return { state: 'unknown', member: false, at: Date.now() };
    }
  }

  /* Resolving the 4K channel means one call to embdlol's directory. Cached for half an hour,
     retried once, and never allowed to discard a url that already worked. */
  const UHD_REFRESH_MS = 30 * 60_000;
  let uhdFailureAt = 0;

  async function resolveUhdUrl() {
    const override = String(process.env.DISCORD_4K_URL || '').trim();
    if (override) return override;

    if (uhd.url && Date.now() - uhd.at < UHD_REFRESH_MS) return uhd.url;
    if (!uhd.url && uhdFailureAt && Date.now() - uhdFailureAt < 60_000) return '';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const struct = await fetchJson(EMBDLOL_STRUCT, { headers: { Accept: 'application/json' } }, 9000);
        const channel = (struct.json?.channels || []).find((entry) => String(entry.channelname || '').toLowerCase() === UHD_CHANNEL_NAME);
        if (channel?.id) {
          uhd = { url: `${EMBDLOL_EMBED}${channel.id}`, at: Date.now() };
          uhdFailureAt = 0;
          return uhd.url;
        }
        break;
      } catch (error) {
        log.warn?.(`[Discord gate] embdlol struct attempt ${attempt + 1} failed:`, error.message);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    uhdFailureAt = Date.now();
    return uhd.url;
  }

  const channelLabel = () => `#${config.channelName}`;

  /* ── CORS: the site is on another origin, and it sends JSON bodies now ── */
  app.use('/api/discord', (req, res, next) => {
    const origin = String(req.headers.origin || '').trim();
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bot-Secret');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  /* ── browser: ask for a code ───────────────────────────────────────── */
  app.post('/api/discord/link/start', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.enabled) return res.status(503).json({ error: 'disabled', message: 'Discord linking is switched off.' });
    if (!config.configured) return res.status(503).json({ error: 'not-configured', message: 'Discord linking is not set up on the server yet.' });
    if (!limitStart(clientIp(req))) return res.status(429).json({ error: 'rate', message: 'Too many codes. Wait a minute.' });

    pruneCodes();
    let code = randomCode();
    let guard = 0;
    while (codes.has(code) && guard++ < 50) code = randomCode();

    const entry = { code, pollToken: randomToken(), at: Date.now(), claimed: null };
    codes.set(code, entry);
    return res.json({
      code,
      pollToken: entry.pollToken,
      expiresInMs: CODE_TTL_MS,
      channel: channelLabel(),
      invite: config.invite,
      command: `/link ${code}`
    });
  });

  /* ── browser: collect the result ───────────────────────────────────── */
  app.post('/api/discord/link/poll', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!limitPoll(clientIp(req))) return res.status(429).json({ state: 'rate' });
    const code = String(req.body?.code || '').trim();
    const pollToken = String(req.body?.pollToken || '').trim();
    const entry = codes.get(code);
    if (!entry || !pollToken || !safeEqual(entry.pollToken, pollToken)) {
      /* Unknown code, wrong token or expired: tell the browser to start over. */
      return res.json({ state: 'expired' });
    }
    if (entry.claimed) {
      const { token, claims } = entry.claimed;
      /* Hand the token over once, then forget it: a second poll with the same pollToken still
         works (a reload mid-handoff is harmless) but the code stops being a token jar. */
      return res.json({
        state: 'claimed',
        token,
        user: { id: claims.userId, name: claims.userName }
      });
    }
    if (Date.now() - entry.at > CODE_TTL_MS) {
      codes.delete(code);
      return res.json({ state: 'expired' });
    }
    return res.json({ state: 'pending', expiresInMs: Math.max(0, CODE_TTL_MS - (Date.now() - entry.at)) });
  });

  /* ── bot: the human ran /link <code> ───────────────────────────────── */
  app.post('/api/discord/link/claim', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.enabled) return res.status(503).json({ ok: false, error: 'disabled' });
    /* Only the bot may vouch for somebody. Without this secret, anyone who guessed a code
       could claim it from a script without ever joining. */
    const provided = String(req.headers['x-bot-secret'] || '');
    if (!config.botSecret || !provided || !safeEqual(provided, config.botSecret)) {
      return res.status(401).json({ ok: false, error: 'bad-secret' });
    }

    const code = String(req.body?.code || '').trim().replace(/[^0-9]/g, '');
    const userId = String(req.body?.userId || '').trim();
    const userName = String(req.body?.userName || '').trim();
    if (!/^\d{5,6}$/.test(code) || !/^\d{5,}$/.test(userId)) {
      return res.status(400).json({ ok: false, error: 'bad-request' });
    }
    if (!limitClaim(userId)) return res.status(429).json({ ok: false, error: 'rate' });

    const wantedChannel = String(req.body?.channelId || '').trim();
    const wantedName = String(req.body?.channelName || '').trim().toLowerCase();
    if (config.channelId) {
      if (wantedChannel !== config.channelId) {
        return res.status(403).json({ ok: false, error: 'wrong-channel', channel: channelLabel() });
      }
    } else if (wantedName && wantedName !== config.channelName.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'wrong-channel', channel: channelLabel() });
    }

    pruneCodes();
    const entry = codes.get(code);
    if (!entry) return res.status(404).json({ ok: false, error: 'unknown-code' });
    if (Date.now() - entry.at > CODE_TTL_MS) {
      codes.delete(code);
      return res.status(410).json({ ok: false, error: 'expired-code' });
    }
    if (entry.claimed && entry.claimed.claims.userId !== userId) {
      return res.status(409).json({ ok: false, error: 'already-used' });
    }

    /* Confirm with Discord that this account is really in the server. The bot already knows,
       but the gate should not take the caller's word for it. */
    const check = await membership(userId, { fresh: true });
    if (check.state === 'absent') return res.status(403).json({ ok: false, error: 'not-member' });
    if (check.state === 'member' && !check.member) return res.status(403).json({ ok: false, error: 'missing-role' });

    const name = userName || check.userName || 'member';
    const { claims, token } = mintSession(userId, name);
    entry.claimed = { claims, token };
    members.set(userId, { state: 'member', member: true, roles: check.roles || [], userName: name, at: Date.now() });

    log.log?.(`[Discord gate] ${name} (${userId}) linked with code ${code}`);
    return res.json({ ok: true, user: { id: claims.userId, name: claims.userName } });
  });

  /* ── browser: am I still allowed? ──────────────────────────────────── */
  app.get('/api/discord/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = readSession(req);
    const base = {
      configured: Boolean(config.enabled && config.configured),
      channel: channelLabel(),
      invite: config.invite,
      guildId: config.guildId
    };
    if (!config.enabled) return res.json({ ...base, configured: false, verified: false, reason: 'disabled' });
    if (!config.configured) return res.json({ ...base, configured: false, verified: false, reason: 'not-configured' });
    if (!session) return res.json({ ...base, verified: false });

    /* A linked browser keeps access until the account leaves the server. 'unknown' (Discord
       unreachable, bot offline) never revokes — only a definite 404 does. */
    const check = await membership(session.userId);
    if (check.state === 'absent') {
      return res.json({ ...base, verified: false, code: 'left-server', message: 'You are not in the Discord server any more.' });
    }
    if (check.state === 'member' && !check.member) {
      return res.json({ ...base, verified: false, code: 'norole', message: `You are missing the required role in the server.` });
    }
    return res.json({
      ...base,
      verified: true,
      user: { id: session.userId, name: session.userName },
      checkedAt: Date.now()
    });
  });

  /* Deliberately forget-my-link. The token lives in the browser, so the browser drops it; this
     route exists so an old bookmark or a stale client gets a clean answer. */
  app.post('/api/discord/logout', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, forgetToken: true });
  });

  /* ── the stream itself ─────────────────────────────────────────────── */
  app.get('/api/discord/4k', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = readSession(req);
    if (!config.enabled || !config.configured) {
      return res.status(503).json({ error: '4K is not configured on the server.', code: 'unavailable' });
    }
    if (!session) return res.status(401).json({ error: 'Link your Discord to watch in 4K.', code: 'not-verified' });

    const check = await membership(session.userId);
    if (check.state === 'absent') return res.status(403).json({ error: 'You are not in the Discord server.', code: 'left-server' });
    if (check.state === 'member' && !check.member) return res.status(403).json({ error: 'You are missing the required role.', code: 'norole' });

    const url = await resolveUhdUrl();
    if (!url) return res.status(503).json({ error: 'The 4K channel is not listed right now.', code: 'unavailable' });
    return res.json({ url, userName: session.userName });
  });

  /* ── diagnostics ───────────────────────────────────────────────────── */
  app.get('/api/discord/debug', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      enabled: config.enabled,
      configured: config.configured,
      hasGuildId: Boolean(config.guildId),
      hasBotToken: Boolean(config.botToken),
      hasBotSecret: Boolean(config.botSecret),
      channelId: config.channelId || null,
      channelName: config.channelName,
      requiresRole: Boolean(config.requiredRole),
      /* 'env' (SESSION_SECRET/ADMIN_SECRET), 'bot-token' (derived, still stable across deploys)
         or 'none'. Never the key itself. */
      sessionKeySource: config.secretSource,
      sessionKeyStable: config.secretSource !== 'none',
      invite: config.invite || null,
      pendingCodes: codes.size,
      cachedMembers: members.size,
      codeTtlMinutes: Math.round(CODE_TTL_MS / 60000)
    });
  });

  return {
    summary: () => ({
      enabled: config.enabled,
      configured: config.configured,
      channel: channelLabel()
    })
  };
}

module.exports = { createDiscordGate, _test: { readConfig, deriveSessionKey, sign, b64url, unb64url, randomCode, CODE_TTL_MS, MEMBER_CACHE_MS } };
