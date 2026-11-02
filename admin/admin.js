'use strict';

/* Dashboard deliberately has no analytics client, visitor feed, heartbeat,
   SSE connection, or recurring status/config polling. */
const $ = (id) => document.getElementById(id);
const app = $('app');
const authScreen = $('authScreen');
const loginForm = $('loginForm');
const toast = $('toast');
const API = '/admin/api';
let config = null;
let editingNewsId = null;
let sourceDraft = new Set();
/* id -> { current, online, shipped[] } from /admin/api/stream/links */
let linkReport = {};
let linkReportAt = 0;
let sourceFilter = 'all';
let sourceQuery = '';
let toastTimer = null;
let forceLiveSaving = false;
const adminNav = $('adminNav');
const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)') || { matches: false };
let navScrollFrame = 0;

function syncMotionPreference() {
  document.documentElement.classList.toggle('reduced-motion', motionPreference.matches);
}
syncMotionPreference();
if (motionPreference.addEventListener) motionPreference.addEventListener('change', syncMotionPreference);
else motionPreference.addListener?.(syncMotionPreference);

function updateAdminNav() {
  if (navScrollFrame) return;
  navScrollFrame = requestAnimationFrame(() => {
    navScrollFrame = 0;
    adminNav?.classList.toggle('stuck', window.scrollY > 8);
  });
}
window.addEventListener('scroll', updateAdminNav, { passive: true });
updateAdminNav();

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && path !== '/status') showLogin('Your session has ended. Please sign in again.');
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function showLogin(message = '') {
  app.classList.remove('open');
  authScreen.classList.remove('hidden');
  const error = $('authError');
  error.textContent = message;
  error.classList.toggle('visible', Boolean(message));
  if (message) $('password').value = '';
}

function showDashboard() {
  authScreen.classList.add('hidden');
  app.classList.add('open');
}

