# Members-only 4K feed

The 4K feed is locked behind Discord server membership. Non-members see a dashed
"F1 UHD 4K · Members" chip; members get the real feed and the player switches to it
automatically the moment they finish signing in.

## What actually gates it

| layer | what it does |
|---|---|
| `GET /api/discord/status` | tells the site whether this browser holds a valid member session |
| `GET /api/discord/login` | redirects to Discord with `identify guilds`, plus a signed `state` cookie |
| `GET /api/discord/callback` | exchanges the code, reads `/users/@me` and `/users/@me/guilds`, checks the guild, optionally the role, then sets a 7-day signed **httpOnly** cookie |
| `GET /api/discord/4k` | the only place the 4K url exists. 403 for anyone without a valid session |
| `GET /api/discord/logout` | clears it |

The 4K channel id is **not in the public bundle** — verified by grepping the built assets.
The browser cannot forge the cookie: it is HMAC-signed server-side and the payload is
never trusted from the client.

## Exact values, and where each one lives

| Render variable | Discord portal location | what it looks like |
|---|---|---|
| `DISCORD_CLIENT_ID` | General Information → **Application ID**, or OAuth2 → **Client ID** | 18–19 digit number, e.g. `1234567890123456789`. **These two are the same number.** |
| `DISCORD_CLIENT_SECRET` | OAuth2 → **Client Secret** → *Reset Secret* | long random string, shown **once** |
| `DISCORD_GUILD_ID` | your **server**, not the app | 18–19 digit number, different from the app id |
| `DISCORD_GUILD_INVITE` | you create it: server → Invite People → copy link | `https://discord.gg/abc123` |

Two things that are easy to grab by mistake:

- **Public Key** (General Information) is a 64-character hex string — not the client id.
- **DISCORD_BOT_TOKEN** is the bot's token, not the client secret. You already have that one.

Fastest way to get the server id: run the helper with the token your bot already uses.

```bash
cd f1admin
DISCORD_BOT_TOKEN=xxxxx node scripts/discord-ids.js
```

It prints the application id (`DISCORD_CLIENT_ID`) and every server the bot is in with its id
(`DISCORD_GUILD_ID`), so nothing has to be copy-pasted out of Discord's UI. It cannot print the
client secret — Discord only ever shows that in the portal.

## Setup (about 5 minutes)

1. **Create the Discord app** — <https://discord.com/developers/applications> → New
   Application → OAuth2.
2. **Add the redirect URI** exactly:
   `https://f1admin.onrender.com/api/discord/callback`
   (must match character for character, including `https` and no trailing slash)
3. **Copy the credentials** — Client ID and Client Secret into Render's environment.
4. **Get your guild id** — Discord → User Settings → Advanced → Developer Mode on, then
   right-click your server icon → Copy Server ID.
5. **Set the env vars on Render:**

   ```
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   DISCORD_GUILD_ID=...
   DISCORD_GUILD_INVITE=https://discord.gg/your-invite
   DISCORD_REDIRECT_URI=https://f1admin.onrender.com/api/discord/callback
   ```

6. **Redeploy.** The log prints
   `[Discord gate] enabled · guild <id> · redirect …` when it is live.

Until those three required vars are set, the gate reports `configured: false` and the
site shows **no** 4K chip at all — nothing breaks, the feature is simply absent.

## Optional: require a role as well

Set `DISCORD_REQUIRED_ROLE` to a role id and make sure `DISCORD_BOT_TOKEN` (already used by
your bot) has the **GUILD_MEMBERS** privileged intent and is in the server. The gate then
asks the bot for that member and checks the role, and the 4K call re-checks every 10 minutes
so somebody who loses the role loses the feed.

Without a role requirement the membership check uses the member's own `guilds` scope — no
bot involvement at all, so it keeps working even if the bot is offline.

## Be clear-eyed about the strength of this

This is a **funnel, not DRM**. `api.embdlol.st/struct` is a public endpoint, so anyone who
reads this repo's notes can find the 4K channel without joining. What the gate genuinely
buys you:

- the 4K url is not in the JavaScript bundle, so it is not a one-line "view source" grab;
- joining is the obvious, one-click path, which is the point;
- people who leave the server lose access again within 10 minutes (with a bot token).

It does not stop a determined person, and no browser-side gate could. If you ever need it
to be real, the only honest version is proxying the video itself, which is a bandwidth bill
you do not want on Render's free tier.

## Files

| file | change |
|---|---|
| `discord-gate.js` | **new** — the whole gate, self-contained |
| `server.js` | mounts it after `/healthz`, and reports `discordGate` health on `/admin/api/config` |
| `.env.example` | the six new variables |
| `netlifyf1/src/app.ts` | `gated` sources, `discordGate` state, locked chip, `?discord=` handling, 4K url fetched from the API |
| `netlifyf1/src/styles/app.css` | `.chip-locked` styling |

## Verified

- Cookie signing: valid verifies, tampered payload rejected, wrong secret rejected.
- Four UI states driven against stubbed endpoints: unverified → locked chip only;
  verified → real 4K chip, iframe src comes from the server; not-configured → no chip;
  left-server (403) → locks again with a toast.
