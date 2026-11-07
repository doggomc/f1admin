const $ = (id) => document.getElementById(id);

const DEFAULT_PAGE_LIST = [
  { id: 'cockpit', label: 'Cockpit', path: '/cockpit.html', description: 'Live stream player, sources & multiviewer' },
  { id: 'schedule', label: 'Schedule', path: '/schedule.html', description: 'Season calendar & weekend session times' },
  { id: 'standings', label: 'Standings', path: '/standings.html', description: 'Drivers & Constructors championships' },
  { id: 'live-timing', label: 'Live timing', path: '/live-timing.html', description: 'Timing tower, sectors, race control & radio' },
  { id: 'drivers', label: 'Drivers', path: '/drivers.html', description: 'Driver grid & individual driver profiles' },
  { id: 'teams', label: 'Teams', path: '/teams.html', description: 'Constructor grid & team profiles' },
  { id: 'help', label: 'Help', path: '/help.html', description: 'Support desk & help tickets' }
];

const PAGE_ICONS = {
  cockpit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  standings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  'live-timing': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M10 2h4"/></svg>',
  drivers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};

let config = null;
let editingNewsId = null;
let sourceDraft = new Set();
let customDraft = {};
let linkReport = {};
let linkCheckedAt = 0;
let sourceFilter = 'all';
let sourceQuery = '';
let pageSaving = false;
let toastTimer = null;