function showToast(message, kind = '') {
  toast.textContent = message;
  toast.className = `toast show${kind ? ` ${kind}` : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function setMessage(id, message, kind = '') {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
  element.className = `inline-message${kind ? ` ${kind}` : ''}`;
}

function safeDate(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '—';
  try { return new Date(time).toLocaleString(); } catch (_) { return '—'; }
}

function updateStorage(storage = config?.storage) {
  if (!storage) return;
  const chip = $('storageStatus');
  const detail = $('storageDetail');
  const state = $('serverStatus');
  const storeName = storage.store === 'upstash' ? 'Upstash Redis' : storage.store === 'local' ? 'Local file' : 'Memory only';
  const durable = Boolean(storage.durable);
  chip.className = `admin-chip ${durable ? 'ok' : 'warn'}`;
  chip.querySelector('span').textContent = durable ? 'Durable storage' : 'Temporary storage';
  detail.textContent = `${storeName}${storage.redisConfigured ? (durable ? ' · connected' : ' · configured but not confirmed') : ' · Upstash not configured'}`;
  state.className = 'admin-chip ok';
  state.querySelector('span').textContent = 'Control service connected';
  if (!durable) {
    $('storageCopy').textContent = storage.localWritable
      ? 'Settings are saved to this instance, but a redeploy may reset them. Configure Upstash Redis (recommended) or a Render persistent disk for durable admin state. Public visitors do not create storage traffic.'
      : 'Settings currently reside in memory and may be lost on restart. Configure Upstash Redis (recommended) or a Render persistent disk for durable admin state. Public visitors do not create storage traffic.';
  } else {
    $('storageCopy').textContent = 'Admin state is stored durably. Race Control serves configuration and admin actions only. The live page-connection count is handled separately by Cloudflare; this backend stores no visitor IDs or page history and runs no visitor analytics, background polling, or stream relay.';
  }
}

function acceptWrite(payload, successText) {
  if (payload?.durable) {
    if (config) config.storage = { ...(config.storage || {}), store: 'upstash', durable: true, redisConfigured: true };
    updateStorage(config?.storage);
    showToast(successText, 'success');
  } else {
    if (config) config.storage = {
      ...(config.storage || {}),
      store: payload?.store || (payload?.localSaved ? 'local' : 'memory'),
      durable: false
    };
    updateStorage(config?.storage);
    showToast(`${successText} Saved locally, but not confirmed in durable storage.`, 'error');
  }
}

function renderMaintenance() {
  if (!config) return;
  const maintenance = config.maintenance || {};
  const active = maintenance.active === true;
  $('maintenanceMessage').value = maintenance.message || "We'll be back before the race.";
  $('maintenanceEta').value = maintenance.eta || 'Before lights out';
  $('maintenanceStatus').className = `control-status ${active ? 'alert' : 'good'}`;
  $('maintenanceStateLabel').textContent = active ? 'Maintenance mode enabled' : 'Public site is available';
  $('maintenanceBadge').className = `panel-badge ${active ? 'live' : 'normal'}`;
  $('maintenanceBadge').textContent = active ? 'Maintenance active' : 'Public site live';
  $('toggleMaintenance').textContent = active ? 'Disable maintenance' : 'Enable maintenance';
  $('toggleMaintenance').classList.toggle('is-active', active);
  $('maintenanceBanner').classList.toggle('active', active);
}

function renderOverride() {
  if (!config) return;
  const override = config.streamOverride || {};
  const active = Boolean(override.active && override.url);
  $('overrideStatus').className = `control-status ${active ? 'alert' : 'good'}`;
  $('overrideStatus').querySelector('strong').textContent = active ? 'Race Control override is live' : 'Normal site feed';
  $('overrideSub').textContent = active ? `${override.type || 'embed'} · started ${safeDate(override.startedAt)}` : 'No Race Control override is active.';
  $('streamBadge').className = `panel-badge ${active ? 'live' : 'normal'}`;
  $('streamBadge').textContent = active ? 'Override live' : 'Normal feed';
  $('streamUrl').value = override.input || '';
  $('stopOverride').disabled = !active;
  $('normalOverride').disabled = !active && !override.input;
}

function renderForceLive() {
  const force = config?.streamWindow || {};
  const active = force.active === true;
  $('forceLiveStatus').className = `control-status ${active ? 'alert' : 'good'}`;
  $('forceLiveStateLabel').textContent = active ? 'Force Live is active' : 'Schedule window active';
  $('forceLiveStateText').textContent = active
    ? `Schedule checks are bypassed${force.reason ? ` · ${force.reason}` : ''}${force.startedAt ? ` · started ${safeDate(force.startedAt)}` : ''}.`
    : 'Streams follow their scheduled availability windows.';
  $('forceLiveBadge').className = `panel-badge ${active ? 'live' : 'normal'}`;
  $('forceLiveBadge').textContent = active ? 'Forced live' : 'Schedule window';
  $('forceLiveReason').value = active ? (force.reason || '') : $('forceLiveReason').value;
  $('enableForceLive').disabled = active || forceLiveSaving;
  $('disableForceLive').disabled = !active || forceLiveSaving;
}

/* What is typed in the custom fields, before it is saved. Seeded from the saved state each render. */
let customDraft = {};

/* ── whole-group actions ────────────────────────────────────────────────
   One request per group: 'disable all EMB' used to mean toggling nine switches by
   hand, and any of them failing left the group half-off. */
const BULK_GROUPS = [
  { key: 'emb', label: 'EMB' },
  { key: 'weelo', label: 'weelo' },
  { key: 'taifood', label: 'taifood' },
  { key: 'strmfree', label: 'strmfree' },
  { key: 'other', label: 'Other tab' },
  { key: 'special', label: 'Onboards' },
  { key: 'all', label: 'Everything' }
];

function renderBulkGroups() {
  const host = $('bulkGroups');
  if (!host) return;
  host.replaceChildren();
  for (const group of BULK_GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = 'bulk-group';
    const name = document.createElement('span');
    name.className = 'bulk-name';
    name.textContent = group.label;
    const off = document.createElement('button');
    off.type = 'button';
    off.className = 'btn xs danger';
    off.textContent = 'Disable';
    off.addEventListener('click', () => bulkSources(group, 'disable', off));
    const on = document.createElement('button');
    on.type = 'button';
    on.className = 'btn xs';
    on.textContent = 'Enable';
    on.addEventListener('click', () => bulkSources(group, 'enable', on));
    wrap.append(name, off, on);
    host.append(wrap);
  }
}

async function bulkSources(group, action, button) {
  const message = $('sourceMessage');
  const verb = action === 'disable' ? 'Disabling' : 'Enabling';
  button.disabled = true;
  if (message) message.textContent = `${verb} every ${group.label} source…`;
  try {
    const result = await api('/stream/sources/bulk', { method: 'POST', body: { action, group: group.key } });
    config.sources = { disabled: result.disabled || [], updatedAt: result.updatedAt || Date.now() };
    sourceDraft = new Set((result.disabled || []).map(String));
    renderSourcesFromDraft();
    const total = result.touched ?? 0;
    if (message) message.textContent = `${action === 'disable' ? 'Hidden' : 'Shown'} ${total} source${total === 1 ? '' : 's'} under ${group.label}. Live now.`;
  } catch (error) {
    if (message) message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/* ── live links ──────────────────────────────────────────────────────── */
async function loadLinks({ quiet = false } = {}) {
  const message = $('sourceMessage');
  if (!quiet && message) message.textContent = 'Reading the current links…';
  try {
    const result = await api('/stream/links');
    linkReport = {};
    for (const row of result.streams || []) linkReport[row.id] = row;
    linkReportAt = result.checkedAt || Date.now();
    if (message) {
      const live = Object.values(linkReport).filter((row) => row.online).length;
      message.textContent = live
        ? `${live} of ${Object.keys(linkReport).length} sources have an address right now.`
        : 'No source has an address right now.';
    }
    renderSources();
  } catch (error) {
    if (message) message.textContent = error.message;
  }
}

const whenLabel = (at) => {
  if (!at) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  return secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
};

function renderSources() {
  const list = $('sourceList');
  list.replaceChildren();
  const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
  sourceDraft = new Set((config?.sources?.disabled || []).map(String));
  customDraft = {};
  const visible = sources.filter((source) => {
    if (sourceQuery) {
      const needle = sourceQuery.toLowerCase();
      if (!`${source.label} ${source.id} ${source.provider || ''}`.toLowerCase().includes(needle)) return false;
    }
    if (sourceFilter === 'off') return sourceDraft.has(source.id);
    if (sourceFilter === 'on') return !sourceDraft.has(source.id);
    if (sourceFilter === 'live') return Boolean(linkReport[source.id]?.online);
    if (sourceFilter === 'all') return true;
    return sourceFilter === 'emb' ? source.provider === 'embdlol'
      : sourceFilter === 'weelo' ? source.provider === 'weelo'
      : sourceFilter === 'taifood' ? source.provider === 'taifood'
      : sourceFilter === 'other' ? source.tab === 'other'
      : Boolean(source.special);
  });
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'section-note';
    empty.textContent = 'No source matches this filter.';
    list.append(empty);
    return;
  }
  for (const source of visible) {
    const enabled = !sourceDraft.has(source.id);
    const row = document.createElement('div');
    row.className = `source-row${enabled ? '' : ' is-off'}`;
    const name = document.createElement('span');
    name.className = 'source-name';
    /* The tab is shown next to the label so Race Control reads the row the way a visitor does. */
    name.textContent = source.label;
    if (source.tab === 'other' || source.special) {
      const tag = document.createElement('em');
      tag.className = 'source-tag';
      tag.textContent = source.special ? source.special : 'other';
      name.append(' ', tag);
    }
    const id = document.createElement('span');
    id.className = 'source-id';
    id.textContent = source.id;
    const status = document.createElement('span');
    status.className = 'source-state';
    /* A weelo chip carries the provider's own state when it is known. */
    status.textContent = enabled ? (source.state ? String(source.state) : 'Available') : 'Hidden';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `source-switch${enabled ? ' on' : ''}`;
    button.setAttribute('aria-label', `${enabled ? 'Hide' : 'Show'} ${source.label}`);
    button.setAttribute('aria-pressed', String(enabled));
    button.innerHTML = '<i aria-hidden="true"></i>';
    button.addEventListener('click', () => {
      if (sourceDraft.has(source.id)) sourceDraft.delete(source.id);
      else sourceDraft.add(source.id);
      renderSourcesFromDraft();
    });
    /* The custom fields: what the chip says, and the address it opens. Both start as the shipped
       value so Race Control can see at a glance what is live and what has been changed. */
    const custom = document.createElement('div');
    custom.className = 'source-custom';
    row.dataset.sourceId = source.id;
    row.dataset.provider = source.provider || '';
    row.dataset.tab = source.tab || '';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.value = source.customLabel || '';
    nameInput.placeholder = `Name: ${source.baseLabel || source.label}`;
    nameInput.setAttribute('aria-label', `Custom name for ${source.label}`);
    nameInput.className = source.customLabel ? 'is-set' : '';
    const linkInput = document.createElement('input');
    linkInput.type = 'url';
    linkInput.value = source.customUrl || '';
    linkInput.placeholder = 'Link: shipped default';
    linkInput.setAttribute('aria-label', `Custom link for ${source.label}`);
    linkInput.className = source.customUrl ? 'is-set' : '';
    customDraft[source.id] = { label: source.customLabel || '', url: source.customUrl || '' };
    nameInput.addEventListener('input', () => { customDraft[source.id].label = nameInput.value; });
    linkInput.addEventListener('input', () => { customDraft[source.id].url = linkInput.value; });
    custom.append(nameInput, linkInput);

    /* What this chip would open right now, and where that address came from. */
    const live = linkReport[source.id];
    const address = document.createElement('div');
    address.className = 'source-address';
    if (!live) {
      address.innerHTML = '<span class="addr-empty">Address not read yet — press “Refresh live links”.</span>';
    } else if (live.online && live.current) {
      const link = document.createElement('a');
      link.href = live.current.startsWith('http') ? live.current : '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'addr-url';
      link.textContent = live.current;
      link.title = live.current;
      const from = document.createElement('em');
      from.className = 'addr-from';
      from.textContent = live.customUrl ? 'custom' : (live.shipped[0]?.from || 'shipped');
      address.append(link, from);
    } else {
      address.innerHTML = '<span class="addr-empty">No address right now</span>';
    }
    if (live?.shipped?.length > 1) {
      const more = document.createElement('span');
      more.className = 'addr-more';
      more.textContent = `+${live.shipped.length - 1} fallback${live.shipped.length > 2 ? 's' : ''}`;
      more.title = live.shipped.slice(1).map((e) => e.url).join('\n');
      address.append(more);
    }

    row.append(name, id, status, button, custom, address);
    list.append(row);
  }
}

function renderSourcesFromDraft() {
  const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
  const list = $('sourceList');
  [...list.children].forEach((row) => {
    /* Read the id off the row: the list is filtered, so its position no longer indexes sourceList. */
    const source = sources.find((entry) => entry.id === row.dataset.sourceId);
    if (!source) return;
    const enabled = !sourceDraft.has(source.id);
    row.classList.toggle('is-off', !enabled);
    row.querySelector('.source-state').textContent = enabled ? (source.state ? String(source.state) : 'Available') : 'Hidden';
    const button = row.querySelector('.source-switch');
    button.classList.toggle('on', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', `${enabled ? 'Hide' : 'Show'} ${source.label}`);
  });
}

function renderNews() {
  const container = $('newsList');
  container.replaceChildren();
  const items = Array.isArray(config?.adminNews) ? config.adminNews : [];
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'storage-copy';
    empty.textContent = 'No public news items yet.';
    container.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'news-card';
    const head = document.createElement('div');
    head.className = 'news-card-head';
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'news-card-meta';
    meta.textContent = `${item.tag || 'Race Control'} · ${item.published ? 'Published' : 'Draft'} · ${safeDate(item.updatedAt)}`;
    content.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'news-card-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => beginNewsEdit(item));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-news';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteNewsItem(item));
    actions.append(edit, remove);
    head.append(content, actions);
    const body = document.createElement('p');
    body.textContent = item.body;
    card.append(head, body);
    container.append(card);
  }
}

/* The link report is a separate, slow-ish call (it consults three providers), so it is loaded after
   the dashboard is already on screen and never blocks the rest of the panel. */
function primeLinks() {
  if (!Object.keys(linkReport).length) void loadLinks({ quiet: true });
}

function renderConfig() {
  renderMaintenance();
  renderOverride();
  renderForceLive();
  renderBulkGroups();
  renderFilterChips();
  renderSources();
  renderNews();
  updateStorage();
  primeLinks();
  $('configTime').textContent = `Loaded once · ${new Date().toLocaleString()}`;
}

async function loadConfig({ silent = false } = {}) {
  const payload = await api('/config');
  config = {
    maintenance: payload.maintenance || {},
    news: payload.news || [],
    sources: payload.sources || { disabled: [] },
    streamOverride: payload.streamOverride || {},
    streamWindow: payload.streamWindow || { active: false, reason: '', startedAt: null, updatedAt: null },
    experimental: payload.experimental || {},
    sourceList: payload.sourceList || [],
    adminNews: payload.adminNews || [],
    storage: payload.storage || {}
  };
  renderConfig();
  if (silent) return;
  return payload;
}

function resetNewsForm() {
  editingNewsId = null;
  $('newsForm').reset();
  $('newsTag').value = 'Race Control';
  $('newsPublished').checked = true;
  $('saveNews').textContent = 'Publish update';
  $('cancelNewsEdit').hidden = true;
}

function beginNewsEdit(item) {
  editingNewsId = item.id;
  $('newsHeadline').value = item.title || '';
  $('newsTag').value = item.tag || 'Race Control';
  $('newsBody').value = item.body || '';
  $('newsPublished').checked = item.published !== false;
  $('saveNews').textContent = 'Save changes';
  $('cancelNewsEdit').hidden = false;
  $('newsHeadline').focus();
}

async function deleteNewsItem(item) {
  if (!window.confirm(`Delete “${item.title}”?`)) return;
  try {
    const result = await api(`/news/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    config.adminNews = config.adminNews.filter(entry => entry.id !== item.id);
    renderNews();
    acceptWrite(result, 'News item deleted.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function initialize() {
  try {
    const status = await api('/status');
    if (!status.authenticated) {
      showLogin();
      return;
    }
    showDashboard();
    await loadConfig();
  } catch (error) {
    showLogin(error.message === 'Failed to fetch' ? 'Race Control is temporarily unavailable.' : error.message);
    $('serverStatus').className = 'admin-chip bad';
    $('serverStatus').querySelector('span').textContent = 'Control service offline';
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('loginBtn');
  const error = $('authError');
  error.textContent = '';
  error.classList.remove('visible');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    await api('/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
    $('password').value = '';
    showDashboard();
    try {
      await loadConfig();
    } catch (loadError) {
      showToast(`Signed in, but settings could not load: ${loadError.message}`, 'error');
    }
  } catch (exception) {
    error.textContent = exception.message;
    error.classList.add('visible');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign In';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST', body: {} }); } catch (_) {}
  config = null;
  showLogin('Signed out.');
});

