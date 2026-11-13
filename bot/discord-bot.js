'use strict';

/* ════════════════════════════════════════════════════════════════════
   FreeF1 Race Control — Discord companion bot (owner-operated)
   ════════════════════════════════════════════════════════════════════
   Runs in-process with the f1free Express server; started only when
   DISCORD_BOT_TOKEN is set. Everything the owner configures with
   commands is persisted (file locally / Upstash in production), so
   restarts and redeploys keep panels, bindings and sent-history.

   Ownership is hard-coded to a single user id by design (spec):
   every command except /website refuses anyone else, ephemeralally.

   Feature set:
     /rolemenu    owner — posts the supporter-role panel: ONE compact
                          image plus 22 driver buttons (5 per row, team
                          order). Clicking a button toggles that
                          driver's "NN | CODE" role. (Buttons replaced
                          the old two-part reaction panels: Discord
                          caps reactions at 20 per message and the
                          grid has 22 drivers; buttons allow 25.)
     /alertsmenu  owner — posts the stream-alerts opt-in panel with a
                          single toggle button; binds the alerts
                          channel + ping role.
     /config      owner — view or change settings at runtime: alerts
                          channel, alerts role and soon-alert lead time.
                          Everything editable without re-posting panels.
     /status      owner — one glance at bindings, panels, next session,
                          and store backend.
     /live        owner — test-fires an alert image (any state:
                          soon / live / ended) into the alerts channel.
     /emojis      owner — uploads any missing custom number emojis.
     /website     everyone — lightweight image and links for the site.
     scheduler    — per session: STARTING SOON (amber) image + role
                    ping at T-minus config; the same message edits
                    itself into LIVE NOW (green) at lights out, and
                    into ENDED (red) at the chequered flag. Deduped
                    via the durable store; presence follows along.
     presence     — while a session is live the bot's activity is the
                    Grand Prix name; otherwise a next-session
                    countdown, refreshed at most once a minute.
     help tickets — when configured, creates private sequentially named
                    text channels and relays visitor/staff text messages.

   Intents: Guilds, GuildMessages, GuildMessageReactions (+ Message/Reaction
   partials for legacy panels). MessageContent is requested only when the
   optional Help-ticket feature is enabled, to relay staff replies.
   ════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { renderAlertImage, renderAlertsPanelImage, renderWebsiteImage } = require('./alert-image');
const { renderGridImage, gridDescription } = require('./grid-image');
const {
  Client, GatewayIntentBits, Partials, ActionRowBuilder, EmbedBuilder,
  ButtonBuilder, ButtonStyle, REST, Routes, Events, ActivityType,
  ChannelType, OverwriteType, PermissionFlagsBits,
} = require('discord.js');
const OWNER_ID = String(process.env.DISCORD_OWNER_ID || '').trim();
const DEFAULT_SOON_MINUTES = 10;    // lead time for the "starting soon" alert
const ENDED_WINDOW_HOURS = 24;      // how long a finished session stays editable to ENDED
const TICK_MS = 15000;              // scheduler resolution
const FREEF1_RED = 0xE10600;
const FREEF1_GREEN = 0x00D57E;
const FREEF1_AMBER = 0xFFB020;
const ROLE_NAME_RE = /^(\d{1,2}) \| ([A-Z]{3})$/;
const SITE_LABEL = 'freef1.netlify.app';
const DEFAULT_TICKET_STAFF_ROLE_IDS = Object.freeze(['1566540793794134226']);

function parseTicketStaffRoleIds(raw) {
  const extra = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const out = [];
  for (const candidate of [...DEFAULT_TICKET_STAFF_ROLE_IDS, ...extra]) {
    const id = String(candidate || '').trim();
    if (/^\d{17,20}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/* Realistic session lengths (minutes) — the schedule carries start times
   only, and the ENDED state needs an end. Deliberately generous: a session
   that runs long flips to ENDED a little late, which is harmless; one that
   flips early would look broken. */
const SESSION_MIN = {
  fp1: 75, fp2: 75, fp3: 75,
  'sprint-qualifying': 75, sprint: 60,
  qualifying: 75, race: 180,
};

const SEASON = require('./schedule-2026.json');
SEASON.forEach(ev => ev.sessions.forEach(s => {
  s.ts = Date.parse(s.start);
  s.end = s.ts + (SESSION_MIN[s.slug] || 60) * 60000;
}));

/* 2026 grid in panel order — colors mirror the site's livery palette. */
const TEAMS = [
  { name: 'Ferrari',         color: 0xDC0000, drivers: [[16, 'LEC'], [44, 'HAM']] },
  { name: 'Mercedes',        color: 0x00D2BE, drivers: [[12, 'ANT'], [63, 'RUS']] },
  { name: 'Mclaren',         color: 0xFF8000, drivers: [[1, 'NOR'], [81, 'PIA']] },
  { name: 'Red Bull',        color: 0x1E41FF, drivers: [[3, 'VER'], [6, 'HAD']] },
  { name: 'Aston Martin',    color: 0x006F62, drivers: [[14, 'ALO'], [18, 'STR']] },
  { name: 'Williams',        color: 0x005AFF, drivers: [[23, 'ALB'], [55, 'SAI']] },
  { name: 'Haas',            color: 0xE6E6E6, drivers: [[51, 'CAM'], [87, 'BEA']] },
  { name: 'Audi',            color: 0xE62213, drivers: [[5, 'BOR'], [27, 'HUL']] },
  { name: 'Racing Bulls',    color: 0x6692FF, drivers: [[30, 'LAW'], [41, 'LIN']] },
  { name: 'Alpine',          color: 0xFF0080, drivers: [[10, 'GAS'], [43, 'COL']] },
  { name: 'Cadillac',        color: 0xB4A07A, drivers: [[11, 'PER'], [77, 'BOT']] },
];
const ALL_DRIVERS = TEAMS.flatMap(t => t.drivers.map(([n, c]) => ({ num: n, code: c, team: t.name, color: t.color })));

/* ───────────────────────── embed + component builders (pure, testable) ───────────────────────── */

/* One compact embed for the whole 22-car grid: a monospace team block.
   Buttons (not reactions) carry the toggles — Discord caps reactions at
   20 per message and the grid has 22 drivers. */
function driverPanelEmbed(siteUrl) {
  const width = Math.max(...TEAMS.map(t => t.name.length));
  const lines = TEAMS.map(t => {
    const drivers = t.drivers.map(([n, c]) => `${String(n).padStart(2, ' ')} ${c}`).join(' · ');
    return `${t.name.padEnd(width, ' ')}  ${drivers}`;
  }).join('\n');
  return {
    color: FREEF1_RED,
    title: '2026 Grid',
    description:
      `\`\`\`\n${lines}\n\`\`\`\n` +
      `Tap a driver to wear their colours. Tap again to take them off.\n\n` +
      `**[${SITE_LABEL}](${siteUrl})**`,
  };
}