function showToast(message, tone = 'ok') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast show${tone === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setStatusLine(id, message, tone = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.className = `status-line${tone ? ` ${tone}` : ''}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/admin/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {}
  if (response.status === 401 && path !== '/login' && path !== '/status') {
    showAuth('Session expired. Sign in again.');
    throw new Error(payload.error || 'Session expired.');
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function showAuth(message = '') {
  $('dashboard').hidden = true;
  $('authScreen').hidden = false;
  setStatusLine('loginError', message, message ? 'error' : '');
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion) window.scrollTo(0, 0);
  ($('usernameInput').value ? $('passwordInput') : $('usernameInput')).focus();
}

function showDashboard() {
  $('authScreen').hidden = true;
  $('dashboard').hidden = false;
  setStatusLine('loginError', '');
}

function safeDate(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return 'Not set';
  return new Date(time).toLocaleString();
}

function setPill(el, label, tone = '') {
  if (!el) return;
  el.textContent = label;
  el.className = `pill${tone ? ` ${tone}` : ''}`;
}

function updateKpiStrip() {
  const maintenanceActive = config?.maintenance?.active === true;
  const pageList = Array.isArray(config?.pageList) && config.pageList.length ? config.pageList : DEFAULT_PAGE_LIST;
  const disabledPages = Array.isArray(config?.pages?.disabled) ? config.pages.disabled : [];
  const overrideActive = Boolean(config?.streamOverride?.active && config?.streamOverride?.url);
  const windowActive = config?.streamWindow?.active === true;

  $('kpiSiteDot').className = `dot${maintenanceActive ? ' amber' : ''}`;
  $('kpiSiteVal').textContent = maintenanceActive ? 'Maintenance' : 'Online';
  $('kpiSiteMeta').textContent = maintenanceActive
    ? (config.maintenance.eta || 'Full-site gate active')
    : 'Normal visitor access';

  $('kpiPagesDot').className = `dot${disabledPages.length ? ' amber' : ''}`;
  $('kpiPagesVal').textContent = disabledPages.length
    ? `${disabledPages.length} in outage`
    : `All ${pageList.length} online`;
  $('kpiPagesMeta').textContent = disabledPages.length
    ? `Paused: ${disabledPages.join(', ')}`
    : 'No partial outages active';

  $('kpiStreamDot').className = `dot${overrideActive ? ' red' : ' muted'}`;
  $('kpiStreamVal').textContent = overrideActive ? 'Override live' : 'Normal sources';
  $('kpiStreamMeta').textContent = overrideActive
    ? String(config.streamOverride.url || 'Forced stream active')
    : 'Viewer source picker active';

  $('kpiWindowDot').className = `dot${windowActive ? '' : ' muted'}`;
  $('kpiWindowVal').textContent = windowActive ? 'Forced live' : 'Auto schedule';
  $('kpiWindowMeta').textContent = windowActive
    ? (config.streamWindow.reason || 'Manual live window open')
    : 'Follows F1 session calendar';

  const serverDot = $('serverStatusDot');
  const serverText = $('serverStatusText');
  const serverPill = $('serverStatus');
  if (maintenanceActive) {
    serverDot.className = 'dot amber';
    serverText.textContent = 'Maintenance on';
    serverPill.className = 'pill is-warn';
  } else if (disabledPages.length) {
    serverDot.className = 'dot amber';
    serverText.textContent = `Partial outage (${disabledPages.length})`;
    serverPill.className = 'pill is-warn';
  } else {
    serverDot.className = 'dot';
    serverText.textContent = 'Control ready';
    serverPill.className = 'pill is-ok';
  }
}

function updateStorage(storage = config?.storage) {
  const pill = $('storageStatus');
  const detail = $('storageDetail');
  if (!storage) {
    setPill(pill, 'Storage unknown');
    detail.textContent = 'Storage status has not been reported yet.';
    return;
  }
  if (storage.durable) {
    setPill(pill, 'Upstash durable', 'is-ok');
    detail.textContent = 'Control changes persist in Upstash Redis and push immediately to open FreeF1 tabs.';
  } else if (storage.store === 'local') {
    setPill(pill, 'Local file store', 'is-warn');
    detail.textContent = storage.redisConfigured
      ? 'Upstash was unreachable on the last write; saved to local fallback storage.'
      : 'Saved to local disk storage (set UPSTASH_REDIS_REST_URL and TOKEN for cloud durability).';
  } else {
    setPill(pill, 'Memory only', 'is-alert');
    detail.textContent = 'Running in memory without durable disk or Upstash persistence.';
  }
}

function acceptWrite(result, okMessage, statusId = '') {
  if (config) {
    config.storage = {
      ...(config.storage || {}),
      durable: Boolean(result.durable),
      store: result.store || config.storage?.store || 'memory'
    };
    updateStorage(config.storage);
  }
  const message = result.durable || !config?.storage?.redisConfigured
    ? okMessage
    : `${okMessage} Upstash did not confirm; saved locally.`;
  const tone = result.durable || !config?.storage?.redisConfigured ? 'ok' : 'error';
  if (statusId) setStatusLine(statusId, message, tone);
  showToast(message, tone);
}

/* ── Page Control (Partial Outage per Category) ── */
function renderPages() {
  const listEl = $('pageControlList');
  if (!listEl) return;
  listEl.replaceChildren();

  const pageList = Array.isArray(config?.pageList) && config.pageList.length ? config.pageList : DEFAULT_PAGE_LIST;
  const disabledSet = new Set((config?.pages?.disabled || []).map((id) => String(id).toLowerCase()));
  const count = disabledSet.size;

  const badge = $('pageControlBadge');
  const banner = $('pageControlStatus');
  if (count > 0) {
    setPill(badge, `Partial outage · ${count} off`, 'is-warn');
    banner.className = 'state-banner is-active';
    const labels = pageList.filter((p) => disabledSet.has(p.id)).map((p) => p.label);
    $('pageControlStateLabel').textContent = `Partial outage on ${labels.join(', ')}`;
    $('pageControlStateText').textContent = 'Visitors opening paused categories see "Partial Outage" with Home and Discord actions.';
  } else {
    setPill(badge, 'All online', 'is-ok');
    banner.className = 'state-banner';
    $('pageControlStateLabel').textContent = 'All categories online';
    $('pageControlStateText').textContent = 'Every public section is serving normally. Home always remains reachable.';
  }

  $('enableAllPages').disabled = count === 0 || pageSaving;

  for (const page of pageList) {
    const enabled = !disabledSet.has(page.id);
    const row = document.createElement('div');
    row.className = `page-row${enabled ? '' : ' is-disabled'}`;
    row.dataset.pageId = page.id;

    const icon = document.createElement('span');
    icon.className = 'page-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = PAGE_ICONS[page.id] || PAGE_ICONS.cockpit;

    const meta = document.createElement('div');
    meta.className = 'page-meta';
    const name = document.createElement('div');
    name.className = 'page-name';
    name.textContent = page.label;
    const pathSpan = document.createElement('span');
    pathSpan.className = 'page-path';
    pathSpan.textContent = page.path || `/${page.id}.html`;
    name.append(pathSpan);

    const desc = document.createElement('span');
    desc.className = 'page-desc';
    desc.textContent = page.description || '';
    meta.append(name, desc);

    const stateTag = document.createElement('span');
    stateTag.className = 'page-badge';
    stateTag.textContent = enabled ? 'Online' : 'Partial outage';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `page-switch${enabled ? ' on' : ''}`;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} ${page.label}`);
    toggle.disabled = pageSaving;
    toggle.innerHTML = '<i aria-hidden="true"></i>';
    toggle.addEventListener('click', () => {
      const next = new Set((config?.pages?.disabled || []).map((id) => String(id).toLowerCase()));
      if (next.has(page.id)) next.delete(page.id);
      else next.add(page.id);
      void savePageControl([...next], enabled ? `${page.label} switched to Partial Outage.` : `${page.label} restored online.`);
    });

    row.append(icon, meta, stateTag, toggle);
    listEl.append(row);
  }
}

