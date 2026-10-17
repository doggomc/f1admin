# Render deployment — FreeF1 Race Control

The public FreeF1 site is a static Netlify deployment. This Render service is a
small **control plane** at `https://f1admin.onrender.com`: it serves the
password-protected admin page, a cacheable public config endpoint and a
push-only config update stream, and (optionally) the existing Discord bot and
low-bandwidth Help-ticket API. It does not proxy streams, standings, OpenF1
data, or video, and it does not collect visitor analytics, page views, or
presence. Help-ticket traffic is separate from playback and is disabled until
the Discord and storage settings below are deliberately enabled. The aggregate live page-connection count is handled
separately by a Cloudflare Worker and is not sent to this Render backend.

## What still works if Render is asleep or offline

- Stream URLs are embedded directly by the visitor's browser from their stream
  hosts. Video bytes never pass through Render.
- Session, radio, race-control, result, and career data are requested directly
  from OpenF1 or Jolpica by the browser. The app keeps bounded in-memory and
  localStorage fallbacks (up to seven days for most API results, with longer
  season/session metadata); a Render outage does not affect these requests.
- Race Control settings (disabled sources, stream override, maintenance) arrive
  over a small optional config channel. News data remains in the authenticated
  admin tools, and its public config array stays empty while News is hidden. The
  browser uses local defaults and a saved snapshot if the service cannot be
  reached; stale maintenance state does not lock the site behind a maintenance screen.
- The Discord bot remains optional. Session alerts/presence start when
  `DISCORD_BOT_TOKEN` is set and retains its own `freef1:discordbot:v1` state.
  Help tickets additionally require the explicit `DISCORD_TICKETS_ENABLED=true`
  flag, a ready Discord guild/bot, and durable ticket metadata storage. If that bridge is offline, only Help ticket create,
  chat, and updates are unavailable; the static site and playback remain usable.

An internet outage or an upstream OpenF1/Jolpica outage is a separate issue:
only data that has already been cached in that browser can be shown offline.

## Render service settings

- **Root directory:** repository root (`f1free`)
- **Build command:** `npm ci`
- **Start command:** `npm start`
- **Runtime:** Node 18.11 or newer
- **Health check path:** `/healthz`
- **Bind address:** the app listens on `0.0.0.0` and Render's `PORT`

The app's backend URL is set in the static site at
`netlifyf1/app.js` (`https://f1admin.onrender.com`). If the Render hostname is
changed, update that constant and the CSP in `netlifyf1/_headers` together.

### Required environment variables

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production`. |
| `ADMIN_USER` | Race Control login username. |
| `ADMIN_PASS` | Strong password; default minimum is 12 characters (16 recommended). |
| `ADMIN_SECRET` | At least 32 random characters for signing the admin session cookie; use 64 hex characters. |
| `ALLOWED_ORIGIN` | Public site origin, normally `https://freef1.netlify.app`. Netlify deploy-preview origins for this site are also allowed. |
| `TRUST_PROXY_HOPS` | `1` on Render. Increase only if you deliberately add another trusted proxy. |
| `PUBLIC_NEWS_ENABLED` | Optional; leave false/unset to exclude published News from public config while retaining admin data and CRUD. Set true only when re-enabling the frontend view too. |

Generate a strong session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The server refuses to start in production if admin credentials or the cookie
secret are missing or weak. Admin cookies are HTTP-only, Secure in production,
SameSite=Strict, and expire after eight hours. Login attempts are rate-limited
in memory. Optionally set `ADMIN_IP_ALLOWLIST` to a comma-separated list of
IPv4 addresses/CIDRs (for example `102.132.7.9,41.13.0.0/16`) to hide `/admin`
from other addresses.

### Settings persistence (recommended)

Admin settings need durable storage if they must survive Render redeploys. Use
**either**:

1. **Upstash Redis REST** (recommended): set `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`; or
2. a Render persistent disk mounted at a path such as `/var/data/freef1`, and
   set `DATA_DIR=/var/data/freef1`.

Redis is not required for the process to start. Without Upstash, settings are
saved to a local JSON snapshot in `DATA_DIR`; on Render's ephemeral filesystem
those changes can be lost on restart. The admin UI shows when persistence is
local-only or in memory. Upstash reads occur at service startup; a single small
snapshot write occurs only after an admin changes a setting. There is no
per-visitor storage traffic.

Help-ticket metadata uses a separate Upstash key (`freef1:help-tickets:v1`) or
`help-tickets.json` in `DATA_DIR`; ticket message bodies are stored in the
private Discord channel, not copied into the metadata snapshot. In production,
the Help API fails closed if neither Upstash nor an explicitly configured
persistent disk is available. The browser only sends small text messages; the
backend never proxies video or image uploads.