$('saveMaintenance').addEventListener('click', async () => {
  if (!config) return;
  const button = $('saveMaintenance');
  button.disabled = true;
  try {
    const result = await api('/maintenance', {
      method: 'POST',
      body: {
        active: config.maintenance.active === true,
        message: $('maintenanceMessage').value,
        eta: $('maintenanceEta').value
      }
    });
    config.maintenance = result.maintenance;
    renderMaintenance();
    setMessage('maintenanceNote', 'Maintenance text saved.', 'success');
    acceptWrite(result, 'Maintenance text saved.');
  } catch (error) {
    setMessage('maintenanceNote', error.message, 'error');
  } finally { button.disabled = false; }
});

$('toggleMaintenance').addEventListener('click', async () => {
  if (!config) return;
  const button = $('toggleMaintenance');
  button.disabled = true;
  try {
    const result = await api('/maintenance', {
      method: 'POST',
      body: {
        active: config.maintenance.active !== true,
        message: $('maintenanceMessage').value,
        eta: $('maintenanceEta').value
      }
    });
    config.maintenance = result.maintenance;
    renderMaintenance();
    setMessage('maintenanceNote', result.maintenance.active
      ? 'Maintenance enabled. Connected public tabs are moving to the pit lane now.'
      : 'Maintenance disabled. Connected maintenance pages are returning to FreeF1.', 'success');
    acceptWrite(result, result.maintenance.active ? 'Maintenance enabled.' : 'Maintenance disabled.');
  } catch (error) {
    setMessage('maintenanceNote', error.message, 'error');
  } finally { button.disabled = false; }
});

