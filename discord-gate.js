'use strict';

/* ════════════════════════════════════════════════════════════════════
   Discord membership gate — unlocks the 4K feed for server members
   ════════════════════════════════════════════════════════════════════
   Flow
     1. The browser asks GET /api/discord/status. If it has a valid signed
        cookie it gets { verified: true }; otherwise { configured: true,
        verified: false, invite }.
     2. "Unlock" sends the visitor to GET /api/discord/login, which redirects
        to Discord with scope "identify guilds" and a signed state cookie.
     3. GET /api/discord/callback exchanges the code, reads /users/@me and
        /users/@me/guilds and checks the configured guild id. If
        DISCORD_REQUIRED_ROLE is set it additionally asks the bot for that
        member's roles.
     4. On success it sets an httpOnly, signed, 7-day cookie and sends the
        visitor back to the site with ?discord=verified.
     5. GET /api/discord/4k returns the 4K embed url — and nothing else in the
        app ever knows it, so the id is not sitting in the public bundle.

   Trust model, stated plainly: this is a funnel, not DRM. The embdlol channel
   directory (api.embdlol.st/struct) is public, so a determined visitor can
   find the 4K stream without us. The gate keeps the url out of the bundle,
   makes joining the natural path, and re-checks membership periodically so
   people who leave lose it again.

   Needs: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID.
   Optional: DISCORD_GUILD_INVITE, DISCORD_REQUIRED_ROLE (needs the bot in the
   server with GUILD_MEMBERS), DISCORD_SESSION_SECRET (falls back to
   ADMIN_SECRET), DISCORD_GATE_ENABLED=false to switch the whole thing off.
   ════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const DISCORD_API = String(process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const EMBDLOL_STRUCT = 'https://api.embdlol.st/struct';
const EMBDLOL_EMBED = 'https://embdlol.st/embed/';
const UHD_CHANNEL_NAME = 'f1friuhd';

const COOKIE_NAME = 'freef1_dg';
const STATE_COOKIE = 'freef1_dg_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REVERIFY_MS = 10 * 60 * 1000;

function readConfig(env) {
  const clientId = String(env.DISCORD_CLIENT_ID || '').trim();
  const clientSecret = String(env.DISCORD_CLIENT_SECRET || '').trim();
  const guildId = String(env.DISCORD_GUILD_ID || '').trim();
  return {
    enabled: String(env.DISCORD_GATE_ENABLED || 'true').toLowerCase() !== 'false',
    clientId,
    clientSecret,
    guildId,
    invite: String(env.DISCORD_GUILD_INVITE || '').trim(),
    requiredRole: String(env.DISCORD_REQUIRED_ROLE || '').trim(),
    botToken: String(env.DISCORD_BOT_TOKEN || '').trim(),
    secret: String(env.DISCORD_SESSION_SECRET || env.ADMIN_SECRET || 'freef1-discord-gate'),
    get configured() { return Boolean(this.clientId && this.clientSecret && this.guildId); }
  };
}

/* ── signed cookie helpers ─────────────────────────────────────────── */
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

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 1) return;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });
  return out;
}

