#!/usr/bin/env node
'use strict';

/* Guard the retained Discord companion features while ensuring the optional
   voice relay stays fully removed. */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const botPath = path.join(root, 'bot', 'discord-bot.js');
const bot = fs.readFileSync(botPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const commandStart = bot.indexOf('const commands = [');
const commandEnd = bot.indexOf('/* ── interactions ── */', commandStart);
const commandBlock = commandStart >= 0 && commandEnd > commandStart
  ? bot.slice(commandStart, commandEnd)
  : '';

const results = [];
const check = (label, pass, detail = '') => results.push({ label, pass: Boolean(pass), detail });
const retainedCommands = ['rolemenu', 'alertsmenu', 'config', 'status', 'live', 'emojis', 'website'];

const isRegistered = name => commandBlock.includes(`name: '${name}'`);
check('command registration retains every non-relay bot command', Boolean(commandBlock) &&
  retainedCommands.every(isRegistered),
  retainedCommands.filter(name => !isRegistered(name)).join(', '));
check('retained commands still have their interaction handlers',
  retainedCommands.every(name => name === 'website' || bot.includes(`if (cmd === '${name}')`)),
  retainedCommands.filter(name => name !== 'website' && !bot.includes(`if (cmd === '${name}')`)).join(', '));
check('session-alert scheduler and bot presence remain',
  /async function tick\s*\(/.test(bot) && /setInterval\(\(\) => \{ tick\(\)/.test(bot) &&
  /async function syncPresence\s*\(/.test(bot));
check('driver-role and alert-panel interactions remain',
  /async function handleGridButton\s*\(/.test(bot) && /async function handleAlertsButton\s*\(/.test(bot) &&
  /client\.on\(Events\.MessageReactionAdd/.test(bot));
check('website and session-alert link embeds remain',
  /function websiteEmbed\s*\(/.test(bot) && /function sessionEmbed\s*\(/.test(bot));
check('voice relay runtime and slash command are removed',
  !/relayModule|\brelay\.(?:start|stop|status|setPaused|stopAll)|name:\s*['"]watchparty['"]|GuildVoiceStates|VoiceStateUpdate/.test(bot));
check('voice dependencies and deployment settings are removed',
  !/@discordjs\/(?:voice|opus)|ffmpeg-static|FREEF1_AUDIO_URL|FFMPEG_PATH|APEX_AUDIO_URL/.test(
    JSON.stringify(packageJson) + server + envExample));
check('legacy persisted relay state is cleared without replacing other bot settings',
  /delete g\.relay/.test(bot) && /delete g\.config\.audioUrl/.test(bot));
check('Help ticket Message Content intent is requested only behind the explicit feature flag',
  /const ticketFeatureEnabled = deps\.ticketsEnabled === true && Boolean\(deps\.guildId && OWNER_ID\)/.test(bot) &&
  /\.\.\.\(ticketFeatureEnabled \? \[GatewayIntentBits\.MessageContent\] : \[\]\)/.test(bot) &&
  /DISCORD_TICKETS_ENABLED/.test(server));
check('Help tickets create private sequential text channels and expose history/message/delete methods',
  /type: ChannelType\.GuildText/.test(bot) && /name: ticketId/.test(bot) &&
  /deny: \[PermissionFlagsBits\.ViewChannel\]/.test(bot) &&
  /guild\.channels\.create\(options\)/.test(bot) &&
  ['createTicketChannel', 'sendTicketMessage', 'fetchTicketMessages', 'deleteTicketChannel'].every(name => bot.includes(name)));
check('typed private-channel replies are relayed through MessageCreate and server ticket service',
  /client\.on\(Events\.MessageCreate/.test(bot) && /onTicketReply\(\{/.test(bot) &&
  /handleStaffReply\(message\)/.test(server) && /\/api\/help\/events/.test(server));
check('Help API has no upload endpoint and documents required ticket storage and Discord setup',
  /uploadsEnabled:\s*false/.test(server) && /DISCORD_TICKET_CATEGORY_ID/.test(envExample) &&
  /DISCORD_TICKET_STAFF_ROLE_ID/.test(envExample) && /Message Content Intent/.test(fs.readFileSync(path.join(root, 'bot', 'README.md'), 'utf8')) &&
  /persistent disk/.test(fs.readFileSync(path.join(root, 'RENDER.md'), 'utf8')));
check('bot invite permissions now include Manage Channels',
  /permissions=1342262352/.test(fs.readFileSync(path.join(root, 'bot', 'README.md'), 'utf8')));

let failures = 0;
for (const result of results) {
  if (!result.pass) failures++;
  console.log(`  ${result.pass ? 'ok  ' : 'FAIL'}  ${result.label}${result.pass || !result.detail ? '' : `  →  ${result.detail}`}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
