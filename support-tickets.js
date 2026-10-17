'use strict';

const crypto = require('crypto');

const HELP_CATEGORIES = Object.freeze([
  { id: 'website', label: 'Website issue' },
  { id: 'playback', label: 'Playback issue' },
  { id: 'timing', label: 'Timing or results' },
  { id: 'discord', label: 'Discord or account help' },
  { id: 'other', label: 'Other' },
]);

const MAX_NAME_LENGTH = 48;
const MAX_INITIAL_MESSAGE_LENGTH = 4000;
const MAX_CHAT_MESSAGE_LENGTH = 2000;
const MAX_DIAGNOSTIC_LENGTH = 160;
const INITIAL_TICKET_STATE = Object.freeze({ version: 1, nextNumber: 1, tickets: {} });

class HelpTicketError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.name = 'HelpTicketError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function safeText(value, maxLength, { lines = false } = {}) {
  let text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  if (lines) text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  else text = text.replace(/\s+/g, ' ');
  return text.trim().slice(0, maxLength).trim();
}

function normalizeDiagnostics(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const keys = ['browser', 'platform', 'screen', 'viewport', 'language', 'timezone', 'route', 'online'];
  const result = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    result[key] = safeText(value, MAX_DIAGNOSTIC_LENGTH);
  }
  return result;
}

function normalizeHelpRequest(body = {}) {
  const name = safeText(body.name, MAX_NAME_LENGTH);
  const category = safeText(body.category, 32);
  const message = safeText(body.message, MAX_INITIAL_MESSAGE_LENGTH, { lines: true });
  if (name.length < 2) throw new HelpTicketError(400, 'Please enter a name of at least 2 characters.');
  if (!HELP_CATEGORIES.some(item => item.id === category)) throw new HelpTicketError(400, 'Choose a valid help category.');
  if (message.length < 10) throw new HelpTicketError(400, 'Please describe the issue in at least 10 characters.');
  return { name, category, message, diagnostics: normalizeDiagnostics(body.diagnostics) };
}

function normalizeChatMessage(value) {
  const text = safeText(value, MAX_CHAT_MESSAGE_LENGTH, { lines: true });
  if (!text) throw new HelpTicketError(400, 'Message cannot be empty.');
  if (String(value || '').length > MAX_CHAT_MESSAGE_LENGTH) throw new HelpTicketError(413, `Messages must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer.`);
  return text;
}

function tokenHash(token) {
  const value = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...INITIAL_TICKET_STATE, tickets: {} };
  const requestedNextNumber = Number.isSafeInteger(value.nextNumber) && value.nextNumber > 0 ? value.nextNumber : 1;
  const tickets = value.tickets && typeof value.tickets === 'object' && !Array.isArray(value.tickets)
    ? value.tickets
    : {};
  const normalizedTickets = {};
  let largestTicketNumber = 0;
  for (const [id, raw] of Object.entries(tickets)) {
    if (!/^ticket-\d{4,}$/.test(id) || !raw || typeof raw !== 'object' || raw.status !== 'open') continue;
    if (!/^[a-f0-9]{64}$/.test(String(raw.browserKeyHash || '')) || !/^\d{17,20}$/.test(String(raw.channelId || ''))) continue;
    const ticketNumber = Number(id.slice('ticket-'.length));
    if (Number.isSafeInteger(ticketNumber)) largestTicketNumber = Math.max(largestTicketNumber, ticketNumber);
    normalizedTickets[id] = {
      id,
      channelId: String(raw.channelId),
      browserKeyHash: String(raw.browserKeyHash),
      name: safeText(raw.name, MAX_NAME_LENGTH),
      category: HELP_CATEGORIES.some(item => item.id === raw.category) ? raw.category : 'other',
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      latestStaffMessageId: /^\d{17,20}$/.test(String(raw.latestStaffMessageId || '')) ? String(raw.latestStaffMessageId) : null,
      status: 'open',
    };
  }
  const nextNumber = Math.max(requestedNextNumber, largestTicketNumber + 1);
  return { version: 1, nextNumber, tickets: normalizedTickets };
}

function publicTicket(ticket) {
  return {
    id: ticket.id,
    name: ticket.name,
    category: ticket.category,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    latestStaffMessageId: ticket.latestStaffMessageId || null,
  };
}

function consumeWindow(map, key, limit, windowMs, now) {
  const current = map.get(key) || [];
  const cutoff = now - windowMs;
  const recent = current.filter(time => time > cutoff);
  if (recent.length >= limit) {
    map.set(key, recent);
    return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
  }
  recent.push(now);
  map.set(key, recent);
  if (map.size > 3000) {
    for (const [entryKey, times] of map) {
      if (!times.some(time => time > cutoff)) map.delete(entryKey);
    }
    while (map.size > 3000) map.delete(map.keys().next().value);
  }
  return 0;
}

