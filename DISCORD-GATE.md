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
