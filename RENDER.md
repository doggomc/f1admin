# Render deployment — FreeF1 Race Control

The public FreeF1 site is a static Netlify deployment. This Render service is a
small **control plane** at `https://f1admin.onrender.com`: it serves the
password-protected admin page, one cacheable public configuration snapshot,
and (optionally) the existing Discord bot. It does not proxy streams, standings,
OpenF1 data, or video, and it does not collect visitor analytics, heartbeats,
page views, or presence.

## What still works if Render is asleep or offline

- Stream URLs are embedded directly by the visitor's browser from their stream
  hosts. Video bytes never pass through Render.
- Session, radio, race-control, result, and career data are requested directly
  from OpenF1 or Jolpica by the browser. The app keeps bounded in-memory and
  localStorage fallbacks (up to seven days for most API results, with longer
  season/session metadata); a Render outage does not affect these requests.
- Race Control settings (news, disabled sources, stream override, maintenance)
  are a small optional snapshot. The browser uses local defaults and a saved
  snapshot if the service cannot be reached; stale maintenance state does not
  lock the site behind a maintenance screen.
- The Discord bot remains a separate optional feature. It starts only when
  `DISCORD_BOT_TOKEN` is set and keeps its own `freef1:discordbot:v1` Redis key
  / `data/discord-bot.json` state.

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

The startup migration reads existing Race Control settings from the old local
JSON files / legacy Redis keys once per boot, then writes the compact combined
snapshot on the next admin change. In the same bounded Redis startup pipeline,
the retired analytics, unique-visitor, login-guard, and stream-target keys are
deleted. The legacy Force Live key is read into the combined snapshot before
any cleanup, so its setting is preserved. The Discord bot's separate key is
preserved.

## Public configuration contract

`GET /api/site/config` is the only endpoint used by public visitors. It returns
maintenance text/state, up to eight published news items, disabled stream
source IDs, an optional stream override, the Force Live schedule-window flag,
and the experimental-view flag. Force Live bypasses only the public site's
scheduled availability window for the selected session; stream playback still
connects directly from the browser to its source. It has
`Cache-Control: public, max-age=300`; the browser also stores a local
snapshot for up to 30 days and checks Race Control no more than once per five
minutes per browser. There is no SSE, long-polling, timer-driven refresh, or
visitor beacon. After changing a setting, a visitor may see the old cached
snapshot for up to five minutes; reloading after the cache expires fetches the
new one.

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
