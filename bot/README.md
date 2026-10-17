# FreeF1 Race Control — Discord bot

Owner-operated companion bot for the FreeF1 Discord server. It runs in-process
with the f1free Express service and remains disabled unless `DISCORD_BOT_TOKEN`
is set. All commands except `/website` are restricted to the configured owner
and refuse other users ephemerally. The optional Help-ticket bridge is separately
gated by `DISCORD_TICKETS_ENABLED` and remains off until its Discord permissions,
intent, and durable metadata storage are configured.

The bot's settings are durable: panel references, channel bindings, the alerts
role, soon-alert lead time, emoji IDs, and sent-alert history persist through
restarts and redeploys (local JSON in `DATA_DIR` or Upstash at
`freef1:discordbot:v1`). Writes are serialized, and the server flushes the bot
store on SIGTERM/SIGINT before exit so a redeploy does not lose a sent marker
and double-post an alert.

---

## Setup (once)

1. In the **Discord Developer Portal**, create an application and bot, then copy
the bot token. The standard bot features need no privileged intents. Only if
Help tickets are enabled, turn on **Message Content Intent** under Bot →
Privileged Gateway Intents so typed staff replies can be relayed. Do not enable
other privileged intents for this feature.
2. Invite the bot to your server with this URL (replace `CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=1342262352
   ```

   Permissions: Manage Channels, Manage Roles, Manage Emojis, View Channels,
   Send Messages, Embed Links, Add Reactions, and Read Message History. Manage
   Channels is needed only for Help-ticket channel creation/deletion; Add
   Reactions is kept for legacy reaction panels already posted in the server.
3. Drag the bot's role **above every role it manages** (all 22 driver roles and
   Stream Alerts). Discord will refuse to assign roles above the bot's top role.
4. Grid roles must already exist, named exactly `NN | CODE` (for example,
   `16 | LEC`). `/rolemenu` does not create those roles.
5. Set these environment variables in Render:

   | Variable | Purpose |
   |---|---|
   | `DISCORD_BOT_TOKEN` | Enables the bot. |
   | `DISCORD_GUILD_ID` | Optional for the existing commands (guild-scoped commands register immediately; global commands can take about an hour). Required for Help tickets. |
   | `DISCORD_OWNER_ID` | Owner account allowed to use administrative commands and private tickets. Required for Help tickets. |
   | `DISCORD_INVITE` | Optional invite URL used by `/website`. |
   | `SITE_URL` | Optional; defaults to `https://freef1.netlify.app`. |
   | `DISCORD_TICKETS_ENABLED` | Optional, default `false`. Set to `true` only after the setup in the Help tickets section. |
   | `DISCORD_TICKET_CATEGORY_ID` | Optional Discord category under which private `ticket-0001` channels are created. |
   | `DISCORD_TICKET_STAFF_ROLE_ID` | Optional role allowed to view and reply to tickets; `DISCORD_OWNER_ID` always retains access. |

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

### Help tickets (optional; disabled by default)

To turn on the Help page's Discord bridge:

1. Keep the bot running with `DISCORD_BOT_TOKEN`, and set both
   `DISCORD_GUILD_ID` and `DISCORD_OWNER_ID`.
2. Invite/re-authorize the bot with **Manage Channels** (the permission URL
   above includes it). The bot also needs View Channels, Send Messages, Read
   Message History, and Embed Links in the chosen ticket category.
3. Enable **Message Content Intent** in the Developer Portal; this is required
   to read typed support replies. The bot requests this gateway intent only
   when the feature is enabled.
4. Configure durable ticket metadata before enabling the feature: use the
   existing Upstash credentials or mount a Render persistent disk and set
   `DATA_DIR`. Tickets use a separate `freef1:help-tickets:v1` key in Upstash
   or `help-tickets.json` in `DATA_DIR`. Do not rely on Render's ephemeral disk.
5. Optionally set `DISCORD_TICKET_CATEGORY_ID` and
   `DISCORD_TICKET_STAFF_ROLE_ID`. If no staff role is supplied, only the
   configured owner (plus server administrators who inherently bypass channel
   overwrites) can see and reply to tickets.
6. Set `DISCORD_TICKETS_ENABLED=true` and restart. Check
   `GET /api/help/config`; it reports `available: true` only when the bot,
   guild, owner, and storage are ready.

Each request creates a private text channel named `ticket-0001`,
`ticket-0002`, and so on. `@everyone` is denied View Channel; the bot, configured
owner, and optional support role receive channel access. Website messages are
posted to that channel. Support staff reply by typing a plain-text message in
the private channel; it is pushed to the browser over a low-bandwidth SSE
connection. Deleting the ticket in the browser deletes both the Discord channel
and backend metadata. The first release accepts text only—image/file uploads
are not implemented. The browser access key is local to one browser and is not
a verified Discord identity; clearing its local storage loses access.

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
| `bot/discord-bot.js` | Bot store, panels, buttons, scheduler, presence, commands, and optional private ticket channels/replies. |
| `bot/schedule-2026.json` | Season data; update alongside the frontend schedule when the calendar changes. |
| `bot/assets/emoji/` | Number and alert-dot PNGs uploaded on first run. |
| `server.js` | Optional bot startup and graceful-shutdown flush. |

## Operations

- **Crash isolation:** bot startup is guarded, and Discord client errors are
  handled so bot failures do not take down the Race Control API. If the token
  is unset, the bot stays off.
- **Intents:** Guilds, GuildMessages, and GuildMessageReactions, plus Message
  and Reaction partials so legacy panels continue working after restarts.
  Message Content is requested only when `DISCORD_TICKETS_ENABLED=true`; enable
  the matching privileged intent in the Developer Portal first.
- **Scheduler:** one interval is registered once; a gateway reconnect cannot
  start a duplicate loop.
- **Season rollover:** regenerate `schedule-2026.json` from the frontend
  schedule and redeploy. The two copies are not automatically synchronized.