- Backend regression: smoke 44/44, admin DOM 14/14. Frontend 24/24, typecheck and build clean.

## Troubleshooting: `invalid redirect_uri`

Discord matches the `redirect_uri` **character for character** against the list in
OAuth2 → Redirects. One character off and the sign-in is refused before anything else
happens.

**1. Ask the server what it is actually sending.** No login needed, no secrets in the reply:

```bash
curl -s https://f1admin.onrender.com/api/discord/debug
```

```json
{
  "redirectUri": "https://f1admin.onrender.com/api/discord/callback",
  "source": "RENDER_EXTERNAL_URL",
  "configured": true,
  "guildId": "…"
}
```

**2. Paste that exact string into** Developer Portal → your application → OAuth2 → Redirects,
then Save Changes.

**3. Delete near-misses.** If the portal already has `…/callback/`, `http://…` or the Netlify
domain, remove them. Discord does not "pick the closest" — a stale similar entry plus a new one
still fails if the sent value does not match a listed value exactly.

### The four things that cause this

| cause | symptom in `/api/discord/debug` | fix |
|---|---|---|
| Behind Render's proxy `req.protocol` reads `http` | `redirectUri` starts with `http://…onrender.com` | fixed in code — https is now forced for any non-localhost host |
| Portal has a different value (trailing slash, www, Netlify domain) | `redirectUri` correct but still refused | paste the debug value into the portal verbatim |
| `DISCORD_REDIRECT_URI` set with a trailing slash or space | shows the messy value | fixed in code — trimmed and de-slashed |
| Redirect never added to the portal | `configured: true` but Discord refuses | add it, Save Changes |

### The resolution order used to build it

1. `DISCORD_REDIRECT_URI` (trimmed, trailing slash removed)
2. `RENDER_EXTERNAL_URL` — Render sets this automatically, so this is the reliable default
3. `PUBLIC_API_URL`
4. the request's own `Host`, with `https` forced unless it is localhost

Local testing still works because localhost stays on `http`, which is why the debug endpoint
above shows `http://127.0.0.1:3112/…` when run on your machine.

Every login attempt also logs the exact value it sent:

```
[Discord gate] login → redirect_uri=https://f1admin.onrender.com/api/discord/callback
```

so Render's log and the portal can be compared in one glance.

## Fixes after first live test

**The chip sent verified members back to sign-in.** `/api/discord/4k` can fail for reasons that
are nothing to do with membership — the embdlol directory lookup timing out returned 503, and the
frontend treated *any* failure as "not a member", flipping the chip back to its locked state so
the next click started the OAuth round trip again. Now:

- only `not-verified` and `left-server` downgrade someone; a 500, 503, timeout or network error
  leaves them verified and shows a plain message instead;
- clicking an unlocked chip with no url retries the url, it never re-authenticates;
- the server caches the resolved 4K url for 30 minutes, retries the directory once with a 9 s
  timeout, keeps a known-good url even if a later lookup fails, and backs off a minute after a
  failure rather than hammering;
- `DISCORD_4K_URL` can pin the embed url outright, removing the directory from the critical path.

**Lock icon removed** from the members chip; it reads `F1 UHD 4K · Members`.

Verified against a running server with a real signed cookie: valid session → `200` with the url
(4.6 s cold, then cached), expired cookie → `403 not-verified`, forged cookie → treated as
anonymous. In the browser, five states confirmed: url ok → plays the server-supplied id;
503 → stays unlocked, no auth redirect; 500 → same; expired → locks, no redirect loop;
non-member → members chip. No state sends anyone to `/api/discord/login` except pressing the
members chip itself.

## Auto-join: adds people who are not in the server

Flow is sign-in → **added to the server automatically** → verified. No "accept invite" step.

How it works:

1. The OAuth request asks for `identify guilds guilds.join`. `guilds.join` is what permits the
   server to add the visitor using their own access token.
2. After the code exchange the gate calls `/users/@me/guilds`. If the guild is not in the list it
   does `PUT /guilds/<guild>/members/<user>` with `{ access_token }` and the **bot** token.
3. Discord answers `201` (added) or `204` (already in). The gate then re-checks and issues the
   session cookie, returning `?discord=joined` so the site says "Added to the Discord server."

**Requirements — both of these or it silently degrades:**

- the bot is **in** the server and has **Create Invite** (`CREATE_INSTANT_INVITE`);
- `DISCORD_BOT_TOKEN` is set (you already have it for Race Control).

If either is missing, Discord refuses with 403/50013 or 400/50026. The gate then returns
`?discord=joinfailed`, the visitor is **not** verified, and the message tells them to use the
invite and try again. Nothing breaks; they just take the manual route.

The user always sees Discord's consent screen listing "Join you to servers" — Discord does not
allow a silent add, and no site can bypass that.

### Verified with a stub Discord API

| case | result | auto-join call | session |
|---|---|---|---|
| not in server, bot can add | `joined` | PUT sent, 201 | cookie issued |
| already in server | `verified` | not called | cookie issued |
| not in server, bot lacks permission | `joinfailed` | PUT sent, 403 | **no** cookie |

Run the same check yourself with `DISCORD_API_BASE` pointed at a stub; that variable exists purely
so this path can be tested without touching real Discord.