class HelpTicketService {
  constructor({ loadState, saveState, getBot, storageReady = () => true, now = Date.now, log = () => {} } = {}) {
    this.loadState = loadState || (async () => null);
    this.saveState = saveState || (async () => true);
    this.getBot = getBot || (() => null);
    this.storageReady = storageReady;
    this.now = now;
    this.log = log;
    this.state = { ...INITIAL_TICKET_STATE, tickets: {} };
    this.queue = Promise.resolve();
    this.createRates = new Map();
    this.dailyCreateRates = new Map();
    this.messageRates = new Map();
    this.streams = new Map();
    this.ready = this.initialize();
  }

  async initialize() {
    try {
      this.state = normalizeState(await this.loadState());
      return true;
    } catch (error) {
      this.log('ticket state load failed:', error.message);
      this.state = { ...INITIAL_TICKET_STATE, tickets: {} };
      return false;
    }
  }

  withLock(task) {
    const pending = this.queue.then(task, task);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async persist() {
    const saved = await this.saveState(this.state);
    if (saved === false) throw new HelpTicketError(503, 'Support storage is temporarily unavailable. Please try again later.');
  }

  requireStorage() {
    if (!this.storageReady()) throw new HelpTicketError(503, 'Support tickets are not available right now. Please try again later.');
  }

  requireBot() {
    const bot = this.getBot();
    if (!bot || bot.ticketsEnabled !== true || typeof bot.isReady !== 'function' || !bot.isReady()) {
      throw new HelpTicketError(503, 'The support service is temporarily offline. Your draft is still saved in this browser.');
    }
    return bot;
  }

  availability() {
    const bot = this.getBot();
    const ready = Boolean(this.storageReady() && bot && bot.ticketsEnabled === true && typeof bot.isReady === 'function' && bot.isReady());
    return { available: ready };
  }

  findByBrowserHash(hash) {
    return Object.values(this.state.tickets).find(ticket => ticket.status === 'open' && ticket.browserKeyHash === hash) || null;
  }

  findByChannel(channelId) {
    return Object.values(this.state.tickets).find(ticket => ticket.status === 'open' && ticket.channelId === String(channelId)) || null;
  }

  requireTicket(token) {
    const hash = tokenHash(token);
    if (!hash) throw new HelpTicketError(401, 'This browser does not have a valid support key.');
    const ticket = this.findByBrowserHash(hash);
    if (!ticket) throw new HelpTicketError(404, 'There is no open ticket saved in this browser.');
    return { ticket, hash };
  }

  async createTicket({ token, body, ipKey = 'unknown' } = {}) {
    await this.ready;
    this.requireStorage();
    const hash = tokenHash(token);
    if (!hash) throw new HelpTicketError(400, 'A valid browser support key is required.');
    const request = normalizeHelpRequest(body);
    const now = this.now();
    const shortRetry = consumeWindow(this.createRates, String(ipKey), 3, 10 * 60 * 1000, now);
    const dailyRetry = consumeWindow(this.dailyCreateRates, String(ipKey), 5, 24 * 60 * 60 * 1000, now);
    if (shortRetry || dailyRetry) {
      const retry = Math.max(shortRetry, dailyRetry);
      throw new HelpTicketError(429, 'Too many ticket requests. Please wait before trying again.', retry);
    }

    return this.withLock(async () => {
      const existing = this.findByBrowserHash(hash);
      if (existing) throw new HelpTicketError(409, `This browser already has open ticket ${existing.id}.`, 0);
      const bot = this.requireBot();
      const sequence = this.state.nextNumber;
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) {
        throw new HelpTicketError(503, 'Ticket numbering is temporarily unavailable.');
      }
      const ticketId = `ticket-${String(sequence).padStart(4, '0')}`;
      const previousNext = this.state.nextNumber;
      this.state.nextNumber = sequence + 1;
      try {
        await this.persist();
      } catch (error) {
        this.state.nextNumber = previousNext;
        throw error;
      }

      let channelId;
      try {
        channelId = await bot.createTicketChannel({ ticketId, ...request, createdAt: now });
      } catch (error) {
        this.log('ticket channel creation failed:', error.message);
        throw new HelpTicketError(502, 'Discord could not create the private ticket channel. Please try again later.');
      }
      if (!/^\d{17,20}$/.test(String(channelId || ''))) {
        try { await bot.deleteTicketChannel?.(String(channelId || '')); } catch (_) {}
        throw new HelpTicketError(502, 'Discord returned an invalid ticket channel. Please try again later.');
      }

      const ticket = {
        id: ticketId,
        channelId: String(channelId),
        browserKeyHash: hash,
        name: request.name,
        category: request.category,
        createdAt: now,
        updatedAt: now,
        latestStaffMessageId: null,
        status: 'open',
      };
      this.state.tickets[ticketId] = ticket;
      try {
        await this.persist();
      } catch (error) {
        delete this.state.tickets[ticketId];
        try { await bot.deleteTicketChannel(ticket.channelId); } catch (cleanupError) {
          this.log('orphaned ticket channel cleanup failed:', cleanupError.message);
        }
        throw error;
      }

      let messages = [];
      try { messages = await bot.fetchTicketMessages(ticket.channelId); }
      catch (error) { this.log('initial ticket history fetch failed:', error.message); }
      return { ticket: publicTicket(ticket), messages: Array.isArray(messages) ? messages : [] };
    });
  }

