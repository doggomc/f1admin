#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const {
  HelpTicketError,
  HelpTicketService,
  normalizeChatMessage,
  normalizeDiagnostics,
  normalizeHelpRequest,
  normalizeState,
  tokenHash,
} = require('../support-tickets');

function token(seed) {
  return Buffer.alloc(32, seed).toString('base64url');
}

function makeBot() {
  let nextChannel = 100000000000000000n;
  let nextMessage = 200000000000000000n;
  const channels = new Map();
  return {
    ticketsEnabled: true,
    isReady: () => true,
    channels,
    async createTicketChannel(request) {
      const channelId = String(++nextChannel);
      channels.set(channelId, {
        ticketId: request.ticketId,
        messages: [{
          id: String(++nextMessage), role: 'visitor', author: 'You', text: request.message, createdAt: request.createdAt,
        }],
      });
      return channelId;
    },
    async fetchTicketMessages(channelId) {
      const channel = channels.get(String(channelId));
      if (!channel) throw new Error('missing channel');
      return channel.messages.slice();
    },
    async sendTicketMessage(channelId, { text }) {
      const channel = channels.get(String(channelId));
      if (!channel) throw new Error('missing channel');
      const message = { id: String(++nextMessage), role: 'visitor', author: 'You', text, createdAt: Date.now() };
      channel.messages.push(message);
      return message;
    },
    async deleteTicketChannel(channelId) {
      channels.delete(String(channelId));
      return true;
    },
  };
}

function makeService({ bot = makeBot(), initial = null, ready = () => true, now = () => 1_800_000_000_000 } = {}) {
  let saved = initial;
  const service = new HelpTicketService({
    loadState: async () => saved,
    saveState: async value => { saved = JSON.parse(JSON.stringify(value)); return true; },
    getBot: () => bot,
    storageReady: ready,
    now,
    log: () => {},
  });
  return { service, bot, getSaved: () => saved };
}

function requestBody(seed, text = 'The site is not loading for me.') {
  return {
    name: `Driver ${seed}`,
    category: 'website',
    message: text,
    diagnostics: {
      browser: 'Test Browser 1.0', platform: 'Test OS', viewport: '800×600',
      route: '/help.html', unexpected: 'must be discarded',
    },
  };
}