function serializeCookie(name, value, { maxAge, sameSite = 'None', path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'Secure', `SameSite=${sameSite}`];
  if (Number.isFinite(maxAge)) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`);
  return bits.join('; ');
}

/* ── rate limiting (per instance, per IP) ──────────────────────────── */
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
  const limitAuth = makeLimiter(20, 60_000);

  /* Membership cache so /4k does not hit Discord on every click. */
  const verifiedAt = new Map();
  /* embdlol channel cache. */
  let uhd = { url: '', at: 0 };

  /* The callback has to come back to THIS server, not to the Netlify site, so it is derived
     from the incoming request (trust proxy is set upstream) with an env override for cases
     where the public host differs from the internal one. */
  const CALLBACK_PATH = '/api/discord/callback';

  /* Discord requires a character-for-character match with a redirect registered in the portal,
     so this is built defensively:
       1. DISCORD_REDIRECT_URI if set (trimmed, trailing slash removed)
       2. RENDER_EXTERNAL_URL, which Render sets for us — no proxy guesswork
       3. PUBLIC_API_URL
       4. the request's own host, with https forced (behind Render's proxy req.protocol can
          still read "http", which is the classic way to get invalid redirect_uri)
     localhost keeps http so local testing still works. */
  function baseOrigin(req) {
    const explicit = String(process.env.DISCORD_REDIRECT_URI || '').trim();
    if (explicit) return explicit.replace(/\/+$/, '');

    const render = String(process.env.RENDER_EXTERNAL_URL || '').trim();
    if (render) return `${render.replace(/\/+$/, '')}${CALLBACK_PATH}`;

    const publicApi = String(process.env.PUBLIC_API_URL || '').trim();
    if (publicApi) return `${publicApi.replace(/\/+$/, '')}${CALLBACK_PATH}`;

    const host = String(req?.get?.('host') || '').trim();
    if (host) {
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
      const proto = local ? 'http' : 'https';
      return `${proto}://${host}${CALLBACK_PATH}`;
    }
    return `https://f1admin.onrender.com${CALLBACK_PATH}`;
  }

  const callbackUri = baseOrigin;

  function readSession(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!raw || !raw.includes('.')) return null;
    const [body, mac] = raw.split('.');
    if (!safeEqual(mac, sign(body, config.secret))) return null;
    try {
      const claims = JSON.parse(unb64url(body));
      if (!claims || typeof claims.userId !== 'string' || claims.exp < Date.now()) return null;
      return claims;
    } catch (_) {
      return null;
    }
  }

  function writeSession(res, claims) {
    const body = b64url(JSON.stringify(claims));
    res.append('Set-Cookie', serializeCookie(COOKIE_NAME, `${body}.${sign(body, config.secret)}`, { maxAge: SESSION_TTL_MS }));
  }

  function clearSession(res) {
    res.append('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAge: 0 }));
    res.append('Set-Cookie', serializeCookie(STATE_COOKIE, '', { maxAge: 0, sameSite: 'Lax' }));
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

  /* Adds the visitor to the server using their own access token. Needs the bot in the server
     with Create Invite, and the guilds.join scope on that token — the user still approves the
     "join you to servers" line on Discord's consent screen, because Discord never allows a
     silent add. Returns a reason on failure so the caller can say something useful. */
  async function addToGuild(userId, accessToken) {
    if (!config.botToken) return { ok: false, reason: 'no-bot-token' };
    if (!accessToken) return { ok: false, reason: 'no-user-token' };
    try {
      const response = await fetchJson(`${DISCORD_API}/guilds/${config.guildId}/members/${userId}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${config.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken })
      });
      /* 201 = added now, 204 = was already a member. Both mean "you are in". */
      if (response.ok || response.status === 204) return { ok: true };
      /* 403 / code 50013 = the bot lacks permission. 400 / 50026 = token lacks guilds.join. */
      log.warn?.('[Discord gate] auto-join refused:', response.status, String(response.text || '').slice(0, 160));
      return { ok: false, reason: response.status === 403 ? 'bot-missing-permission' : 'refused', status: response.status };
    } catch (error) {
      log.warn?.('[Discord gate] auto-join error:', error.message);
      return { ok: false, reason: 'network' };
    }
  }

  /* Asks Discord whether this user is in the guild, and optionally holds the role. */
  async function checkMembership(userId, accessToken) {
    if (config.requiredRole && config.botToken) {
      const member = await fetchJson(`${DISCORD_API}/guilds/${config.guildId}/members/${userId}`, {
        headers: { Authorization: `Bot ${config.botToken}` }
      });
      if (member.ok && member.json) {
        const roles = Array.isArray(member.json.roles) ? member.json.roles : [];
        return { member: true, role: roles.includes(config.requiredRole) || Boolean(member.json.user && member.json.user.id === userId && roles.includes(config.requiredRole)) };
      }
      /* 404 means "not in the server"; anything else falls through to the user-token check. */
      if (member.status === 404) return { member: false, role: false };
    }
    const guilds = await fetchJson(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!guilds.ok || !Array.isArray(guilds.json)) {
      return { member: false, role: false, error: `guilds ${guilds.status}` };
    }
    const member = guilds.json.some((guild) => String(guild.id) === config.guildId);
    return { member, role: member ? !config.requiredRole : false };
  }

  /* Resolving the 4K channel means one call to embdlol's directory. That call is the only
     thing standing between a verified member and their feed, so it is cached for half an hour,
     retried once on failure, and never allowed to discard a url we already know works. A stale
     url beats a 503 that makes the site look like it revoked someone's access. */
  const UHD_REFRESH_MS = 30 * 60_000;
  let uhdFailureAt = 0;

  async function resolveUhdUrl() {
    const override = String(process.env.DISCORD_4K_URL || '').trim();
    if (override) return override;

    if (uhd.url && Date.now() - uhd.at < UHD_REFRESH_MS) return uhd.url;
    /* Do not hammer a failing directory: back off for a minute after a bad attempt. */
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
        /* Directory answered but has no 4K entry: keep whatever we had. */
        break;
      } catch (error) {
        log.warn?.(`[Discord gate] embdlol struct attempt ${attempt + 1} failed:`, error.message);
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    uhdFailureAt = Date.now();
    return uhd.url;
  }

  /* The session cookie is read from the Netlify origin, so these routes must answer with
     credentialed CORS. The global allowlist has already rejected foreign origins by here. */
  app.use('/api/discord', (req, res, next) => {
    const origin = String(req.headers.origin || '').trim();
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /* ── routes ──────────────────────────────────────────────────────── */

  app.get('/api/discord/status', (req, res) => {
    const session = readSession(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!config.enabled) return res.json({ configured: false, verified: false, reason: 'disabled' });
    if (!config.configured) return res.json({ configured: false, verified: false, reason: 'not-configured' });
    if (!session) return res.json({ configured: true, verified: false, invite: config.invite, guildId: config.guildId });
    return res.json({
      configured: true,
      verified: true,
      invite: config.invite,
      user: { id: session.userId, name: session.userName },
      checkedAt: session.at,
      expiresAt: session.exp
    });
  });

  /* Whatever this prints must be pasted into the Discord portal character for character.
     No secrets in the response. */
  app.get('/api/discord/debug', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      redirectUri: callbackUri(req),
      registeredInPortalMustMatch: callbackUri(req),
      source: process.env.DISCORD_REDIRECT_URI ? 'DISCORD_REDIRECT_URI'
        : process.env.RENDER_EXTERNAL_URL ? 'RENDER_EXTERNAL_URL'
        : process.env.PUBLIC_API_URL ? 'PUBLIC_API_URL'
        : 'request host',
      configured: config.configured,
      hasClientId: Boolean(config.clientId),
      hasClientSecret: Boolean(config.clientSecret),
      guildId: config.guildId || null,
      requiresRole: Boolean(config.requiredRole),
      portalChecklist: [
        'Discord Developer Portal → your application → OAuth2 → Redirects',
        'Add the exact redirectUri above (https, no trailing slash)',
        'Save Changes',
        'If a redirect is already listed that looks similar, remove it — near matches still fail'
      ]
    });
  });

  app.get('/api/discord/login', (req, res) => {
    if (!config.configured) return res.status(503).json({ error: 'Discord gate is not configured' });
    if (!limitAuth(clientIp(req))) return res.status(429).json({ error: 'Too many attempts, try again shortly' });
    const state = crypto.randomBytes(24).toString('hex');
    const uri = callbackUri(req);
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: uri,
      response_type: 'code',
      scope: 'identify guilds guilds.join',
      state,
      prompt: 'consent'
    });
    log.log?.(`[Discord gate] login → redirect_uri=${uri}`);
    res.append('Set-Cookie', serializeCookie(STATE_COOKIE, state, { maxAge: 10 * 60_000, sameSite: 'Lax' }));
    res.redirect(302, `https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get('/api/discord/callback', async (req, res) => {
    const back = (query) => res.redirect(302, `${siteUrl.replace(/\/+$/, '')}/?discord=${query}`);
    if (!config.configured) return back('unavailable');
    if (!limitAuth(clientIp(req))) return back('rate');
    const cookies = parseCookies(req.headers.cookie);
    const { code, state, error } = req.query;
    if (error) return back('cancelled');
    if (!code || !state || !cookies[STATE_COOKIE] || !safeEqual(String(state), cookies[STATE_COOKIE])) {
      return back('badstate');
    }
    let payload;
    try {
      const tokenResponse = await fetchJson(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: callbackUri(req)
        }).toString()
      });
      payload = tokenResponse.json;
      if (!tokenResponse.ok || !payload?.access_token) {
        log.warn?.('[Discord gate] token exchange failed:', tokenResponse.status, tokenResponse.text.slice(0, 160));
        return back('token');
      }
    } catch (err) {
      log.warn?.('[Discord gate] token exchange error:', err.message);
      return back('token');
    }

    let wasJoined = false;
    try {
      const me = await fetchJson(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${payload.access_token}` } });
      if (!me.ok || !me.json?.id) return back('profile');
      const userId = String(me.json.id);
      let check = await checkMembership(userId, payload.access_token);

      if (!check.member) {
        /* Verified, but not in the server: put them in it, then check again. */
        const joined = await addToGuild(userId, payload.access_token);
        if (!joined.ok) {
          log.warn?.('[Discord gate] could not auto-join:', joined.reason);
          return back(joined.reason === 'no-bot-token' ? 'notmember' : 'joinfailed');
        }
        check = await checkMembership(userId, payload.access_token);
        if (!check.member) {
          /* Discord accepted the add but has not caught up yet — treat as joined anyway so the
             visitor is not bounced; the next status call re-checks. */
          check = { member: true, role: true };
        }
        wasJoined = true;
      }
      if (config.requiredRole && !check.role) return back('norole');
      writeSession(res, {
        userId: String(me.json.id),
        userName: String(me.json.username || 'member'),
        guildId: config.guildId,
        at: Date.now(),
        exp: Date.now() + SESSION_TTL_MS
      });
      verifiedAt.set(userId, Date.now());
      return back(wasJoined ? 'joined' : 'verified');
    } catch (err) {
      log.warn?.('[Discord gate] verification error:', err.message);
      return back('error');
    }
  });

  app.get('/api/discord/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  /* The 4K url itself: only ever handed to a verified member. */
  app.get('/api/discord/4k', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.configured) return res.status(503).json({ error: 'Discord gate is not configured' });
    const session = readSession(req);
    if (!session) return res.status(403).json({ error: 'Join the Discord server to unlock 4K', code: 'not-verified', invite: config.invite });

    /* Re-check occasionally so leaving the server takes the feed away again. */
    const last = verifiedAt.get(session.userId) || 0;
    if (config.botToken && Date.now() - last > REVERIFY_MS) {
      try {
        const member = await fetchJson(`${DISCORD_API}/guilds/${config.guildId}/members/${session.userId}`, {
          headers: { Authorization: `Bot ${config.botToken}` }
        });
        if (member.status === 404) {
          clearSession(res);
          return res.status(403).json({ error: 'You are no longer in the Discord server', code: 'left-server', invite: config.invite });
        }
        verifiedAt.set(session.userId, Date.now());
      } catch (_) {
        /* Discord unreachable: keep the session rather than punish the visitor. */
      }
    }

    const url = await resolveUhdUrl();
    if (!url) return res.status(503).json({ error: 'The 4K channel is not published right now', code: 'no-channel' });
    return res.json({ url, expiresAt: session.exp });
  });

  if (config.enabled) {
    if (config.configured) {
      log.log?.(`[Discord gate] enabled · guild ${config.guildId}${config.requiredRole ? ` · role ${config.requiredRole}` : ''} · redirect ${callbackUri()}`);
    } else {
      log.log?.('[Discord gate] disabled until DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_GUILD_ID are set');
    }
  }

  return {
    config,
    readSession,
    /* Used by the admin dashboard to show gate health without exposing secrets. */
    summary: () => ({
      enabled: config.enabled,
      configured: config.configured,
      guildId: config.guildId || null,
      requiresRole: Boolean(config.requiredRole),
      redirectUri: process.env.DISCORD_REDIRECT_URI || `${String(process.env.PUBLIC_API_URL || 'https://f1admin.onrender.com').replace(/\/+$/, '')}/api/discord/callback`
    })
  };
}

module.exports = { createDiscordGate, sign, b64url, unb64url, safeEqual };
