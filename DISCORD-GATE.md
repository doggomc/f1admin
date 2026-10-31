# 4K Superlicense gate — `/link`

Members watch the 4K feed by linking their Discord account once. No OAuth, no redirects, no
cookies. The browser and the bot meet through a five-digit code.

## How a member experiences it

1. The **F1 UHD 4K** chip is a normal chip in the Feed Sources row, always visible, always
   clickable.
2. Clicking it (before linking) opens the **Superlicense** panel: one line of copy, a **Join the
   Discord** button, a generated command like `/link 48213`, a **Copy** target and a **Close**
   button.
3. They join the server if they have not already, run `/link 48213` in **#4k-access**.
4. The panel notices within about two seconds, closes itself and the 4K feed starts.
5. That browser keeps access for good. Nothing expires. Access ends only if the account is found
   to have left the server.

## Why this replaced the OAuth flow

The OAuth build needed `DISCORD_CLIENT_SECRET`, a registered redirect URI, a consent screen and
consent to a "join you to servers" prompt — and it broke outright whenever third-party cookies
were blocked, which is the default in Brave, Safari and a growing share of Chrome. The code
handshake needs none of that. It works in Brave with shields up, because the only storage involved
is `localStorage` on the site's own origin.

## The channel is command-only

`#4k-access` is not a chat. The bot deletes anything a human types there (new messages, edits,
other bots' posts, threads off the channel), and the first time in ten minutes somebody posts it
sends a nudge that removes itself after twelve seconds: *"this channel is for the /link command
only."* The bot leaves its own messages alone, so a pinned note survives.

`/link` replies are ephemeral, so the sweep never eats a member's confirmation.

This needs **Manage Messages** in that channel. On startup the bot checks and logs it plainly:

```
[Bot] #4k-access: sweeping messages (Manage Messages ok)
[Bot] #4k-access: missing Manage Messages, so messages there will NOT be deleted
[Bot] link channel #4k-access not found — message sweep and /link channel check are inactive
```

`DISCORD_LINK_SWEEP=false` turns the sweep off.

If you would rather nobody *can* post at all, deny **Send Messages** for `@everyone` on that
channel in Discord — the sweep is the belt to that braces, and it also catches the case where a
permission change is missed.

## Env

| variable | what it is |
|---|---|
| `DISCORD_GUILD_ID` | the server id |
| `DISCORD_BOT_TOKEN` | the bot's token (the same one the bot already uses) |
| `DISCORD_BOT_SECRET` | **new** — random string; the only thing allowed to approve a code. `openssl rand -hex 32` |
| `DISCORD_GUILD_INVITE` | invite link used by the **Join the Discord** button |
| `DISCORD_LINK_CHANNEL_ID` | optional, exact channel id `/link` must be used in |
| `DISCORD_LINK_CHANNEL_NAME` | fallback channel name, default `4k-access` |
| `DISCORD_REQUIRED_ROLE` | optional — require a role as well as membership |
| `DISCORD_MEMBER_CACHE_SECONDS` | optional — how fast leaving the server is noticed, default `300` |
| `DISCORD_LINK_SWEEP` | optional — delete messages in the command channel, default `true` |
| `DISCORD_SESSION_SECRET` | optional — signing key, falls back to `DISCORD_BOT_SECRET` |
| `DISCORD_4K_URL` | optional — pin the 4K embed url instead of resolving it from embdlol |
| `DISCORD_GATE_ENABLED` | `false` switches the whole gate off |

`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` are no longer used. They can
be deleted from Render.

## API

| route | who calls it | what it does |
|---|---|---|
| `POST /api/discord/link/start` | browser | mints `{ code, pollToken, expiresInMs, channel, invite }` |
| `POST /api/discord/link/poll` | browser | `{ code, pollToken }` → `pending` \| `claimed` + token \| `expired` |
| `POST /api/discord/link/claim` | bot only (`X-Bot-Secret`) | `{ code, userId, userName, channelId, channelName }` → vouches for the member |
| `GET /api/discord/status` | browser | `{ configured, verified, user }`, re-checks the guild |
| `GET /api/discord/4k` | browser | the stream url, members only |
| `POST /api/discord/logout` | browser | tells a client to drop its stored token |
| `GET /api/discord/debug` | ops | what is configured, how many codes are pending |

### Claim errors the bot turns into friendly copy

`unknown-code`, `expired-code`, `already-used`, `wrong-channel`, `not-member`, `missing-role`,
`rate`, `disabled`, `not-configured`.

## Session token

`base64url(claims).HMAC-SHA256` over `{userId,userName,guildId,at,exp}`, signed with
`DISCORD_SESSION_SECRET`. It lives in `localStorage['freef1_dg_token']` and is sent as
`Authorization: Bearer …`. `exp` is ten years out — the practical revocation is the guild check on
`/status` and `/4k`, not the clock.

## Security notes, stated plainly

- The code alone cannot be traded for a session: collection also needs the 32-byte `pollToken`,
  which never leaves the browser that minted it.
- Only the bot can claim a code, because the route demands `X-Bot-Secret`.
- Before minting, the gate asks Discord whether the account really is in the guild.
- Codes last 15 minutes and are single-use per account.
- This is a funnel, not DRM. `api.embdlol.st` lists channels publicly, so a determined visitor can
  find the 4K stream without linking. The gate keeps the url out of the public bundle, makes
  joining the natural path, and takes access away when somebody leaves.

## Verify it

```bash
cd f1admin
node --check discord-gate.js && node --check server.js
node scripts/smoke-test.js        # 44/44
node scripts/admin-dom-check.js   # 14/14
```

The end-to-end harnesses live in `/tmp/t` on the build machine and cover: chip always visible,
panel copy, code generation, bot claim, auto-unlock, reload persistence, wrong-channel refusal,
missing bot secret, and code-without-poll-token theft.

## Files

| file | role |
|---|---|
| `discord-gate.js` | the whole gate — codes, tokens, membership cache, 4K resolution |
| `bot/discord-bot.js` | registers `/link` and posts the claim to the backend |
| `server.js` | mounts the gate, passes the bot its secret, channel and API base |
| `netlifyf1/src/app.ts` | Superlicense panel, polling, always-visible chip |
| `netlifyf1/index.html` | the panel markup |
| `netlifyf1/src/styles/app.css` | `.sl-*` styles |