function gridPanelPayload(st) {
  return {
    files: [{ attachment: renderGridImage(TEAMS), name: 'freef1-grid-2026-v2.png', description: gridDescription(TEAMS) }],
    components: gridRows(st),
    allowedMentions: { parse: [] },
  };
}

function alertsPanelEmbed(siteUrl) {
  return {
    color: FREEF1_RED,
    description:
      `**Stream Alerts**\n\n` +
      `Get pinged when a session is starting.\n` +
      `Toggle below to opt in or out.\n\n` +
      `**[${SITE_LABEL}](${siteUrl})**`,
  };
}

/* The alert embed. Three states across a session's life:
   STARTING SOON (amber) -> LIVE NOW (green) -> ENDED (red),
   each edit happening in place on the same message. */
function sessionEmbed(ev, sess, state, siteUrl, soonMinutes = DEFAULT_SOON_MINUTES) {
  const sec = Math.floor(sess.ts / 1000);
  const live = state === 'live';
  const ended = state === 'ended';
  const line = live
    ? 'The feed is up - grab a seat in the cockpit.'
    : ended
      ? 'Chequered flag - session complete. Results and radio on the site.'
      : `Lights out in about ${soonMinutes} minutes. Settle in.`;
  return {
    color: live ? FREEF1_GREEN : ended ? FREEF1_RED : FREEF1_AMBER,
    title: live ? 'LIVE NOW' : ended ? 'ENDED' : 'STARTING SOON',
    url: siteUrl,
    description:
      `**${ev.name}**\n` +
      `${sess.name} · <t:${sec}:F> · <t:${sec}:R>\n\n` +
      `${line}`,
    fields: [
      { name: 'Round', value: `${ev.round} · ${ev.locality}, ${ev.country}`, inline: true },
      { name: 'Format', value: ev.sprint ? 'Sprint weekend' : 'Standard weekend', inline: true },
      // Footer text cannot be a link. A trailing field keeps the bold
      // site link under Round / Format, which is where the old footer sat.
      { name: '\u200b', value: `**[${SITE_LABEL}](${siteUrl})**` },
    ],
  };
}

/* Only the image and configured role are sent in scheduled alerts. Edits
   explicitly clear previous embeds/attachments and never re-ping the role. */
async function imageAlertPayload(event, session, state, roleId, { edit = false, ping = false } = {}) {
  const image = await renderAlertImage(event, session, state);
  const labels = { start: 'starting soon', live: 'live now', end: 'session ended' };
  return {
    content: roleId ? `<@&${roleId}>` : '',
    files: [{ attachment: image, name: `freef1-${state}.png`, description: `${event.name}, ${session.name}: ${labels[state]}` }],
    ...(edit ? { embeds: [], components: [], attachments: [] } : {}),
    allowedMentions: { parse: [], roles: ping && roleId ? [String(roleId)] : [] },
  };
}

async function testAlertPayload(event, session, state, siteUrl) {
  const states = { start: 'STARTING SOON', live: 'LIVE NOW', end: 'SESSION ENDED' };
  if (!Object.hasOwn(states, state)) throw new Error('Unknown test state');
  const timestamp = Math.floor(session.ts / 1000);
  const image = await renderAlertImage(event, session, state);
  return {
    content: `**TEST · ${states[state]}**\n${event.name} · ${session.name} · <t:${timestamp}:F>`,
    files: [{ attachment: image, name: `freef1-test-${state}.png`, description: `Test alert: ${states[state]}, ${event.name}, ${session.name}` }],
    components: [watchRow(siteUrl, state === 'end' ? 'Results on FreeF1' : 'Watch on FreeF1')],
    allowedMentions: { parse: [] },
  };
}

async function websitePayload(siteUrl, inviteUrl) {
  return {
    files: [{ attachment: await renderWebsiteImage(), name: 'freef1-website.png', description: 'FreeF1: One Cockpit. Every Session. All for Free.' }],
    components: [websiteRow(siteUrl, inviteUrl)],
    allowedMentions: { parse: [] },
  };
}

function watchRow(siteUrl, label = 'Watch on FreeF1') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(siteUrl)
  );
}

function websiteRow(siteUrl, inviteUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open FreeF1').setURL(siteUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Server invite').setURL(inviteUrl)
  );
}

/* 22 driver buttons, team order, five per row (Discord's row cap),
   each wearing the driver's custom number emoji. 22 <= the 25-button
   message cap, which is exactly why buttons replaced reactions. */
function gridRows(st) {
  const rows = [];
  for (let i = 0; i < ALL_DRIVERS.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const d of ALL_DRIVERS.slice(i, i + 5)) {
      const emojiId = st.emojiIds && st.emojiIds[String(d.num)];
      const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel(emojiId ? `| ${d.code}` : `${d.num} | ${d.code}`)
        .setCustomId(`freef1:grid:${d.num}`);
      if (emojiId) button.setEmoji({ id: emojiId });
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

async function alertsPanelPayload() {
  return {
    files: [{ attachment: await renderAlertsPanelImage(), name: 'freef1-alerts-panel.png', description: 'Stream Alerts. Get pinged when a session is starting. Use the button to opt in or out.' }],
    components: [alertsRow()],
    allowedMentions: { parse: [] },
  };
}

function alertsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Primary)
      .setLabel('Toggle Session Alerts')
      .setCustomId('freef1:alerts')
  );
}

/* ───────────────────────── schedule helpers (pure) ───────────────────────── */

function nextSession(now = Date.now()) {
  let best = null;
  for (const ev of SEASON) for (const s of ev.sessions) {
    if (s.ts > now && (!best || s.ts < best.sess.ts)) best = { ev, sess: s };
  }
  return best;
}

function liveSession(now = Date.now()) {
  for (const ev of SEASON) for (const s of ev.sessions) {
    if (s.ts <= now && now < s.end) return { ev, sess: s };
  }
  return null;
}

/* 'soon' | 'live' | 'ended' | null — the whole alert lifecycle in one place. */
function sessionState(sess, now = Date.now(), soonMinutes = DEFAULT_SOON_MINUTES) {
  const dt = sess.ts - now;
  if (dt > 0) return dt <= soonMinutes * 60000 ? 'soon' : null;
  if (now < sess.end) return 'live';
  if (now < sess.end + ENDED_WINDOW_HOURS * 3600000) return 'ended';
  return null;
}