The startup migration reads existing Race Control settings from the old local
JSON files / legacy Redis keys once per boot, then writes the compact combined
snapshot on the next admin change. In the same bounded Redis startup pipeline,
the retired analytics, unique-visitor, login-guard, and stream-target keys are
deleted. The legacy Force Live key is read into the combined snapshot before
any cleanup, so its setting is preserved. The Discord bot's separate key is
preserved.

## Public configuration contract

`GET /api/site/updates` is the public site's push-only configuration channel.
It sends one compact snapshot when a tab connects and another whenever a
Race Control setting changes. The stream is cross-origin-readable only by the
configured public site and its Netlify deploy-preview hosts. Open tabs keep one
push-only connection even when backgrounded, so maintenance changes reach them
without polling; after a disconnect/reconnect the server sends a fresh snapshot. It sends no periodic heartbeat and collects no
visitor identity or analytics. This makes maintenance, Force Live, source, and
stream-override changes visible to connected public tabs immediately without a
refresh. News records and admin CRUD remain intact, but public config returns
an empty News array unless the backend `PUBLIC_NEWS_ENABLED=true`; the frontend
view also remains hidden while `PUBLIC_NEWS_ENABLED=false` in
`netlifyf1/app.js`. To restore the feed later, enable both flags, restore the
public News navigation link, and remove the temporary `/news` redirects.
Stream playback and sports data still connect directly from
the browser to their providers; Render does not proxy them.

`GET /api/site/config` remains available as a cacheable compatibility endpoint
(`Cache-Control: public, max-age=300`) and one-shot fallback for browsers without
EventSource support. The browser also keeps the latest compact snapshot locally
for offline startup (up to 30 days). Maintenance is only enforced using a live
server snapshot, so stale cached state cannot lock users out when Render is
offline. The maintenance page listens to the same update stream and returns to
the public site automatically when Race Control disables maintenance.

### Help tickets (opt-in)

Help tickets are disabled by default and are separate from the public config
stream. To enable them, configure `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_OWNER_ID`, durable ticket storage (`UPSTASH_REDIS_REST_URL` plus
`UPSTASH_REDIS_REST_TOKEN`, or `DATA_DIR` on a Render persistent disk), and set
`DISCORD_TICKETS_ENABLED=true`. In the Discord Developer Portal, enable the
privileged **Message Content Intent**; grant the bot **Manage Channels** plus
View Channel, Send Messages, Read Message History, and Embed Links in the ticket
category. Optional `DISCORD_TICKET_CATEGORY_ID` and
`DISCORD_TICKET_STAFF_ROLE_ID` variables select the parent category and support
role. See [`bot/README.md`](bot/README.md) for the exact setup.

The static Help page calls these small endpoints:

- `GET /api/help/config` reports whether both bot and storage are ready.
- `POST /api/help/tickets` opens one sequentially named private channel per
  browser ticket key (name ≤48, initial message ≤4,000 characters).
- `GET /api/help/ticket/status` returns minimal state; `GET /api/help/ticket`
  returns the last 100 text messages from Discord.
- `POST /api/help/ticket/messages` sends text up to 2,000 characters.
- `GET /api/help/events` streams staff replies over SSE; it has no application
  heartbeat or polling fallback.
- `DELETE /api/help/ticket` deletes the private channel and backend metadata.

The browser creates a random ticket-specific key in localStorage; it is not a
verified identity. The server stores only its SHA-256 hash. Clearing browser
storage loses access to that ticket. Creation is rate-limited to 3 attempts per
10 minutes and 5 per day per keyed request-IP bucket; ticket messages are
limited to 10 per minute. Image/file uploads are intentionally disabled in this
release. These ticket endpoints use CORS with the configured public site origin
and `Authorization` bearer keys; they do not use admin cookies.

`GET /healthz` is a minimal deployment health check. The admin panel is at
`/admin/`; all mutation endpoints require a same-origin authenticated session.

## Discord bot (kept)

Set `DISCORD_BOT_TOKEN` to enable the existing Discord bot functions: session
alerts and presence, driver-role and alert panels, bot configuration and status,
test alerts, emoji management, and `/website`. The optional settings are
`DISCORD_GUILD_ID`, `DISCORD_OWNER_ID`, and `DISCORD_INVITE`. The voice relay
and `/watchparty` command are not part of the bot. Leave the token unset to
disable the bot without affecting the public site or Race Control. See
[`bot/README.md`](bot/README.md) and [`bot/STREAMING.md`](bot/STREAMING.md).

## Checks

```bash
npm run check
npm run check:security
```

`npm run check:site` and `npm run check:csp` read `../netlifyf1` by default. Set
`SITE_DIR` if you keep the frontend checkout elsewhere. `npm run check:discord`
checks that the retained bot commands are still registered and the removed
voice-relay feature does not return.