  async getStatus(token) {
    await this.ready;
    const { ticket } = this.requireTicket(token);
    return { open: true, ticket: publicTicket(ticket) };
  }

  async getTicket(token) {
    await this.ready;
    const { ticket } = this.requireTicket(token);
    const bot = this.requireBot();
    const messages = await bot.fetchTicketMessages(ticket.channelId);
    return { ticket: publicTicket(ticket), messages: Array.isArray(messages) ? messages : [] };
  }

  async sendMessage({ token, text } = {}) {
    await this.ready;
    this.requireStorage();
    const { ticket } = this.requireTicket(token);
    const bot = this.requireBot();
    const message = normalizeChatMessage(text);
    const retry = consumeWindow(this.messageRates, ticket.id, 10, 60 * 1000, this.now());
    if (retry) throw new HelpTicketError(429, 'You are sending messages too quickly. Please wait a moment.', retry);
    const sent = await bot.sendTicketMessage(ticket.channelId, { name: ticket.name, text: message });
    ticket.updatedAt = this.now();
    try { await this.persist(); }
    catch (error) { this.log('ticket activity timestamp was not saved:', error.message); }
    return { message: sent };
  }

  async deleteTicket(token) {
    await this.ready;
    this.requireStorage();
    return this.withLock(async () => {
      const { ticket } = this.requireTicket(token);
      const bot = this.requireBot();
      await bot.deleteTicketChannel(ticket.channelId);
      delete this.state.tickets[ticket.id];
      for (const response of this.streams.get(ticket.id) || []) {
        try { response.write('event: closed\ndata: {}\n\n'); response.end(); } catch (_) {}
      }
      this.streams.delete(ticket.id);
      try { await this.persist(); }
      catch (error) { this.log('deleted ticket metadata could not be persisted:', error.message); }
      return { deleted: true, ticketId: ticket.id };
    });
  }

  async handleStaffReply(reply = {}) {
    await this.ready;
    const ticket = this.findByChannel(reply.channelId);
    if (!ticket || reply.fromStaff !== true) return false;
    const messageId = String(reply.messageId || '');
    if (!/^\d{17,20}$/.test(messageId)) return false;
    const text = safeText(reply.text, MAX_CHAT_MESSAGE_LENGTH, { lines: true });
    if (!text) return false;
    const message = {
      id: messageId,
      role: 'staff',
      author: 'FreeF1 Support',
      text,
      createdAt: Number(reply.createdAt) || this.now(),
    };
    ticket.latestStaffMessageId = messageId;
    ticket.updatedAt = message.createdAt;
    try { await this.persist(); }
    catch (error) { this.log('ticket reply metadata save failed:', error.message); }
    const payload = JSON.stringify(message);
    for (const response of this.streams.get(ticket.id) || []) {
      try { response.write(`event: staff-message\ndata: ${payload}\n\n`); response.flush?.(); }
      catch (_) {}
    }
    return true;
  }

  subscribe(token, response) {
    const { ticket } = this.requireTicket(token);
    const current = this.streams.get(ticket.id) || new Set();
    current.add(response);
    this.streams.set(ticket.id, current);
    const remove = () => {
      current.delete(response);
      if (!current.size) this.streams.delete(ticket.id);
    };
    response.once('close', remove);
    response.once('error', remove);
    response.write('retry: 30000\n\n');
    response.flush?.();
    return ticket;
  }
}

module.exports = {
  HelpTicketError,
  HelpTicketService,
  HELP_CATEGORIES,
  MAX_NAME_LENGTH,
  MAX_INITIAL_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGE_LENGTH,
  normalizeDiagnostics,
  normalizeHelpRequest,
  normalizeChatMessage,
  tokenHash,
  normalizeState,
  publicTicket,
};
