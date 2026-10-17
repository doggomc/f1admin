#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'netlifyf1');
const pageHtml = fs.readFileSync(path.join(siteDir, 'help.html'), 'utf8');
const helpScript = fs.readFileSync(path.join(siteDir, 'help.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
const STORAGE_KEY = 'freef1.help.ticket.v1';
const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } };
}

function setHidden(window, hidden = true) {
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
}

function setRandom(window) {
  if (window.crypto?.getRandomValues) return;
  Object.defineProperty(window, 'crypto', {
    configurable: true,
    value: { getRandomValues(bytes) { for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 31) % 256; return bytes; } },
  });
}

(async () => {
  let checks = 0;
  const check = (label, condition) => {
    assert.ok(condition, label);
    checks++;
    console.log(` ok    ${label}`);
  };

  const dom = new JSDOM(pageHtml, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://freef1.netlify.app/help.html' });
  const { window } = dom;
  setHidden(window, true);
  setRandom(window);
  window.Headers = Headers;
  window.confirm = () => true;
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    const call = { path: target.pathname, method: options.method || 'GET', headers: options.headers, body: options.body };
    calls.push(call);
    if (call.path === '/api/help/config') return response({ available: true, categories: [], uploadsEnabled: false });
    if (call.path === '/api/help/tickets' && call.method === 'POST') {
      const body = JSON.parse(call.body);
      return response({
        ticket: { id: 'ticket-0007', name: body.name, category: body.category, createdAt: Date.now() },
        messages: [{ id: '223456789012345678', role: 'visitor', text: body.message, createdAt: Date.now() }],
      }, 201);
    }
    if (call.path === '/api/help/ticket/messages' && call.method === 'POST') {
      const body = JSON.parse(call.body);
      return response({ message: { id: '223456789012345679', role: 'visitor', text: body.text, createdAt: Date.now() } }, 201);
    }
    if (call.path === '/api/help/ticket' && call.method === 'DELETE') return response({ deleted: true, ticketId: 'ticket-0007' });
    return response({ error: 'unexpected test endpoint' }, 404);
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1, token: '', ticketId: '', name: '', category: '', messages: [], lastSeenStaffMessageId: '', unread: false,
    draft: { name: 'Saved draft', category: 'playback', message: 'The video player is stuck on loading.' },
  }));
  window.eval(helpScript);
  await pause(10);

  const $ = id => window.document.getElementById(id);
  check('saved request draft restores and the service availability enables submission',
    $('helpName').value === 'Saved draft' && $('helpCategory').value === 'playback' &&
    $('helpMessage').value === 'The video player is stuck on loading.' && !$('helpSubmit').disabled &&
    $('helpStatus').dataset.state === 'ready');

  $('helpName').value = 'Pit Lane';
  $('helpName').dispatchEvent(new window.Event('input', { bubbles: true }));
  const savedDraft = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
  check('form changes save locally without a backend call', savedDraft.draft.name === 'Pit Lane' && calls.length === 1);

  $('helpRequestForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await pause(10);
  const createCall = calls.find(call => call.path === '/api/help/tickets');
  const createdState = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
  const createBody = JSON.parse(createCall?.body || '{}');
  check('ticket creation uses a random browser key and sends the selected category and diagnostics',
    createCall?.method === 'POST' && /^Bearer [A-Za-z0-9_-]{43}$/.test(createCall.headers.get('Authorization')) &&
    createBody.name === 'Pit Lane' && createBody.category === 'playback' &&
    createBody.message === 'The video player is stuck on loading.' &&
    createBody.diagnostics.route === '/help.html' && createdState.token.length === 43 &&
    createdState.ticketId === 'ticket-0007');
  check('ticket creation switches from the request form to a rendered chat safely',
    $('helpRequestPanel').hidden && !$('activeTicketPanel').hidden &&
    $('ticketId').textContent === 'ticket-0007' && $('chatMessages').textContent.includes('The video player is stuck on loading.'));

  $('chatMessage').value = 'I have tried a second browser.';
  $('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await pause(10);
  const messageCall = calls.find(call => call.path === '/api/help/ticket/messages');
  check('web chat sends a small text POST with the ticket bearer key and renders the response',
    messageCall?.method === 'POST' && /^Bearer [A-Za-z0-9_-]{43}$/.test(messageCall.headers.get('Authorization')) &&
    $('chatMessages').textContent.includes('I have tried a second browser.'));

  $('deleteTicket').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await pause(10);
  const deleteCall = calls.find(call => call.path === '/api/help/ticket' && call.method === 'DELETE');
  const deletedState = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
  check('deleting the ticket calls the backend, clears browser access, and returns to the form',
    Boolean(deleteCall) && !deletedState.token && !deletedState.ticketId &&
    !$('helpRequestPanel').hidden && $('activeTicketPanel').hidden);

  window.close();

  const badgeDom = new JSDOM(indexHtml, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://freef1.netlify.app/' });
  const badgeWindow = badgeDom.window;
  setHidden(badgeWindow, true);
  badgeWindow.Headers = Headers;
  badgeWindow.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    assert.equal(target.pathname, '/api/help/ticket/status');
    assert.match(options.headers.get('Authorization'), /^Bearer [A-Za-z0-9_-]{43}$/);
    return response({
      open: true,
      ticket: { id: 'ticket-0008', name: 'RaceFan', category: 'website', latestStaffMessageId: '223456789012345680' },
    });
  };
  const browserToken = Buffer.alloc(32, 71).toString('base64url');
  badgeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1, token: browserToken, ticketId: 'ticket-0008', name: 'RaceFan', category: 'website',
    messages: [], lastSeenStaffMessageId: '', unread: false, draft: {},
  }));
  badgeWindow.eval(helpScript);
  await pause(10);
  const dots = [...badgeWindow.document.querySelectorAll('.help-notification-dot')];
  check('a staff reply found in ticket status lights the persistent Help unread dot',
    dots.length === 2 && dots.every(dot => dot.hidden === false));
  badgeWindow.close();

  const offlineDom = new JSDOM(pageHtml, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://freef1.netlify.app/help.html' });
  const offlineWindow = offlineDom.window;
  setHidden(offlineWindow, true);
  setRandom(offlineWindow);
  offlineWindow.Headers = Headers;
  offlineWindow.fetch = async () => { throw new TypeError('backend offline'); };
  offlineWindow.eval(helpScript);
  await pause(10);
  const offlineName = offlineWindow.document.getElementById('helpName');
  offlineName.value = 'Offline draft';
  offlineName.dispatchEvent(new offlineWindow.Event('input', { bubbles: true }));
  const offlineState = JSON.parse(offlineWindow.localStorage.getItem(STORAGE_KEY));
  check('backend outage leaves Help disabled but keeps the draft locally',
    offlineWindow.document.getElementById('helpSubmit').disabled &&
    offlineWindow.document.getElementById('helpStatus').dataset.state === 'offline' &&
    offlineState.draft.name === 'Offline draft');
  offlineWindow.close();

  console.log(`\n${checks}/${checks} checks passed`);
})().catch(error => {
  console.error('help-dom-check failed:', error.stack || error);
  process.exit(1);
});
