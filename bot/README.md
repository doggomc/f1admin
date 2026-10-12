# FreeF1 Race Control — Discord bot

Owner-operated companion bot for the FreeF1 Discord server. It runs in-process
with the f1free Express service and remains disabled unless `DISCORD_BOT_TOKEN`
is set. All commands except `/website` are restricted to the configured owner
and refuse other users ephemerally.

The bot's settings are durable: panel references, channel bindings, the alerts
role, soon-alert lead time, emoji IDs, and sent-alert history persist through
restarts and redeploys (local JSON in `DATA_DIR` or Upstash at
`freef1:discordbot:v1`). Writes are serialized, and the server flushes the bot
store on SIGTERM/SIGINT before exit so a redeploy does not lose a sent marker
and double-post an alert.

---

## Setup (once)

1. In the **Discord Developer Portal**, create an application and bot, then copy
the bot token. No privileged intents are required; leave those switches off.
2. Invite the bot to your server with this URL (replace `CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=1342262336
   ```

   Permissions: Manage Roles, Manage Emojis, View Channels, Send Messages,
   Embed Links, Add Reactions, and Read Message History. Add Reactions is kept
   for legacy reaction panels already posted in the server.
3. Drag the bot's role **above every role it manages** (all 22 driver roles and
   Stream Alerts). Discord will refuse to assign roles above the bot's top role.
4. Grid roles must already exist, named exactly `NN | CODE` (for example,
   `16 | LEC`). `/rolemenu` does not create those roles.
5. Set these environment variables in Render:

   | Variable | Purpose |
   |---|---|
   | `DISCORD_BOT_TOKEN` | Enables the bot. |
   | `DISCORD_GUILD_ID` | Optional; guild-scoped commands register immediately. Omit for global registration, which can take about an hour to propagate. |
   | `DISCORD_OWNER_ID` | Owner account allowed to use the administrative commands. |
   | `DISCORD_INVITE` | Optional invite URL used by `/website`. |
   | `SITE_URL` | Optional; defaults to `https://freef1.netlify.app`. |

6. Restart the service. The log should show the bot connecting and its
   application commands registering.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/emojis` | owner | Uploads missing driver-number and alert emojis; this also runs automatically when panels are posted. |
| `/rolemenu` | owner | Posts one compact driver-grid embed with 22 buttons. Clicking a button toggles that driver's `NN \| CODE` role. Re-running replaces the previous panel. |
| `/alertsmenu [channel] [role]` | owner | Posts the alert opt-in panel. It can bind a channel for session alerts and a role to ping. |
| `/config view` | owner | Shows the alerts channel and role, soon-alert lead time, and panel links. |
| `/config set` | owner | Changes `alerts_channel`, `alerts_role`, or `soon_minutes` (1–120) without reposting panels. |
| `/status` | owner | Shows the live/next session, bindings, panels, mapped roles, and storage backend. |
| `/live [round] [session] [state]` | owner | Test-posts an alert embed (`soon`, `live`, or `ended`) to the alerts channel. An invalid round or slug is reported rather than silently choosing another session. |
| `/website` | everyone | Posts the FreeF1 link embed with site and Discord invite buttons. |

The bot does not join voice channels or relay audio. Session alerts and the
`/website` command link members to the static FreeF1 site for playback.

## Automatic session alerts

Every 15 seconds, the scheduler checks the 2026 season in
`bot/schedule-2026.json` (keep it in step with the frontend schedule):

- **T−N minutes** (10 by default; configurable with
  `/config set soon_minutes:`) posts an amber `STARTING SOON` embed and pings
the alerts role. The embed includes a **Watch on FreeF1** link.
- **Lights out** edits that same message to green `LIVE NOW`; it does not send a
second ping or another message.
- **Chequered flag** edits it to red `ENDED`. End times are estimated per
session because the schedule contains start times only. The bot only edits a
message it sent; it does not post a missed session as newly ended.
- While a session is live, the bot's activity shows the Grand Prix name.
Otherwise it shows the next session and a countdown, updating only when that
text changes.
- Sent alerts are recorded in the durable store to prevent duplicates after a
restart. History is pruned after seven days.
- If the alerts channel is deleted, the scheduler skips it. Re-run
`/alertsmenu` or `/config set alerts_channel:` to rebind.

## Panels and roles

Discord caps reactions at 20 per message; the 2026 grid has 22 drivers, so the
driver panel uses buttons (`freef1:grid:<number>`). The alert opt-in is a single
`freef1:alerts` toggle button.

Legacy reaction panels already posted in a server continue to work until you
replace them with `/rolemenu` or `/alertsmenu`. The bot uploads white pixel-digit
PNGs from `bot/assets/emoji/` because Unicode does not provide two-digit
keycaps.

## Files

| Path | Purpose |
|---|---|
| `bot/discord-bot.js` | Bot store, panels, buttons, scheduler, presence, and commands. |
| `bot/schedule-2026.json` | Season data; update alongside the frontend schedule when the calendar changes. |
| `bot/assets/emoji/` | Number and alert-dot PNGs uploaded on first run. |
| `server.js` | Optional bot startup and graceful-shutdown flush. |

## Operations

- **Crash isolation:** bot startup is guarded, and Discord client errors are
  handled so bot failures do not take down the Race Control API. If the token
  is unset, the bot stays off.
- **Intents:** Guilds, GuildMessages, and GuildMessageReactions, plus Message
  and Reaction partials so legacy panels continue working after restarts. No
  privileged intents are needed.
- **Scheduler:** one interval is registered once; a gateway reconnect cannot
  start a duplicate loop.
- **Season rollover:** regenerate `schedule-2026.json` from the frontend
  schedule and redeploy. The two copies are not automatically synchronized.