/* Strict when a slug is given (a typo must fail loudly, not silently
   post a different session); convenient when it is not. */
function findSession(round, sessionSlug, now = Date.now()) {
  const live = liveSession(now);
  const ev = round != null
    ? SEASON.find(e => e.round === Number(round))
    : (live?.ev || nextSession(now)?.ev);
  if (!ev) return null;
  if (sessionSlug) {
    const sess = ev.sessions.find(s => s.slug === sessionSlug);
    return sess ? { ev, sess } : null;
  }
  const inWindow = ev.sessions.find(s => s.ts <= now && now - s.ts < ENDED_WINDOW_HOURS * 3600000 && now < s.end);
  return inWindow ? { ev, sess: inWindow }
    : (ev.sessions.find(s => s.ts > now) || { ev, sess: ev.sessions[ev.sessions.length - 1] });
}

/* Presence text: the Grand Prix name while a session is live, otherwise a
   next-session countdown at minute granularity (so setPresence is called
   at most ~1/min, well inside Discord's limits). */
function presenceActivity(now = Date.now()) {
  const live = liveSession(now);
  if (live) return { name: live.ev.name, type: ActivityType.Watching };
  const next = nextSession(now);
  if (!next) return { name: SITE_LABEL, type: ActivityType.Watching };
  const mins = Math.max(0, Math.round((next.sess.ts - now) / 60000));
  const span = mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`;
  return { name: `${next.ev.name} · ${next.sess.name} in ${span}`, type: ActivityType.Watching };
}

/* ───────────────────────── bot ───────────────────────── */

function start(deps) {
  const log = deps.log || ((...a) => console.log('[Bot]', ...a));
  const OWNER_ID = String(deps.ownerId || process.env.DISCORD_OWNER_ID || '').trim();
  if (!OWNER_ID) {
    log('DISCORD_OWNER_ID is not set — bot not starting');
    return { stop() {}, flush: () => Promise.resolve() };
  }
  const EMOJI_DIR = path.join(__dirname, '..', 'assets', 'emoji');

  /* ── durable store: file locally, Upstash in production ──
     Writes are immediate (no debounce): the sent-markers are the only
     thing standing between a redeploy and a double-posted alert, so a
     SIGTERM must never race a pending save. server.js calls flush()
     during graceful shutdown as a belt-and-braces final write. */
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const localClaims = new Set();
  let storeCache = null;
  let savePromise = null;

  function mergeSentMarkers(target, incoming) {
    if (!incoming || typeof incoming !== 'object' || !incoming.guilds) return target;
    for (const [guildId, incomingGuild] of Object.entries(incoming.guilds)) {
      if (!incomingGuild || typeof incomingGuild !== 'object') continue;
      if (!target.guilds[guildId]) {
        target.guilds[guildId] = incomingGuild;
        continue;
      }
      const localGuild = target.guilds[guildId];
      if (incomingGuild.sent && typeof incomingGuild.sent === 'object') {
        localGuild.sent = { ...(incomingGuild.sent || {}), ...(localGuild.sent || {}) };
      }
      if (incomingGuild.alerts && !localGuild.alerts) localGuild.alerts = incomingGuild.alerts;
    }
    return target;
  }

  const store = {
    async load({ refresh = false } = {}) {
      if (storeCache && !refresh) return storeCache;
      // A failed or malformed read throws and is NOT cached. Caching an empty
      // store here let the next save write {guilds:{}} over the real state
      // (sent-markers, alert channels, roles). The next tick simply retries.
      let loaded;
      if (deps.upstash) {
        const r = await deps.upstash(['GET', deps.redisKey]);
        if (r && typeof r.result === 'string') loaded = JSON.parse(r.result);
        else if (r && r.result == null) loaded = null; // key never written
        else throw new Error('unexpected Upstash reply');
      } else {
        loaded = deps.readLocalJson(deps.fileKey);
      }
      // "null" in storage is an empty store, not a corrupt one.
      if (loaded === null || loaded === undefined) loaded = { guilds: {} };
      if (!loaded || typeof loaded !== 'object' || !loaded.guilds || typeof loaded.guilds !== 'object') {
        throw new Error('stored bot state has no guilds map');
      }
      storeCache = storeCache ? mergeSentMarkers(loaded, storeCache) : loaded;
      return storeCache;
    },
    async save() {
      // Serialized, and the payload is read when the write actually runs,
      // so two overlapping saves cannot clobber a newer one with a stale
      // snapshot.
      const write = async () => {
        // Nothing loaded yet: writing would replace the stored state with nothing.
        if (!storeCache) return;
        try {
          if (deps.upstash) {
            // Pull any sent-markers written by an overlapping deploy container
            // before writing so we never overwrite another container's messageId.
            try {
              const latest = await deps.upstash(['GET', deps.redisKey]);
              if (latest && typeof latest.result === 'string') {
                mergeSentMarkers(storeCache, JSON.parse(latest.result));
              }
            } catch (_) { /* best-effort merge before write */ }
            await deps.upstash(['SET', deps.redisKey, JSON.stringify(storeCache)]);
          } else {
            deps.writeLocalJson(deps.fileKey, storeCache);
          }
        } catch (e) { log('store save failed:', e.message); }
      };
      const prev = savePromise || Promise.resolve();
      savePromise = prev.then(write, write);
      return savePromise;
    },
    flush() { return this.save(); },
    async claimAlert(guildId, stateKey) {
      const claimId = `${guildId}:${stateKey}`;
      if (localClaims.has(claimId)) return { acquired: false, release: async () => {} };
      localClaims.add(claimId);
      if (!deps.upstash) {
        return {
          acquired: true,
          release: async () => { localClaims.delete(claimId); }
        };
      }
      const redisClaimKey = `${deps.redisKey}:claim:${guildId}:${stateKey}`;
      try {
        const reply = await deps.upstash(['SET', redisClaimKey, instanceId, 'NX', 'EX', '172800']);
        if (!reply || reply.result !== 'OK') {
          localClaims.delete(claimId);
          return { acquired: false, release: async () => {} };
        }
        return {
          acquired: true,
          release: async () => {
            localClaims.delete(claimId);
            try { await deps.upstash(['DEL', redisClaimKey]); } catch (_) {}
          }
        };
      } catch (e) {
        localClaims.delete(claimId);
        log('alert claim check failed:', e.message);
        return { acquired: false, release: async () => {} };
      }
    },
    async guild(guildId) {
      const s = await this.load();
      if (!s.guilds[guildId]) {
        s.guilds[guildId] = { emojiIds: {}, driverRoles: {}, panels: {}, alerts: null, sent: {}, config: {} };
      }
      const g = s.guilds[guildId];
      if (!g.config) g.config = {};
      let removedLegacyVoiceState = false;
      if (Object.prototype.hasOwnProperty.call(g, 'relay')) {
        delete g.relay;
        removedLegacyVoiceState = true;
      }
      if (Object.prototype.hasOwnProperty.call(g.config, 'audioUrl')) {
        delete g.config.audioUrl;
        removedLegacyVoiceState = true;
      }
      if (removedLegacyVoiceState) await this.save();
      return g;
    },
  };
  const soonMinutesFor = st => Number(st.config && st.config.soonMinutes) || DEFAULT_SOON_MINUTES;
  const ticketFeatureEnabled = deps.ticketsEnabled === true && Boolean(deps.guildId && OWNER_ID);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      ...(ticketFeatureEnabled ? [GatewayIntentBits.MessageContent] : []),
    ],
    partials: [Partials.Message, Partials.Reaction],
  });

  const ticketCategoryLabels = new Map([
    ['website', 'Website issue'],
    ['playback', 'Playback issue'],
    ['timing', 'Timing or results'],
    ['discord', 'Discord or account help'],
    ['other', 'Other'],
  ]);
  const ticketText = (value, max = 2000) => String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .slice(0, max);
  const ticketPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
  ];
  const ticketStaffRoleIds = parseTicketStaffRoleIds(deps.ticketStaffRoleIds ?? deps.ticketStaffRoleId);

  async function ticketGuild() {
    if (!ticketFeatureEnabled || !client.isReady()) throw new Error('Help tickets are not enabled or the bot is offline.');
    return client.guilds.cache.get(String(deps.guildId)) || client.guilds.fetch(String(deps.guildId));
  }

  async function syncTicketChannelPermissions(channelIds = []) {
    if (!ticketFeatureEnabled || !ticketStaffRoleIds.length || !Array.isArray(channelIds) || !channelIds.length) return 0;
    let updated = 0;
    for (const rawChannelId of channelIds) {
      const channelId = String(rawChannelId || '').trim();
      if (!/^\d{17,20}$/.test(channelId)) continue;
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.permissionOverwrites?.edit) continue;
        for (const roleId of ticketStaffRoleIds) {
          if (roleId === String(deps.guildId)) continue;
          await channel.permissionOverwrites.edit(
            roleId,
            { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true },
            { type: OverwriteType.Role, reason: 'Grant FreeF1 ticket staff role access' },
          );
        }
        updated++;
      } catch (error) {
        if (Number(error?.code) !== 10003 && Number(error?.status) !== 404) {
          log(`ticket role sync skipped (${channelId}):`, error.message);
        }
      }
    }
    return updated;
  }

  async function createTicketChannel({ ticketId, name, category, message, diagnostics, createdAt }) {
    const guild = await ticketGuild();
    // Explicit target types let discord.js encode IDs even when a human member or role is not cached.
    const overwrites = [
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, type: OverwriteType.Member, allow: ticketPermissions },
      { id: OWNER_ID, type: OverwriteType.Member, allow: ticketPermissions },
    ];
    for (const roleId of ticketStaffRoleIds) {
      if (roleId !== guild.id) {
        overwrites.push({ id: roleId, type: OverwriteType.Role, allow: ticketPermissions });
      }
    }

    const options = {
      name: ticketId,
      type: ChannelType.GuildText,
      topic: `Private FreeF1 help request ${ticketId}`,
      permissionOverwrites: overwrites,
      reason: `FreeF1 support ticket ${ticketId}`,
    };
    const parent = String(deps.ticketCategoryId || '').trim();
    if (parent) options.parent = parent;
    const channel = await guild.channels.create(options);

    const diagnosticLines = Object.entries(diagnostics || {})
      .map(([key, value]) => `${ticketText(key, 32)}: ${ticketText(value, 140)}`)
      .filter(line => !/:\s*$/.test(line));
    const embed = new EmbedBuilder()
      .setColor(FREEF1_RED)
      .setTitle(`New Help Ticket · ${ticketId}`)
      .setDescription(ticketText(message, 4000))
      .addFields(
        { name: 'Name', value: ticketText(name, 48) || 'Not provided', inline: true },
        { name: 'Category', value: ticketCategoryLabels.get(category) || 'Other', inline: true },
        { name: 'Device diagnostics', value: ticketText(diagnosticLines.join('\n') || 'Not provided', 1000) },
      )
      .setFooter({ text: 'freef1:ticket:initial' })
      .setTimestamp(new Date(createdAt || Date.now()));
    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      await channel.delete('Removing incomplete FreeF1 help ticket').catch(() => {});
      throw error;
    }
    return channel.id;
  }

  async function sendTicketMessage(channelId, { name, text }) {
    const channel = await client.channels.fetch(String(channelId));
    if (!channel || !channel.isTextBased()) throw new Error('Ticket channel is unavailable.');
    const embed = new EmbedBuilder()
      .setColor(FREEF1_RED)
      .setTitle(`Website message · ${ticketText(name, 48) || 'Visitor'}`)
      .setDescription(ticketText(text, 2000))
      .setFooter({ text: 'freef1:ticket:user-message' })
      .setTimestamp();
    const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return { id: sent.id, role: 'visitor', author: 'You', text: ticketText(text, 2000), createdAt: sent.createdTimestamp };
  }

  async function fetchTicketMessages(channelId) {
    const channel = await client.channels.fetch(String(channelId));
    if (!channel || !channel.isTextBased()) throw new Error('Ticket channel is unavailable.');
    const found = await channel.messages.fetch({ limit: 100 });
    return [...found.values()].map(message => {
      if (message.author?.id === client.user.id) {
        const marker = message.embeds?.[0]?.footer?.text;
        if (marker !== 'freef1:ticket:initial' && marker !== 'freef1:ticket:user-message') return null;
        return {
          id: message.id,
          role: 'visitor',
          author: 'You',
          text: ticketText(message.embeds?.[0]?.description || '', 4000),
          createdAt: message.createdTimestamp,
        };
      }
      if (message.author?.bot || !String(message.content || '').trim()) return null;
      return {
        id: message.id,
        role: 'staff',
        author: 'FreeF1 Support',
        text: ticketText(message.content, 2000),
        createdAt: message.createdTimestamp,
      };
    }).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt).slice(-100);
  }

  async function deleteTicketChannel(channelId) {
    if (!ticketFeatureEnabled) throw new Error('Help tickets are not enabled.');
    try {
      const channel = await client.channels.fetch(String(channelId));
      if (channel) await channel.delete('Ticket deleted by the requester');
    } catch (error) {
      if (Number(error?.code) !== 10003 && Number(error?.status) !== 404) throw error;
    }
    return true;
  }

  /* ── emoji management ── */
  async function ensureEmojis(guild, st, onlyKeys = null) {
    const all = [...ALL_DRIVERS.map(d => ({ key: String(d.num), file: `n${d.num}.png` })), { key: 'live', file: 'freef1live.png' }];
    const wanted = onlyKeys ? all.filter(item => onlyKeys.includes(item.key)) : all;
    for (const w of wanted) {
      const name = w.key === 'live' ? 'freef1live' : `n${w.key}`;
      const existing = guild.emojis.cache.find(e => e.name === name);
      if (existing) { st.emojiIds[w.key] = existing.id; continue; }
      if (st.emojiIds[w.key] && guild.emojis.cache.has(st.emojiIds[w.key])) continue;
      try {
        const buf = fs.readFileSync(path.join(EMOJI_DIR, w.file));
        const created = await guild.emojis.create({ name, attachment: buf, reason: 'FreeF1 panels' });
        st.emojiIds[w.key] = created.id;
        log(`emoji uploaded: ${created.name}`);
      } catch (e) {
        log(`emoji upload failed (${w.file}):`, e.message);
      }
    }
    await store.save();
  }

  function discoverDriverRoles(guild, st) {
    const map = {};
    for (const role of guild.roles.cache.values()) {
      const m = ROLE_NAME_RE.exec(role.name);
      // Never assign another driver's old role to Câmara just because the number matches.
      if (m && (m[1] !== '51' || m[2] === 'CAM')) map[m[1]] = role.id;
    }
    st.driverRoles = map;
    return map;
  }

  async function deleteStoredPanel(guild, st, key) {
    const old = st.panels && st.panels[key];
    if (!old) return;
    try {
      const ch = guild.channels.cache.get(old.channelId);
      const msg = await ch?.messages.fetch(old.messageId);
      await msg?.delete();
    } catch (_) { /* already gone */ }
    delete st.panels[key];
  }

  /* ── panel posting ── */
  async function postGridPanel(guild, channel, st) {
    await ensureEmojis(guild, st);
    const roles = discoverDriverRoles(guild, st);
    const missing = ALL_DRIVERS.filter(d => !roles[String(d.num)]).map(d => d.num);
    if (missing.length) throw new Error(`missing grid roles for numbers: ${missing.join(', ')}`);

    // retire previous panels (including legacy two-part reaction panels)
    for (const key of ['d1', 'd2', 'grid']) await deleteStoredPanel(guild, st, key);

    const msg = await channel.send(gridPanelPayload(st));
    st.panels.grid = { channelId: channel.id, messageId: msg.id };
    await store.save();
  }

  async function postAlertsPanel(guild, channel, st, role, alertsChannel) {
    await ensureEmojis(guild, st);
    let target = role;
    if (!target) {
      target = guild.roles.cache.find(r => r.name === 'Stream Alerts');
      if (!target) {
        target = await guild.roles.create({ name: 'Stream Alerts', color: FREEF1_RED, reason: 'FreeF1 stream alerts opt-in' });
      }
    }
    await deleteStoredPanel(guild, st, 'alerts');
    const msg = await channel.send(await alertsPanelPayload());
    st.panels.alerts = { channelId: channel.id, messageId: msg.id };
    st.alerts = { channelId: (alertsChannel || channel).id, roleId: target.id };
    await store.save();
  }

  /* ── role toggling (buttons now, legacy reactions below) ── */
  async function toggleRole(member, guild, st, roleId, why) {
    const has = member.roles.cache.has(roleId);
    if (has) await member.roles.remove(roleId, why);
    else await member.roles.add(roleId, why);
    return !has; // true = granted
  }

  async function handleGridButton(interaction) {
    const num = interaction.customId.split(':')[2];
    const guild = interaction.guild;
    const st = await store.guild(guild.id);
    const roleId = st.driverRoles[num] || discoverDriverRoles(guild, st)[num];
    const driver = ALL_DRIVERS.find(d => String(d.num) === num);
    if (!driver) return interaction.reply({ content: 'Unknown driver.', ephemeral: true });
    if (!roleId) {
      return interaction.reply({
        content: `No role is mapped to number ${num} yet. Create a role named \`${num} | ${driver ? driver.code : 'CODE'}\` (or re-run /rolemenu once it exists).`,
        ephemeral: true
      });
    }
    try {
      const granted = await toggleRole(interaction.member, guild, st, roleId, 'FreeF1 supporter role');
      await store.save();
      return interaction.reply({
        content: granted
          ? `You are now wearing ${driver.team} - ${num} ${driver.code}.`
          : `Taken off: ${driver.team} - ${num} ${driver.code}.`,
        ephemeral: true
      });
    } catch (e) {
      log('grid button role change failed:', e.message);
      return interaction.reply({
        content: 'Could not change your role. Is the bot\'s role above the grid roles in Server Settings > Roles?',
        ephemeral: true
      });
    }
  }

  async function handleAlertsButton(interaction) {
    const guild = interaction.guild;
    const st = await store.guild(guild.id);
    if (!st.alerts || !st.alerts.roleId) {
      return interaction.reply({ content: 'Alerts are not configured yet. Owner: run /alertsmenu.', ephemeral: true });
    }
    try {
      const granted = await toggleRole(interaction.member, guild, st, st.alerts.roleId, 'FreeF1 stream alerts opt-in/out');
      await store.save();
      return interaction.reply({
        content: granted
          ? 'You will be pinged when a session is starting.'
          : 'Session alerts muted. Toggle again any time.',
        ephemeral: true
      });
    } catch (e) {
      log('alerts button role change failed:', e.message);
      return interaction.reply({
        content: 'Could not change your role. Is the bot\'s role above the alerts role in Server Settings > Roles?',
        ephemeral: true
      });
    }
  }

  /* Legacy reaction panels (two-part grid + reaction alerts) keep working
     for any server that has not re-run /rolemenu or /alertsmenu yet. */
  async function handleReaction(reaction, user, granting) {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (_) { return; }
    const guild = reaction.message.guild;
    if (!guild) return;
    const st = await store.guild(guild.id);
    const msgId = reaction.message.id;

    const panelKey = Object.keys(st.panels).find(k => st.panels[k] && st.panels[k].messageId === msgId);
    if (!panelKey || panelKey === 'grid') return; // grid is button-only now

    const emojiKey = reaction.emoji.id
      ? Object.keys(st.emojiIds).find(k => st.emojiIds[k] === reaction.emoji.id)
      : null;
    if (!emojiKey) return;

    try {
      if (panelKey === 'alerts') {
        if (!st.alerts || !st.alerts.roleId) return;
        const member = await guild.members.fetch(user.id);
        if (granting) await member.roles.add(st.alerts.roleId, 'FreeF1 stream alerts opt-in');
        else await member.roles.remove(st.alerts.roleId, 'FreeF1 stream alerts opt-out');
        return;
      }
      const roleId = st.driverRoles[emojiKey] || discoverDriverRoles(guild, st)[emojiKey];
      if (!roleId) return;
      const member = await guild.members.fetch(user.id);
      if (granting) await member.roles.add(roleId, 'FreeF1 supporter role');
      else await member.roles.remove(roleId, 'FreeF1 supporter role');
    } catch (e) {
      log('reaction role failed:', e.message); // usually role hierarchy
    }
  }

  /* ── scheduler: soon -> live -> ended, edit-in-place; presence follows ── */
  let lastPresence = '';
  async function syncPresence(now) {
    const activity = presenceActivity(now);
    if (activity.name === lastPresence) return;
    lastPresence = activity.name;
    try {
      await client.user?.setPresence({ activities: [activity], status: 'online' });
    } catch (e) { log('presence update failed:', e.message); }
  }

  let tickInFlight = false;
  async function tick() {
    // A slow Discord call must not overlap the next 15s tick, or two passes
    // can both see an unsent marker and double-post the alert.
    if (tickInFlight) return;
    tickInFlight = true;
    try {
    const s = await store.load();
    const now = Date.now();
    await syncPresence(now);
    for (const guildId of Object.keys(s.guilds)) {
      let st = s.guilds[guildId];
      if (!st.sent) st.sent = {};
      if (!st.alerts || !st.alerts.channelId) continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = guild.channels.cache.get(st.alerts.channelId)
        || await guild.channels.fetch(st.alerts.channelId).catch(() => null);
      if (!channel) continue;
      const soonMin = soonMinutesFor(st);

      for (const ev of SEASON) for (const sess of ev.sessions) {
        const state = sessionState(sess, now, soonMin);
        if (!state) continue;
        const base = `${ev.slug}:${sess.slug}`;
        const keySoon = `${base}:soon`;
        const keyLive = `${base}:live`;
        const keyEnded = `${base}:ended`;
        const targetKey = state === 'soon' ? keySoon : state === 'live' ? keyLive : keyEnded;
        if (st.sent[targetKey]) continue;

        // Refresh from durable storage before acting so an overlapping Render
        // container or second bot process sees any marker already persisted.
        const refreshed = await store.load({ refresh: true });
        st = refreshed.guilds[guildId] || st;
        if (!st.sent) st.sent = {};
        if (st.sent[targetKey]) continue;

        if (state === 'soon' && !st.sent[keySoon]) {
          const claim = await store.claimAlert(guildId, keySoon);
          if (!claim.acquired) {
            await store.load({ refresh: true });
            continue;
          }
          try {
            const msg = await channel.send(await imageAlertPayload(ev, sess, 'start', st.alerts.roleId, { ping: true }));
            st.sent[keySoon] = { messageId: msg.id, at: now };
            log(`soon alert: ${ev.slug}/${sess.slug}`);
            await store.save();
          } catch (e) {
            await claim.release();
            log('soon alert failed:', e.message);
          }
        }

        if (state === 'live' && !st.sent[keyLive]) {
          const claim = await store.claimAlert(guildId, keyLive);
          if (!claim.acquired) {
            await store.load({ refresh: true });
            continue;
          }
          try {
            const soonMsgId = st.sent[keySoon] && st.sent[keySoon].messageId;
            let liveMsgId = null;
            if (soonMsgId) {
              try {
                // Edit directly by ID (no messages.fetch needed, so missing
                // ReadMessageHistory never causes a duplicate live message).
                const edited = await channel.messages.edit(soonMsgId, await imageAlertPayload(ev, sess, 'live', st.alerts.roleId, { edit: true }));
                liveMsgId = (edited && edited.id) || soonMsgId;
              } catch (editErr) {
                // Only post a replacement if Discord confirms the soon message
                // was deleted (10008 Unknown Message). Transient errors retry
                // the in-place edit on the next tick instead of double-posting.
                if (Number(editErr && editErr.code) !== 10008) throw editErr;
              }
            }
            if (!liveMsgId) {
              const msg = await channel.send(await imageAlertPayload(ev, sess, 'live', st.alerts.roleId, { ping: true }));
              liveMsgId = msg.id;
            }
            st.sent[keyLive] = { messageId: liveMsgId, at: now };
            log(`live alert: ${ev.slug}/${sess.slug}`);
            await store.save();
          } catch (e) {
            await claim.release();
            log('live alert failed:', e.message);
          }
        }

        if (state === 'ended' && !st.sent[keyEnded]) {
          const claim = await store.claimAlert(guildId, keyEnded);
          if (!claim.acquired) {
            await store.load({ refresh: true });
            continue;
          }
          // Record first so a deleted message never retry-spams the channel.
          const existingId = (st.sent[keyLive] && st.sent[keyLive].messageId) || (st.sent[keySoon] && st.sent[keySoon].messageId);
          st.sent[keyEnded] = { messageId: existingId || 'none', at: now };
          if (existingId && existingId !== 'none') {
            try {
              await channel.messages.edit(existingId, await imageAlertPayload(ev, sess, 'end', st.alerts.roleId, { edit: true }));
              log(`ended alert: ${ev.slug}/${sess.slug}`);
            } catch (e) { log('ended edit failed (message gone?):', e.message); }
          }
          await store.save();
        }
      }

      // prune sent-history older than 7 days
      const cutoff = now - 7 * 86400000;
      let pruned = false;
      for (const k of Object.keys(st.sent)) if ((st.sent[k].at || 0) < cutoff) { delete st.sent[k]; pruned = true; }
      if (pruned) await store.save();
    }
    } finally {
      tickInFlight = false;
    }
  }

  /* ── commands ── */
  const commands = [
    { name: 'rolemenu', description: 'Owner: post the supporter-role panel (one embed, 22 driver buttons).', dm_permission: false },
    {
      name: 'alertsmenu', description: 'Owner: post the stream-alerts opt-in panel in this channel.', dm_permission: false,
      options: [
        { type: 7, name: 'channel', description: 'Where session alerts get posted (defaults to this channel)', required: false, channel_types: [0] },
        { type: 8, name: 'role', description: 'Ping role to grant (defaults to Stream Alerts)', required: false },
      ],
    },
    {
      name: 'config', description: 'Owner: view or change bot settings (editable at runtime).', dm_permission: false,
      options: [
        { name: 'view', type: 1, description: 'Show current settings, bindings and panel links' },
        {
          name: 'set', type: 1, description: 'Change one or more settings',
          options: [
            { type: 7, name: 'alerts_channel', description: 'Where session alerts get posted', required: false, channel_types: [0] },
            { type: 8, name: 'alerts_role', description: 'Role pinged by starting-soon alerts', required: false },
            { type: 4, name: 'soon_minutes', description: 'Lead time for STARTING SOON alerts (1-120, default 10)', required: false, min_value: 1, max_value: 120 },
          ],
        },
      ],
    },
    {
      name: 'test', description: 'Owner: send a test image alert in this channel.', dm_permission: false,
      options: [
        { name: 'start', type: 1, description: 'Test the starting-soon image' },
        { name: 'live', type: 1, description: 'Test the live image' },
        { name: 'end', type: 1, description: 'Test the session-ended image' },
      ],
    },
    { name: 'status', description: 'Owner: bindings, panels, next session and store at a glance.', dm_permission: false },
    {
      name: 'live', description: 'Owner: test-fire an image alert into the alerts channel.', dm_permission: false,
      options: [
        { type: 4, name: 'round', description: 'Round number (defaults to current/next)', required: false },
        { type: 3, name: 'session', description: 'Session slug: fp1 fp2 fp3 sprint-qualifying sprint qualifying race', required: false },
        {
          type: 3, name: 'state', description: 'Which image state to fire (default live)', required: false,
          choices: [
            { name: 'starting soon', value: 'soon' },
            { name: 'live now', value: 'live' },
            { name: 'ended', value: 'ended' },
          ],
        },
      ],
    },
    { name: 'emojis', description: 'Owner: upload any missing number emojis to this server.', dm_permission: false },
    { name: 'website', description: 'The FreeF1 stream hub and links.' },
  ];

  /* ── interactions ── */
  async function onInteraction(interaction) {
    if (interaction.isButton()) {
      if (interaction.customId === 'freef1:alerts') return handleAlertsButton(interaction);
      if (interaction.customId.startsWith('freef1:grid:')) return handleGridButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      const cmd = interaction.commandName;
      if (cmd !== 'website' && interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: 'Owner-only command.', ephemeral: true });
      }
      const guild = interaction.guild;

      if (cmd === 'website') {
        await interaction.deferReply();
        return interaction.editReply(await websitePayload(deps.siteUrl, deps.discordInvite));
      }

      if (cmd === 'test') {
        await interaction.deferReply({ ephemeral: true });
        const state = interaction.options.getSubcommand();
        const fallback = SEASON[SEASON.length - 1];
        const found = liveSession() || nextSession() || (fallback && { ev: fallback, sess: fallback.sessions[fallback.sessions.length - 1] });
        if (!found?.sess) return interaction.editReply({ content: 'No session is available for the test.' });
        if (!interaction.channel?.send) return interaction.editReply({ content: 'I cannot send messages in this channel.' });
        const msg = await interaction.channel.send(await testAlertPayload(found.ev, found.sess, state, deps.siteUrl));
        return interaction.editReply({ content: `Test alert sent in this channel: ${msg.url}` });
      }

      const st = await store.guild(guild.id);

      if (cmd === 'emojis') {
        await interaction.deferReply({ ephemeral: true });
        await ensureEmojis(guild, st);
        return interaction.editReply({ content: `Emoji set complete: ${Object.keys(st.emojiIds).length} ids stored.` });
      }

      if (cmd === 'rolemenu') {
        await interaction.deferReply({ ephemeral: true });
        await postGridPanel(guild, interaction.channel, st);
        return interaction.editReply({ content: 'Supporter panel posted: one embed, 22 driver buttons. Clicks toggle roles.' });
      }

      if (cmd === 'alertsmenu') {
        await interaction.deferReply({ ephemeral: true });
        const alertsChannel = interaction.options.getChannel('channel') || interaction.channel;
        await postAlertsPanel(guild, interaction.channel, st, interaction.options.getRole('role'), alertsChannel);
        return interaction.editReply({ content: `Alerts panel posted in ${interaction.channel}. Session alerts will go to ${alertsChannel}.` });
      }

      if (cmd === 'config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'view') {
          const grid = st.panels.grid;
          const alerts = st.panels.alerts;
          return interaction.reply({
            ephemeral: true,
            embeds: [{
              color: FREEF1_RED,
              title: 'FreeF1 bot configuration',
              fields: [
                { name: 'Alerts channel', value: st.alerts && st.alerts.channelId ? `<#${st.alerts.channelId}>` : 'not set', inline: true },
                { name: 'Alerts role', value: st.alerts && st.alerts.roleId ? `<@&${st.alerts.roleId}>` : 'not set', inline: true },
                { name: 'Soon lead time', value: `${soonMinutesFor(st)} min`, inline: true },
                { name: 'Grid panel', value: grid ? `https://discord.com/channels/${guild.id}/${grid.channelId}/${grid.messageId}` : 'not posted', inline: false },
                { name: 'Alerts panel', value: alerts ? `https://discord.com/channels/${guild.id}/${alerts.channelId}/${alerts.messageId}` : 'not posted', inline: false },
              ],
            }],
          });
        }
        // set
        const changed = [];
        const ch = interaction.options.getChannel('alerts_channel');
        const role = interaction.options.getRole('alerts_role');
        const soon = interaction.options.getInteger('soon_minutes');
        if (ch) { st.alerts = { channelId: ch.id, roleId: st.alerts ? st.alerts.roleId : null }; changed.push(`alerts channel -> ${ch}`); }
        if (role) { st.alerts = { channelId: st.alerts ? st.alerts.channelId : null, roleId: role.id }; changed.push(`alerts role -> ${role.name}`); }
        if (soon !== null) { st.config.soonMinutes = soon; changed.push(`soon lead time -> ${soon} min`); }
        if (!changed.length) return interaction.reply({ content: 'Nothing to change - pass at least one option to /config set.', ephemeral: true });
        await store.save();
        return interaction.reply({ content: `Updated:\n- ${changed.join('\n- ')}`, ephemeral: true });
      }

      if (cmd === 'status') {
        const next = nextSession();
        const live = liveSession();
        const grid = st.panels.grid;
        return interaction.reply({
          ephemeral: true,
          embeds: [{
            color: live ? FREEF1_GREEN : FREEF1_RED,
            title: `FreeF1 Race Control - ${guild.name}`,
            fields: [
              { name: 'Now', value: live ? `LIVE: ${live.ev.name} · ${live.sess.name}` : (next ? `Next: ${next.ev.name} · ${next.sess.name} <t:${Math.floor(next.sess.ts / 1000)}:R>` : 'Season complete'), inline: false },
              { name: 'Alerts', value: st.alerts && st.alerts.channelId ? `<#${st.alerts.channelId}> pinging ${st.alerts.roleId ? `<@&${st.alerts.roleId}>` : 'nobody'}` : 'not configured', inline: false },
              { name: 'Panels', value: `grid: ${grid ? 'posted' : 'not posted'} · alerts: ${st.panels.alerts ? 'posted' : 'not posted'} · legacy reaction panels: ${st.panels.d1 || st.panels.d2 ? 'yes' : 'no'}`, inline: false },
              { name: 'Roles', value: `${Object.keys(st.driverRoles).length}/${ALL_DRIVERS.length} grid roles mapped · ${Object.keys(st.emojiIds).length} emojis stored`, inline: false },
              { name: 'Store', value: deps.upstash ? 'Upstash Redis (durable)' : 'local JSON', inline: true },
              { name: 'Soon lead', value: `${soonMinutesFor(st)} min`, inline: true },
            ],
          }],
        });
      }

      if (cmd === 'live') {
        await interaction.deferReply({ ephemeral: true });
        const round = interaction.options.getInteger('round');
        const slug = interaction.options.getString('session');
        // A supplied round or slug must match. Falling back would post a
        // different session than the one the owner asked to test.
        const found = (round == null && !slug)
          ? (findSession(null, null) || nextSession())
          : findSession(round, slug);
        if (!found) {
          const slugs = SEASON.flatMap(e => e.sessions.map(s => s.slug)).filter((v, i, a) => a.indexOf(v) === i).join(', ');
          return interaction.editReply({ content: `No session found for that round/slug. Valid slugs: ${slugs}` });
        }
        const state = interaction.options.getString('state') || 'live';
        const bound = st.alerts && guild.channels.cache.get(st.alerts.channelId);
        const alertsCh = bound || interaction.channel;
        const imageState = state === 'soon' ? 'start' : state === 'ended' ? 'end' : 'live';
        const msg = await alertsCh.send(await imageAlertPayload(found.ev, found.sess, imageState, null));
        const where = bound ? String(alertsCh) : `${alertsCh} (no alerts channel set - posted here)`;
        return interaction.editReply({ content: `Posted ${state} image for ${found.ev.name} · ${found.sess.name} to ${where}: ${msg.url}` });
      }
    } catch (e) {
      log('command failed:', e.message);
      const payload = { content: `Command failed: ${e.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(payload).catch(() => {});
    }
  }

  /* ── lifecycle ── */
  let schedulerStarted = false; // ClientReady re-fires on gateway reconnects; start the loop once
  let tickTimer = null;
  client.once(Events.ClientReady, async () => {
    log(`connected as ${client.user.tag}`);
    try {
      const rest = new REST({ version: '10' }).setToken(deps.token);
      if (deps.guildId) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, deps.guildId), { body: commands });
        log(`commands registered (guild-scoped) in ${deps.guildId}`);
      } else {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        log('commands registered (global)');
      }
    } catch (e) { log('command registration failed:', e.message); }

    for (const guild of client.guilds.cache.values()) {
      const st = await store.guild(guild.id);
      discoverDriverRoles(guild, st);
      log(`guild: ${guild.name} — ${Object.keys(st.driverRoles).length} grid roles mapped`);
    }

    if (ticketFeatureEnabled && typeof deps.getOpenTicketChannelIds === 'function') {
      try {
        const openChannelIds = await deps.getOpenTicketChannelIds();
        const synced = await syncTicketChannelPermissions(openChannelIds);
        if (synced > 0) log(`tickets: synced staff role overwrites on ${synced} open channel(s)`);
      } catch (e) {
        log('ticket role sync failed:', e.message);
      }
    }

    if (!schedulerStarted) {
      schedulerStarted = true;
      tickTimer = setInterval(() => { tick().catch(e => log('tick failed:', e.message)); }, TICK_MS);
      tick().catch(e => log('tick failed:', e.message));
    }
    await syncPresence(Date.now());
  });

  client.on(Events.InteractionCreate, i => { onInteraction(i).catch(e => log('interaction error:', e.message)); });
  client.on(Events.MessageCreate, message => {
    if (!ticketFeatureEnabled || typeof deps.onTicketReply !== 'function' || message.author?.bot) return;
    if (!message.guild || message.guild.id !== String(deps.guildId)) return;
    // Ticket channels are private by construction: @everyone is denied, and
    // only the owner and the configured support role can send messages.
    const text = ticketText(message.content, 2000).trim();
    if (!text) return;
    Promise.resolve(deps.onTicketReply({
      channelId: message.channelId,
      messageId: message.id,
      text,
      createdAt: message.createdTimestamp,
      fromStaff: true,
    })).catch(error => log('ticket reply relay failed:', error.message));
  });
  client.on(Events.MessageReactionAdd, (r, u) => { handleReaction(r, u, true).catch(() => {}); });
  client.on(Events.MessageReactionRemove, (r, u) => { handleReaction(r, u, false).catch(() => {}); });

  client.on(Events.Error, e => log('client error:', e.message));

  client.login(deps.token).catch(e => log('login failed:', e.message));

  /* Handle for server.js: ticket API methods and graceful store flush. */
  return {
    client,
    ticketsEnabled: ticketFeatureEnabled,
    isReady: () => client.isReady(),
    createTicketChannel,
    syncTicketChannelPermissions,
    sendTicketMessage,
    fetchTicketMessages,
    deleteTicketChannel,
    flush: () => store.save(),
    stop: () => {
      if (tickTimer) clearInterval(tickTimer);
      try { client.destroy(); } catch (_) {}
    },
  };
}

module.exports = {
  start,
  _test: {
    driverPanelEmbed, gridPanelPayload, alertsPanelEmbed, sessionEmbed, websitePayload, testAlertPayload, imageAlertPayload,
    gridRows, alertsRow, alertsPanelPayload,
    nextSession, liveSession, sessionState, findSession, presenceActivity,
    parseTicketStaffRoleIds, DEFAULT_TICKET_STAFF_ROLE_IDS,
    TEAMS, ALL_DRIVERS, OWNER_ID, DEFAULT_SOON_MINUTES, SESSION_MIN,
  },
};