$('playOverride').addEventListener('click', async () => {
  const button = $('playOverride');
  button.disabled = true;
  setMessage('overrideMessage', 'Applying override…');
  try {
    const result = await api('/stream/override', { method: 'POST', body: { url: $('streamUrl').value.trim() } });
    config.streamOverride = result.override;
    renderOverride();
    setMessage('overrideMessage', 'Override enabled on connected public tabs.', 'success');
    acceptWrite(result, 'Stream override enabled.');
  } catch (error) {
    setMessage('overrideMessage', error.message, 'error');
  } finally { button.disabled = false; }
});

$('stopOverride').addEventListener('click', async () => {
  try {
    const result = await api('/stream/stop', { method: 'POST', body: {} });
    config.streamOverride = result.override;
    renderOverride();
    setMessage('overrideMessage', 'Override stopped; saved URL retained.', 'success');
    acceptWrite(result, 'Override stopped.');
  } catch (error) { setMessage('overrideMessage', error.message, 'error'); }
});

$('normalOverride').addEventListener('click', async () => {
  try {
    const result = await api('/stream/normal', { method: 'POST', body: {} });
    config.streamOverride = result.override;
    renderOverride();
    setMessage('overrideMessage', 'Normal feed restored; saved URL cleared.', 'success');
    acceptWrite(result, 'Normal stream restored.');
  } catch (error) { setMessage('overrideMessage', error.message, 'error'); }
});