async function savePageControl(disabledIds, messageText) {
  if (pageSaving) return;
  pageSaving = true;
  const previous = [...(config?.pages?.disabled || [])];
  if (config) config.pages = { ...(config.pages || {}), disabled: disabledIds };
  renderPages();
  updateKpiStrip();
  try {
    const result = await api('/pages', {
      method: 'POST',
      body: JSON.stringify({ disabled: disabledIds })
    });
    config.pages = result.pages || { disabled: disabledIds, updatedAt: Date.now() };
    if (Array.isArray(result.pageList)) config.pageList = result.pageList;
    pageSaving = false;
    renderPages();
    updateKpiStrip();
    acceptWrite(result, messageText, 'pageControlMessage');
  } catch (error) {
    pageSaving = false;
    if (config) config.pages = { ...(config.pages || {}), disabled: previous };
    renderPages();
    updateKpiStrip();
    setStatusLine('pageControlMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
}

/* ── Maintenance ── */
function renderMaintenance() {
  const m = config?.maintenance || {};
  const active = m.active === true;
  $('maintenanceStatus').className = `state-banner${active ? ' is-active' : ''}`;
  setPill($('maintenanceBadge'), active ? 'Maintenance on' : 'Live', active ? 'is-warn' : 'is-ok');
  $('maintenanceStateLabel').textContent = active ? 'Maintenance mode is active' : 'Public site is live';
  $('maintenanceStateText').textContent = active
    ? `Started ${safeDate(m.startedAt)} · ETA: ${m.eta || 'Before lights out'}`
    : 'Visitors can browse and watch normally.';
  $('maintenanceMessage').value = m.message || "We'll be back before the race.";
  $('maintenanceEta').value = m.eta || 'Before lights out';
  $('toggleMaintenance').textContent = active ? 'Disable maintenance' : 'Enable maintenance';
  $('toggleMaintenance').className = active ? 'btn btn-primary' : 'btn btn-warn';
}

/* ── Stream Override ── */
function renderOverride() {
  const override = config?.streamOverride || {};
  const active = Boolean(override.active && override.url);
  $('overrideStatus').className = `state-banner${active ? ' is-live-override' : ''}`;
  setPill($('overrideBadge'), active ? 'Override live' : 'Inactive', active ? 'is-alert' : '');
  $('overrideStateLabel').textContent = active ? `Override active (${override.type || 'stream'})` : 'Normal feed list';
  $('overrideStateUrl').textContent = active ? override.url : 'Viewers choose from the enabled Cockpit sources.';
  $('stopOverride').disabled = !active;
}

/* ── Force Live Window ── */
function renderForceLive() {
  const win = config?.streamWindow || {};
  const active = win.active === true;
  $('forceLiveStatus').className = `state-banner${active ? ' is-active' : ''}`;
  setPill($('forceLiveBadge'), active ? 'Forced live' : 'Schedule', active ? 'is-ok' : '');
  $('forceLiveStateLabel').textContent = active ? 'Force Live is active' : 'Following session schedule';
  $('forceLiveStateDetail').textContent = active
    ? `${win.reason ? `${win.reason} · ` : ''}Opened ${safeDate(win.startedAt)}`
    : 'Streams unlock automatically during official race weekend windows.';
  $('forceLiveReason').value = win.reason || '';
  $('disableForceLive').disabled = !active;
}

/* ── Stream Sources ── */
const FILTER_GROUPS = [
  ['all', 'All', () => true],
  ['on', 'Visible', (s) => !sourceDraft.has(s.id)],
  ['off', 'Hidden', (s) => sourceDraft.has(s.id)],
  ['live', 'Has link', (s) => Boolean(linkReport[s.id]?.online)],
  ['emb', 'EMB', (s) => s.provider === 'embdlol'],
  ['weelo', 'Weelo', (s) => s.provider === 'weelo'],
  ['ppv', 'PPV', (s) => s.provider === 'ppv' || s.provider === 'taifood'],
  ['other', 'Other langs', (s) => s.tab === 'other'],
  ['special', 'Special', (s) => Boolean(s.special)]
];

const BULK_GROUPS = [
  ['emb', 'EMB'],
  ['weelo', 'Weelo'],
  ['ppv', 'PPV'],
  ['strmfree', 'StreamFree'],
  ['other', 'Other langs'],
  ['all', 'Every source']
];

function renderFilterChips() {
  const bar = $('sourceFilters');
  if (!bar) return;
  bar.replaceChildren();
  const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
  for (const [key, label, match] of FILTER_GROUPS) {
    const count = sources.filter(match).length;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip${sourceFilter === key ? ' is-active' : ''}`;
    chip.innerHTML = `${label} <em>${count}</em>`;
    chip.addEventListener('click', () => {
      sourceFilter = key;
      renderFilterChips();
      renderSources();
    });
    bar.append(chip);
  }
}

function renderBulkGroups() {
  const bar = $('sourceBulk');
  if (!bar) return;
  bar.replaceChildren();
  for (const [group, label] of BULK_GROUPS) {
    const wrap = document.createElement('span');
    wrap.className = 'bulk-group';
    const title = document.createElement('span');
    title.textContent = label;
    const on = document.createElement('button');
    on.type = 'button';
    on.textContent = 'On';
    on.title = `Enable all ${label} sources immediately`;
    on.addEventListener('click', () => bulkGroup(group, 'enable', label));
    const off = document.createElement('button');
    off.type = 'button';
    off.textContent = 'Off';
    off.title = `Disable all ${label} sources immediately`;
    off.addEventListener('click', () => bulkGroup(group, 'disable', label));
    wrap.append(title, on, off);
    bar.append(wrap);
  }
}

async function bulkGroup(group, action, label) {
  try {
    const result = await api('/stream/sources/bulk', {
      method: 'POST',
      body: JSON.stringify({ group, action })
    });
    config.sources.disabled = result.disabled || [];
    sourceDraft = new Set(config.sources.disabled.map(String));
    renderFilterChips();
    renderSources();
    acceptWrite(result, `${label}: ${action === 'enable' ? 'enabled' : 'hidden'} (${result.touched}).`, 'sourcesMessage');
  } catch (error) {
    setStatusLine('sourcesMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
}

const whenLabel = (at) => {
  if (!at) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  return secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
};

async function loadLinks({ quiet = false } = {}) {
  if (!quiet) setStatusLine('sourcesMessage', 'Checking live provider links…');
  try {
    const report = await api('/stream/links');
    linkReport = {};
    for (const row of report.streams || []) linkReport[row.id] = row;
    linkCheckedAt = Number(report.checkedAt) || Date.now();
    renderFilterChips();
    if (!quiet) {
      const live = Object.values(linkReport).filter((r) => r.online).length;
      setStatusLine(
        'sourcesMessage',
        live ? `${live} source${live === 1 ? '' : 's'} resolved a live link (${whenLabel(linkCheckedAt)}).` : 'No source reported a live address right now.',
        live ? 'ok' : ''
      );
    }
    renderSources();
  } catch (error) {
    if (!quiet) setStatusLine('sourcesMessage', error.message, 'error');
  }
}

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
      : sourceFilter === 'ppv' || sourceFilter === 'taifood' ? (source.provider === 'ppv' || source.provider === 'taifood')
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
    row.dataset.sourceId = source.id;
    row.dataset.provider = source.provider || '';
    row.dataset.tab = source.tab || '';

    const name = document.createElement('span');
    name.className = 'source-name';
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

    const custom = document.createElement('div');
    custom.className = 'source-custom';
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
      from.textContent = live.customUrl ? 'custom' : (live.shipped?.[0]?.from || 'shipped');
      address.append(link, from);
    } else {
      address.innerHTML = '<span class="addr-empty">No live address reported right now</span>';
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

/* ── Public News ── */
function renderNews() {
  const container = $('newsList');
  container.replaceChildren();
  const items = Array.isArray(config?.adminNews) ? config.adminNews : [];
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'storage-copy';
    empty.textContent = 'No public news items published yet.';
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

function renderConfig() {
  renderPages();
  renderMaintenance();
  renderOverride();
  renderForceLive();
  renderBulkGroups();
  renderFilterChips();
  renderSources();
  renderNews();
  updateStorage();
  updateKpiStrip();
  $('configTime').textContent = `Snapshot loaded · ${new Date().toLocaleString()}`;
}

async function loadConfig({ silent = false } = {}) {
  const payload = await api('/config');
  config = {
    maintenance: payload.maintenance || {},
    pages: payload.pages || { disabled: [] },
    pageList: Array.isArray(payload.pageList) && payload.pageList.length ? payload.pageList : DEFAULT_PAGE_LIST,
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
    config.adminNews = config.adminNews.filter((entry) => entry.id !== item.id);
    renderNews();
    acceptWrite(result, 'News item deleted.', 'newsMessage');
  } catch (error) {
    setStatusLine('newsMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function saveMaintenance(active) {
  setStatusLine('maintenanceFeedback', '');
  try {
    const result = await api('/maintenance', {
      method: 'POST',
      body: JSON.stringify({
        active,
        message: $('maintenanceMessage').value,
        eta: $('maintenanceEta').value
      })
    });
    config.maintenance = result.maintenance;
    renderMaintenance();
    updateKpiStrip();
    acceptWrite(result, active ? 'Maintenance enabled.' : 'Maintenance disabled.', 'maintenanceFeedback');
  } catch (error) {
    setStatusLine('maintenanceFeedback', error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function saveForceLive(active) {
  setStatusLine('forceLiveMessage', '');
  try {
    const result = await api('/stream/window', {
      method: 'POST',
      body: JSON.stringify({
        active,
        reason: $('forceLiveReason').value
      })
    });
    config.streamWindow = result.streamWindow;
    renderForceLive();
    updateKpiStrip();
    acceptWrite(result, active ? 'Force Live enabled.' : 'Schedule window restored.', 'forceLiveMessage');
  } catch (error) {
    setStatusLine('forceLiveMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
}

/* ── Event Listeners ── */
const nav = $('adminNav');
if (nav) {
  const syncStuck = () => nav.classList.toggle('stuck', window.scrollY > 8);
  window.addEventListener('scroll', syncStuck, { passive: true });
  syncStuck();
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatusLine('loginError', '');
  const button = $('loginBtn');
  button.disabled = true;
  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('usernameInput').value.trim(),
        password: $('passwordInput').value
      })
    });
    $('passwordInput').value = '';
    showDashboard();
    await loadConfig();
    showToast('Signed in to Race Control.');
  } catch (error) {
    setStatusLine('loginError', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch (_) {}
  config = null;
  showAuth('Signed out.');
});

$('reloadConfig').addEventListener('click', async () => {
  try {
    await loadConfig();
    showToast('Control snapshot reloaded.');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

$('enableAllPages').addEventListener('click', () => {
  void savePageControl([], 'All page categories restored online.');
});

$('toggleMaintenance').addEventListener('click', () => {
  saveMaintenance(!(config?.maintenance?.active === true));
});

$('saveMaintenanceCopy').addEventListener('click', () => {
  saveMaintenance(config?.maintenance?.active === true);
});

$('overrideForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatusLine('overrideMessage', '');
  const url = $('overrideInput').value.trim();
  if (!url) {
    setStatusLine('overrideMessage', 'Enter an HTTPS stream URL or iframe snippet first.', 'error');
    return;
  }
  try {
    const result = await api('/stream/override', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    config.streamOverride = result.override;
    $('overrideInput').value = '';
    renderOverride();
    updateKpiStrip();
    acceptWrite(result, 'Stream override started.', 'overrideMessage');
  } catch (error) {
    setStatusLine('overrideMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
});

$('stopOverride').addEventListener('click', async () => {
  setStatusLine('overrideMessage', '');
  try {
    const result = await api('/stream/normal', { method: 'POST' });
    config.streamOverride = result.override;
    renderOverride();
    updateKpiStrip();
    acceptWrite(result, 'Returned to normal stream feeds.', 'overrideMessage');
  } catch (error) {
    setStatusLine('overrideMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
});

$('forceLiveForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveForceLive(true);
});

$('disableForceLive').addEventListener('click', () => {
  saveForceLive(false);
});

$('saveSources').addEventListener('click', async () => {
  setStatusLine('sourcesMessage', '');
  try {
    const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
    const changed = sources.filter((source) => {
      const draft = customDraft[source.id];
      if (!draft) return false;
      return draft.label.trim() !== (source.customLabel || '') || draft.url.trim() !== (source.customUrl || '');
    });
    for (const source of changed) {
      const draft = customDraft[source.id];
      const reply = await api('/stream/chip', {
        method: 'POST',
        body: JSON.stringify({ id: source.id, label: draft.label, url: draft.url })
      });
      if (Array.isArray(reply.sourceList)) config.sourceList = reply.sourceList;
    }
    const result = await api('/stream/sources', {
      method: 'POST',
      body: JSON.stringify({ disabled: [...sourceDraft] })
    });
    config.sources.disabled = result.disabled || [];
    if (Array.isArray(result.sourceList)) config.sourceList = result.sourceList;
    renderFilterChips();
    renderSources();
    acceptWrite(result, changed.length ? `Source settings saved (${changed.length} custom).` : 'Source settings saved.', 'sourcesMessage');
  } catch (error) {
    setStatusLine('sourcesMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
});

$('enableAllSources').addEventListener('click', () => {
  sourceDraft = new Set();
  renderSourcesFromDraft();
  setStatusLine('sourcesMessage', 'All sources enabled in draft. Click Save source settings to publish.');
});

$('refreshLinks').addEventListener('click', () => {
  void loadLinks({ quiet: false });
});

$('sourceSearch').addEventListener('input', (event) => {
  sourceQuery = String(event.target.value || '').trim();
  renderSources();
});

$('clearCustomSources').addEventListener('click', async () => {
  const customised = (config?.sourceList || []).filter((s) => s.customLabel || s.customUrl);
  if (!customised.length) {
    setStatusLine('sourcesMessage', 'No custom names or links are set.');
    return;
  }
  if (!window.confirm(`Clear custom names and links on ${customised.length} source${customised.length === 1 ? '' : 's'}?`)) return;
  try {
    let last = null;
    for (const source of customised) {
      last = await api('/stream/chip', { method: 'POST', body: JSON.stringify({ id: source.id, label: '', url: '' }) });
    }
    await loadConfig({ silent: true });
    if (last) acceptWrite(last, 'Cleared custom names and links.', 'sourcesMessage');
  } catch (error) {
    setStatusLine('sourcesMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
});

$('resetAll').addEventListener('click', async () => {
  if (!window.confirm('Reset Race Control to shipped defaults? This restores all pages, re-enables every stream source, clears custom labels/links, stops overrides, turns off maintenance, and clears news.')) return;
  try {
    const result = await api('/reset-all', { method: 'POST' });
    await loadConfig({ silent: true });
    acceptWrite(result, 'Race Control reset to shipped defaults.');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

$('newsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatusLine('newsMessage', '');
  const body = {
    title: $('newsHeadline').value,
    tag: $('newsTag').value,
    body: $('newsBody').value,
    published: $('newsPublished').checked
  };
  try {
    const result = editingNewsId
      ? await api(`/news/${encodeURIComponent(editingNewsId)}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await api('/news', { method: 'POST', body: JSON.stringify(body) });
    if (editingNewsId) {
      config.adminNews = config.adminNews.map((item) => item.id === editingNewsId ? result.news : item);
    } else {
      config.adminNews = [result.news, ...(config.adminNews || [])];
    }
    resetNewsForm();
    renderNews();
    acceptWrite(result, editingNewsId ? 'News item updated.' : 'News item published.', 'newsMessage');
  } catch (error) {
    setStatusLine('newsMessage', error.message, 'error');
    showToast(error.message, 'error');
  }
});

$('cancelNewsEdit').addEventListener('click', () => resetNewsForm());

async function initialize() {
  resetNewsForm();
  const params = new URLSearchParams(window.location.search);
  const failedFromForm = params.get('auth') === 'failed';
  if (failedFromForm && window.history?.replaceState) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  try {
    const status = await api('/status');
    if (status.authenticated) {
      showDashboard();
      await loadConfig();
    } else {
      showAuth(failedFromForm ? 'Invalid username or password.' : '');
    }
  } catch (error) {
    showAuth(error.message);
  }
}

initialize();