(async () => {
  let checks = 0;
  const check = async (label, callback) => {
    await callback();
    checks++;
    console.log(` ok    ${label}`);
  };

  await check('browser token validation and hashing never expose the raw token', () => {
    const browserToken = token(11);
    assert.equal(browserToken.length, 43);
    assert.match(tokenHash(browserToken), /^[a-f0-9]{64}$/);
    assert.notEqual(tokenHash(browserToken), browserToken);
    assert.equal(tokenHash('short'), null);
  });

  await check('initial request normalization enforces categories and whitelists diagnostics', () => {
    const request = normalizeHelpRequest(requestBody(1));
    assert.equal(request.name, 'Driver 1');
    assert.equal(request.message, 'The site is not loading for me.');
    assert.deepEqual(Object.keys(request.diagnostics), ['browser', 'platform', 'viewport', 'route']);
    assert.throws(() => normalizeHelpRequest({ ...requestBody(1), category: 'injection' }), HelpTicketError);
    assert.throws(() => normalizeHelpRequest({ ...requestBody(1), message: 'too short' }), error => error.status === 400);
  });

  await check('diagnostics and chat text remove control characters and obey length caps', () => {
    assert.equal(normalizeDiagnostics({ browser: 'Chrome\u0000\nDesktop', extra: 'ignored' }).browser, 'Chrome Desktop');
    assert.equal(Object.hasOwn(normalizeDiagnostics({ extra: 'ignored' }), 'extra'), false);
    assert.equal(normalizeChatMessage('  first\n   second  '), 'first\nsecond');
    assert.throws(() => normalizeChatMessage(' '), error => error.status === 400);
    assert.throws(() => normalizeChatMessage('x'.repeat(2001)), error => error.status === 413);
  });

  await check('loaded state is normalized to open tickets with hashed keys and valid Discord IDs', () => {
    const validHash = tokenHash(token(12));
    const state = normalizeState({ nextNumber: 8, tickets: {
      'ticket-0007': { status: 'open', browserKeyHash: validHash, channelId: '123456789012345678', name: 'A', category: 'playback', createdAt: 100 },
      'ticket-0008': { status: 'closed', browserKeyHash: validHash, channelId: '123456789012345678' },
      'ticket-0009': { status: 'open', browserKeyHash: 'bad', channelId: '12' },
    } });
    assert.equal(state.nextNumber, 8);
    assert.deepEqual(Object.keys(state.tickets), ['ticket-0007']);
    assert.equal(state.tickets['ticket-0007'].category, 'playback');
    const repairedCounter = normalizeState({ nextNumber: 1, tickets: {
      'ticket-0007': { status: 'open', browserKeyHash: validHash, channelId: '123456789012345678' },
    } });
    assert.equal(repairedCounter.nextNumber, 8);
  });

  const { service, bot, getSaved } = makeService();
  const browserToken = token(21);
  const created = await service.createTicket({ token: browserToken, body: requestBody(21), ipKey: 'ip-key-a' });
  await check('ticket creation assigns a sequential private channel and stores only a token hash', () => {
    assert.equal(created.ticket.id, 'ticket-0001');
    assert.equal(created.ticket.category, 'website');
    assert.equal(created.messages.length, 1);
    assert.ok(getSaved().tickets['ticket-0001']);
    assert.equal(JSON.stringify(getSaved()).includes(browserToken), false);
    assert.equal(getSaved().tickets['ticket-0001'].browserKeyHash, tokenHash(browserToken));
  });

  await check('one browser token can hold only one open ticket and other tokens cannot read it', async () => {
    await assert.rejects(
      service.createTicket({ token: browserToken, body: requestBody(22), ipKey: 'ip-key-a' }),
      error => error.status === 409,
    );
    await assert.rejects(service.getTicket(token(22)), error => error.status === 404);
    assert.equal((await service.getStatus(browserToken)).ticket.id, 'ticket-0001');
  });

  const sent = await service.sendMessage({ token: browserToken, text: '  A second   message.  ' });
  await check('browser messages go through the bot channel and are normalized', () => {
    assert.equal(sent.message.text, 'A second message.');
    assert.equal(bot.channels.get(created.ticket.id === 'ticket-0001' ? getSaved().tickets['ticket-0001'].channelId : '').messages.length, 2);
  });

  await check('message rate limit is enforced per ticket', async () => {
    for (let index = 1; index < 10; index++) {
      await service.sendMessage({ token: browserToken, text: `Message ${index}` });
    }
    await assert.rejects(service.sendMessage({ token: browserToken, text: 'Too fast' }), error => error.status === 429 && error.retryAfter > 0);
  });

  await check('staff replies are relayed to SSE clients and update unread status metadata', async () => {
    const channelId = getSaved().tickets['ticket-0001'].channelId;
    const response = new EventEmitter();
    response.writes = [];
    response.write = value => { response.writes.push(value); return true; };
    response.flush = () => {};
    response.end = () => { response.ended = true; };
    service.subscribe(browserToken, response);
    const accepted = await service.handleStaffReply({
      channelId, messageId: '223456789012345678', text: 'Try refreshing the page.', createdAt: 1_800_000_000_100, fromStaff: true,
    });
    assert.equal(accepted, true);
    assert.equal(getSaved().tickets['ticket-0001'].latestStaffMessageId, '223456789012345678');
    assert.ok(response.writes.some(value => value.includes('event: staff-message') && value.includes('Try refreshing the page.')));
  });

  await check('ticket deletion removes the Discord channel, metadata, and live stream', async () => {
    const ticket = getSaved().tickets['ticket-0001'];
    const response = new EventEmitter();
    response.writes = [];
    response.write = value => { response.writes.push(value); return true; };
    response.flush = () => {};
    response.end = () => { response.ended = true; };
    service.subscribe(browserToken, response);
    const deleted = await service.deleteTicket(browserToken);
    assert.equal(deleted.deleted, true);
    assert.equal(bot.channels.has(ticket.channelId), false);
    assert.equal(Object.hasOwn(getSaved().tickets, 'ticket-0001'), false);
    assert.equal(response.ended, true);
    assert.ok(response.writes.some(value => value.includes('event: closed')));
    await assert.rejects(service.getStatus(browserToken), error => error.status === 404);
  });

  const afterDelete = await service.createTicket({ token: browserToken, body: requestBody(21), ipKey: 'ip-key-b' });
  await check('ticket numbering remains increasing after deletion', () => assert.equal(afterDelete.ticket.id, 'ticket-0002'));

  await check('per-IP short-window creation limit returns 429 with Retry-After', async () => {
    const limited = makeService({ now: () => 1_800_000_000_000 });
    for (let index = 1; index <= 3; index++) {
      await limited.service.createTicket({ token: token(30 + index), body: requestBody(index), ipKey: 'same-ip' });
    }
    await assert.rejects(
      limited.service.createTicket({ token: token(35), body: requestBody(35), ipKey: 'same-ip' }),
      error => error.status === 429 && error.retryAfter > 0,
    );
  });

  await check('ticket creation fails closed if storage or the Discord bot is unavailable', async () => {
    const noStorage = makeService({ ready: () => false });
    await assert.rejects(noStorage.service.createTicket({ token: token(40), body: requestBody(40) }), error => error.status === 503);
    const noBot = makeService({ bot: null });
    await assert.rejects(noBot.service.createTicket({ token: token(41), body: requestBody(41) }), error => error.status === 503);
  });

  console.log(`\n${checks}/${checks} checks passed`);
})().catch(error => {
  console.error('help-tickets-check failed:', error.stack || error);
  process.exit(1);
});