async function setForceLive(active) {
  if (!config || forceLiveSaving) return;
  forceLiveSaving = true;
  renderForceLive();
  try {
    const result = await api('/stream/window', {
      method: 'POST',
      body: { active, reason: active ? $('forceLiveReason').value.trim() : '' }
    });
    config.streamWindow = result.streamWindow || { active, reason: active ? $('forceLiveReason').value.trim() : '', startedAt: active ? Date.now() : null };
    renderForceLive();
    setMessage('forceLiveMessage', active
      ? 'Force Live enabled. Connected public tabs update immediately.'
      : 'Force Live disabled. Connected public tabs restore the schedule immediately.', 'success');
    acceptWrite(result, active ? 'Force Live enabled.' : 'Force Live disabled.');
  } catch (error) {
    setMessage('forceLiveMessage', error.message, 'error');
  } finally {
    forceLiveSaving = false;
    renderForceLive();
  }
}

$('enableForceLive').addEventListener('click', () => setForceLive(true));
$('disableForceLive').addEventListener('click', () => setForceLive(false));

/* ── filters ─────────────────────────────────────────────────────────── */
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Has an address' },
  { key: 'on', label: 'Shown' },
  { key: 'off', label: 'Hidden' },
  { key: 'emb', label: 'EMB' },
  { key: 'weelo', label: 'weelo' },
  { key: 'taifood', label: 'taifood' },
  { key: 'other', label: 'Other tab' },
  { key: 'special', label: 'Onboards' }
];

