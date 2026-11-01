'use strict';

/* ════════════════════════════════════════════════════════════════════
   Prints the two ids the Discord gate needs, straight from Discord.
   ════════════════════════════════════════════════════════════════════
   Usage (from the f1admin folder, with your bot token):

     DISCORD_BOT_TOKEN=your-bot-token node scripts/discord-ids.js

   or

     node scripts/discord-ids.js --token your-bot-token

   It reports:
     • the application id  → paste as DISCORD_CLIENT_ID
     • every server the bot is in, with ids → pick one for DISCORD_GUILD_ID

   It cannot read the client secret: Discord only shows that in the portal,
   under OAuth2 → Client Secret → Reset Secret. Nothing here writes anything.
   ════════════════════════════════════════════════════════════════════ */

const token = (() => {
  const flag = process.argv.indexOf('--token');
  if (flag > -1 && process.argv[flag + 1]) return process.argv[flag + 1].trim();
  return String(process.env.DISCORD_BOT_TOKEN || '').trim();
})();

if (!token) {
  console.error('No bot token.\n');
  console.error('  DISCORD_BOT_TOKEN=your-token node scripts/discord-ids.js');
  console.error('  node scripts/discord-ids.js --token your-token\n');
  console.error('The bot token is the one your Race Control bot already uses (Render env DISCORD_BOT_TOKEN).');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';

async function get(path) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  return { ok: response.ok, status: response.status, json, text };
}

(async () => {
  const app = await get('/oauth2/applications/@me');
  if (!app.ok) {
    console.error(`Discord refused the token (${app.status}). ${app.text.slice(0, 160)}`);
    process.exit(1);
  }

  console.log('');
  console.log('Application');
  console.log(`  name           ${app.json.name}`);
  console.log(`  DISCORD_CLIENT_ID / Application ID   ${app.json.id}`);
  console.log('  (Client ID and Application ID are the same number.)');
  console.log('');

  const guilds = await get('/users/@me/guilds');
  if (!guilds.ok || !Array.isArray(guilds.json)) {
    console.log(`Could not list servers (${guilds.status}).`);
  } else if (!guilds.json.length) {
    console.log('This bot is in no servers. Invite it, or read the id from the server itself:');
    console.log('  Developer Mode on → right-click the server icon → Copy Server ID');
  } else {
    console.log('Servers this bot is in  (use one as DISCORD_GUILD_ID)');
    for (const guild of guilds.json) {
      console.log(`  ${String(guild.id).padEnd(20)} ${guild.name}`);
    }
  }

  console.log('');
  console.log('Still needed from the portal, not from this script:');
  console.log('  Bot → Privileged Gateway Intents as required for tickets, and the invite URL below.');
  console.log('  There is no OAuth2 redirect any more: the 4K feed is public and needs no linking.');
  console.log('');
})();