function renderFilterChips() {
  const host = $('filterChips');
  if (!host) return;
  host.replaceChildren();
  for (const filter of FILTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-chip${sourceFilter === filter.key ? ' active' : ''}`;
    button.textContent = filter.label;
    button.setAttribute('aria-pressed', String(sourceFilter === filter.key));
    button.addEventListener('click', () => {
      sourceFilter = filter.key;
      renderFilterChips();
      renderSources();
    });
    host.append(button);
  }
}

$('sourceSearch')?.addEventListener('input', (event) => {
  sourceQuery = event.target.value.trim();
  renderSources();
});
$('refreshLinks')?.addEventListener('click', () => loadLinks());

$('saveSources').addEventListener('click', async () => {
  const button = $('saveSources');
  button.disabled = true;
  try {
    const result = await api('/stream/sources', { method: 'POST', body: { disabled: [...sourceDraft] } });
    config.sources = { disabled: result.disabled || [...sourceDraft], updatedAt: result.updatedAt || Date.now() };
    /* Names and links are saved per chip, so one bad address only rejects its own row. */
    const failures = [];
    for (const source of (config.sourceList || [])) {
      const draft = customDraft[source.id];
      if (!draft) continue;
      const label = draft.label.trim();
      const url = draft.url.trim();
      if (label === (source.customLabel || '') && url === (source.customUrl || '')) continue;
      try {
        await api('/stream/chip', { method: 'POST', body: { id: source.id, label, url } });
      } catch (error) {
        failures.push(`${source.label}: ${error.message}`);
      }
    }
    await loadConfig({ silent: true });
    setMessage('sourceMessage', failures.length
      ? `Saved, but ${failures.join(' · ')}`
      : 'Source settings saved. Names and links are live.', failures.length ? 'error' : 'success');
    acceptWrite(result, 'Source settings saved.');
  } catch (error) { setMessage('sourceMessage', error.message, 'error'); }
  finally { button.disabled = false; }
});

$('resetAll').addEventListener('click', async () => {
  if (!confirm('Reset everything to the shipped defaults? This clears source visibility, custom names and links, the forced stream, maintenance mode and all news.')) return;
  const button = $('resetAll');
  button.disabled = true;
  try {
    const result = await api('/reset-all', { method: 'POST', body: {} });
    await loadConfig({ silent: true });
    setMessage('sourceMessage', 'Everything is back to the shipped defaults.', 'success');
    acceptWrite(result, 'All settings reset.');
  } catch (error) {
    setMessage('sourceMessage', error.message, 'error');
  } finally { button.disabled = false; }
});

$('newsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('saveNews');
  button.disabled = true;
  const wasEditing = Boolean(editingNewsId);
  const body = {
    title: $('newsHeadline').value.trim(),
    tag: $('newsTag').value.trim() || 'Race Control',
    body: $('newsBody').value.trim(),
    published: $('newsPublished').checked
  };
  try {
    const result = wasEditing
      ? await api(`/news/${encodeURIComponent(editingNewsId)}`, { method: 'PATCH', body })
      : await api('/news', { method: 'POST', body });
    const item = result.news;
    const index = config.adminNews.findIndex(entry => entry.id === item.id);
    if (index >= 0) config.adminNews[index] = item;
    else config.adminNews.unshift(item);
    config.adminNews.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    renderNews();
    resetNewsForm();
    setMessage('newsMessage', wasEditing ? 'News item updated.' : 'News item saved.', 'success');
    acceptWrite(result, wasEditing ? 'News item updated.' : 'News item published.');
  } catch (error) { setMessage('newsMessage', error.message, 'error'); }
  finally { button.disabled = false; }
});

$('cancelNewsEdit').addEventListener('click', resetNewsForm);

initialize();
