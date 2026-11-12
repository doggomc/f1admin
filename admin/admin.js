const $ = (id) => document.getElementById(id);

const DEFAULT_PAGE_LIST = [
  { id: 'cockpit', label: 'Cockpit', path: '/cockpit.html', description: 'Live stream player, sources & multiviewer' },
  { id: 'schedule', label: 'Schedule', path: '/schedule.html', description: 'Season calendar & weekend session times' },
  { id: 'standings', label: 'Standings', path: '/standings.html', description: 'Drivers & Constructors championships' },
  { id: 'live-timing', label: 'Live timing', path: '/live-timing.html', description: 'Timing tower, sectors, race control & radio' },
  { id: 'drivers', label: 'Drivers', path: '/drivers.html', description: 'Driver grid & individual driver profiles' },
  { id: 'teams', label: 'Teams', path: '/teams.html', description: 'Constructor grid & team profiles' },
  { id: 'other', label: 'Other', path: '/other.html', description: 'Other section hub' },
  { id: 'replays', label: 'Replays', path: '/replays.html', description: 'Replay directory & replay player' },
  { id: 'other-streams', label: 'Other streams', path: '/other-streams.html', description: 'Other streams directory & private player' },
  { id: 'help', label: 'Help', path: '/help.html', description: 'Support desk & help tickets' }
];

const PAGE_ICONS = {
  cockpit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  standings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  'live-timing': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M10 2h4"/></svg>',
  drivers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  replays: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z"/></svg>',
  'other-streams': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 22h6M12 19v3M10 9l5 3-5 3z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};

let config = null;
let sourceDraft = new Set();
let customDraft = {};
let removedDraft = new Set();
let linkReport = {};
let linkCheckedAt = 0;
const PUBLIC_SITE_URL = 'https://freef1-live.vercel.app';
let linkSiteUrl = PUBLIC_SITE_URL;

function publicSiteUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/freef1\.netlify\.app$/i.test(url) ? PUBLIC_SITE_URL : (url || PUBLIC_SITE_URL);
}
let sourceFilter = 'all';

function fullStreamUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/api\/stream(?:\/|\?|$)/i.test(value)) return `${window.location.origin}${value}`;
  if (value.startsWith('/') && !value.startsWith('//')) return `${publicSiteUrl(linkSiteUrl)}${value}`;
  return value;
}
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
  if (Array.isArray(payload.delivery)) showDelivery(payload.delivery);
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
  ['live', 'Has link', (s) => Boolean(linkReport[s.id]?.online || s.isCustom)],
  ['custom', 'Custom', (s) => Boolean(s.isCustom)],
  ['emb', 'EMB', (s) => s.provider === 'embdlol'],
  ['embdlol-stripped', 'EMB Stripped', (s) => s.provider === 'embdlol-stripped'],
  ['weelo', 'Weelo', (s) => s.provider === 'weelo'],
  ['weelo-stripped', 'Weelo Stripped', (s) => s.provider === 'weelo-stripped'],
  ['ppv', 'PPV', (s) => s.provider === 'ppv' || s.provider === 'taifood'],
  ['ppv-stripped', 'PPV Stripped', (s) => s.provider === 'ppv-stripped'],
  ['other', 'Other langs', (s) => s.tab === 'other'],
  ['special', 'Special', (s) => Boolean(s.special)]
];

const BULK_GROUPS = [
  ['emb', 'EMB'], ['embdlol-stripped', 'EMB Stripped'],
  ['weelo', 'Weelo'], ['weelo-stripped', 'Weelo Stripped'],
  ['ppv', 'PPV'], ['ppv-stripped', 'PPV Stripped'],
  ['strmfree', 'StreamFree'], ['cdnlivetv', 'CDN Live TV'],
  ['ehgembxe', 'EHG'], ['hakunamatata', 'Hakuna Matata'],
  ['wikisport', 'WikiSport'], ['westream', 'WeStream'],
  ['custom', 'Custom'], ['other', 'Other languages'], ['special', 'Special feeds'],
  ['all', 'Every source']
];

function sourceMatchesBulkGroup(source, group) {
  if (group === 'all') return true;
  if (group === 'other') return source.tab === 'other';
  if (group === 'special') return Boolean(source.special);
  if (group === 'custom') return Boolean(source.isCustom);
  if (group === 'emb') return source.provider === 'embdlol';
  if (group === 'ppv') return source.provider === 'ppv' || source.provider === 'taifood';
  return source.provider === group;
}

function renderFilterChips() {
  const bar = $('sourceFilters');
  if (!bar) return;
  const main = $('sourceMainFilters');
  const providers = $('sourceProviderFilters');
  main.replaceChildren(); providers.replaceChildren();
  const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
  for (const [key, label, match] of FILTER_GROUPS) {
    const count = sources.filter(match).length;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip${sourceFilter === key ? ' is-active' : ''}`;
    chip.setAttribute('aria-pressed', String(sourceFilter === key));
    chip.innerHTML = `${label} <em>${count}</em>`;
    chip.addEventListener('click', () => {
      sourceFilter = key;
      renderFilterChips();
      renderSources();
    });
    (['all', 'on', 'off', 'live', 'custom'].includes(key) ? main : providers).append(chip);
  }
  renderBulkGroups();
}

function renderBulkGroups() {
  const bar = $('sourceBulk');
  if (!bar) return;
  bar.replaceChildren();
  const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
  for (const [group, label] of BULK_GROUPS) {
    const items = sources.filter(source => sourceMatchesBulkGroup(source, group));
    if (!items.length && group !== 'all') continue;
    const visible = items.filter(source => !sourceDraft.has(source.id)).length;
    const wrap = document.createElement('div');
    wrap.className = 'bulk-group';
    wrap.dataset.group = group;
    const info = document.createElement('div');
    info.className = 'bulk-group-info';
    const title = document.createElement('strong');
    title.textContent = label;
    const count = document.createElement('small');
    count.textContent = `${visible} / ${items.length} visible`;
    info.append(title, count);
    const actions = document.createElement('div');
    actions.className = 'bulk-group-actions';
    for (const [action, text] of [['enable', 'On'], ['disable', 'Off']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', `${action === 'enable' ? 'Enable' : 'Disable'} ${label} sources in draft`);
      button.setAttribute('aria-pressed', String(items.length > 0 && (action === 'enable' ? visible === items.length : visible === 0)));
      button.disabled = items.length === 0;
      button.addEventListener('click', () => bulkGroup(group, action, label));
      actions.append(button);
    }
    wrap.append(info, actions);
    bar.append(wrap);
  }
}

function bulkGroup(group, action, label) {
  const items = (config?.sourceList || []).filter(source => sourceMatchesBulkGroup(source, group));
  for (const item of items) { if (action === 'disable') sourceDraft.add(item.id); else sourceDraft.delete(item.id); }
  renderFilterChips(); renderSources();
  setStatusLine('sourcesMessage', `${label}: ${items.length} updated in draft. Save to publish.`);
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
    if (report.siteUrl) linkSiteUrl = publicSiteUrl(report.siteUrl);
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

  const visible = sources.filter((source) => {
    if (sourceQuery) {
      const needle = sourceQuery.toLowerCase();
      if (!`${source.label} ${source.id} ${source.provider || ''}`.toLowerCase().includes(needle)) return false;
    }
    if (sourceFilter === 'off') return sourceDraft.has(source.id);
    if (sourceFilter === 'on') return !sourceDraft.has(source.id);
    if (sourceFilter === 'live') return Boolean(linkReport[source.id]?.online || source.isCustom);
    if (sourceFilter === 'custom') return Boolean(source.isCustom);
    if (sourceFilter === 'all') return true;
    return sourceFilter === 'emb' ? source.provider === 'embdlol'
      : sourceFilter === 'embdlol-stripped' ? source.provider === 'embdlol-stripped'
      : sourceFilter === 'weelo' ? source.provider === 'weelo'
      : sourceFilter === 'weelo-stripped' ? source.provider === 'weelo-stripped'
      : sourceFilter === 'ppv' || sourceFilter === 'taifood' ? (source.provider === 'ppv' || source.provider === 'taifood')
      : sourceFilter === 'ppv-stripped' ? source.provider === 'ppv-stripped'
      : sourceFilter === 'other' ? source.tab === 'other'
      : Boolean(source.special);
  });

  $('sourceResults').textContent = `${visible.length} of ${sources.length} sources`;
  $('sourceVisibleCount').textContent = String(sources.filter(s => !sourceDraft.has(s.id)).length);
  $('sourceHiddenCount').textContent = String(sources.filter(s => sourceDraft.has(s.id)).length);
  $('sourceLinkCount').textContent = String(sources.filter(s => linkReport[s.id]?.online || s.isCustom).length);
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
    if (source.stripped) {
      const strippedTag = document.createElement('em');
      strippedTag.className = 'source-tag';
      strippedTag.textContent = 'stripped';
      name.append(' ', strippedTag);
    }

    const id = document.createElement('span');
    id.className = 'source-id';
    id.textContent = source.id;

    const status = document.createElement('span');
    status.className = 'source-state';
    status.textContent = enabled ? 'Visible' : 'Hidden';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `source-switch${enabled ? ' on' : ''}`;
    button.setAttribute('aria-label', `${enabled ? 'Hide' : 'Show'} ${source.label}`);
    button.setAttribute('aria-pressed', String(enabled));
    button.innerHTML = '<i aria-hidden="true"></i>';
    button.addEventListener('click', () => {
      if (sourceDraft.has(source.id)) sourceDraft.delete(source.id);
      else sourceDraft.add(source.id);
      renderFilterChips();
      if (sourceFilter === 'on' || sourceFilter === 'off') renderSources();
      else renderSourcesFromDraft();
      setStatusLine('sourcesMessage', 'Visibility changed in draft. Save to publish.');
    });

    const custom = document.createElement('div');
    custom.className = 'source-custom';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    customDraft[source.id] ||= { label: source.customLabel || '', url: source.customUrl || '' };
    nameInput.value = customDraft[source.id].label;
    nameInput.placeholder = `Name: ${source.baseLabel || source.label}`;
    nameInput.setAttribute('aria-label', `Custom name for ${source.label}`);
    nameInput.className = source.customLabel ? 'is-set' : '';

    const linkInput = document.createElement('input');
    linkInput.type = 'url';
    linkInput.value = customDraft[source.id].url;
    linkInput.placeholder = 'Link: shipped default';
    linkInput.setAttribute('aria-label', `Custom link for ${source.label}`);
    linkInput.className = source.customUrl ? 'is-set' : '';

    nameInput.addEventListener('input', () => { customDraft[source.id].label = nameInput.value; });
    linkInput.addEventListener('input', () => { customDraft[source.id].url = linkInput.value; });
    custom.append(nameInput, linkInput);
    if (source.isCustom) {
      const group = document.createElement('select');
      group.setAttribute('aria-label', `Language group for ${source.label}`);
      for (const [value,label] of [['en','English'],['other','Other languages']]) {
        const option = document.createElement('option'); option.value=value; option.textContent=label; group.append(option);
      }
      group.value = source.tab === 'other' ? 'other' : 'en';
      group.addEventListener('change', () => { source.tab = group.value; setStatusLine('sourcesMessage', 'Group changed in draft. Save to publish.'); });
      custom.append(group);
    }

    const live = linkReport[source.id];
    const address = document.createElement('div');
    address.className = 'source-address';
    const resolvedUrl = (live?.online && live?.current)
      ? live.current
      : (live?.wouldUse || source.customUrl || source.defaultUrl || '');
    const resolvedFrom = (live?.online && live?.current)
      ? (live.customUrl ? 'custom' : (live.shipped?.[0]?.from || 'shipped'))
      : (source.customUrl ? 'custom' : (live?.state || (resolvedUrl ? 'standby' : '')));
    if (resolvedUrl) {
      const fullUrl = fullStreamUrl(resolvedUrl);
      const link = document.createElement('a');
      link.href = /^https?:\/\//i.test(fullUrl) ? fullUrl : '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'addr-url';
      link.textContent = fullUrl;
      link.title = fullUrl;
      const from = document.createElement('em');
      from.className = 'addr-from';
      from.textContent = resolvedFrom;
      address.append(link, from);
    } else {
      address.innerHTML = '<span class="addr-empty">No live address reported right now — press “Refresh live links” during a session.</span>';
    }
    if (live?.shipped?.length > 1) {
      const more = document.createElement('details');
      more.className = 'addr-fallbacks';
      const summary = document.createElement('summary');
      summary.className = 'addr-more';
      summary.textContent = `+${live.shipped.length - 1} fallback${live.shipped.length > 2 ? 's' : ''}`;
      const list = document.createElement('ol');
      list.className = 'addr-fallback-list';
      for (const entry of live.shipped.slice(1)) {
        const item = document.createElement('li');
        const url = fullStreamUrl(entry.url);
        const isWebUrl = /^https?:\/\//i.test(url);
        const value = document.createElement(isWebUrl ? 'a' : 'span');
        value.className = 'addr-fallback-url';
        value.textContent = url;
        if (isWebUrl) {
          value.href = url;
          value.target = '_blank';
          value.rel = 'noopener noreferrer';
        }
        item.append(value);
        if (entry.from) {
          const from = document.createElement('em');
          from.className = 'addr-from';
          from.textContent = entry.from;
          item.append(from);
        }
        list.append(item);
      }
      more.append(summary, list);
      address.append(more);
    }

    const tools = document.createElement('div');
    tools.className = 'source-row-tools';
    for (const [label, step] of [['↑', -1], ['↓', 1]]) {
      const move = document.createElement('button'); move.type = 'button'; move.textContent = label;
      move.setAttribute('aria-label', `${step < 0 ? 'Move up' : 'Move down'} ${source.label}`);
      const position = sources.indexOf(source); move.disabled = position + step < 0 || position + step >= sources.length;
      move.addEventListener('click', () => { const index = sources.indexOf(source); const target = index + step; if (target < 0 || target >= sources.length) return; [sources[index],sources[target]] = [sources[target],sources[index]]; renderSources(); list.querySelector(`[data-source-id="${source.id}"] .source-row-tools button:nth-child(${step < 0 ? 1 : 2})`)?.focus(); setStatusLine('sourcesMessage', 'Order changed in draft. Save to publish.'); });
      tools.append(move);
    }
    const remove = document.createElement('button'); remove.type='button'; remove.className='source-remove'; remove.textContent='Remove';
    remove.setAttribute('aria-label', `Remove ${source.label}`);
    remove.addEventListener('click', () => {
      if (!window.confirm(`Remove ${source.label} from the source list?`)) return;
      if (!source.isCustom) removedDraft.add(source.id);
      config.sourceList = config.sourceList.filter(item => item.id !== source.id);
      sourceDraft.delete(source.id); delete customDraft[source.id]; renderFilterChips(); renderSources();
      setStatusLine('sourcesMessage', 'Source removed from draft. Save to publish.');
    });
    tools.append(remove);
    const heading = document.createElement('div');
    heading.className = 'source-heading';
    const identity = document.createElement('div');
    identity.className = 'source-identity';
    const meta = document.createElement('div');
    meta.className = 'source-meta';
    meta.append(id);
    if (source.provider) {
      const provider = document.createElement('span');
      provider.textContent = source.provider;
      meta.append(provider);
    }
    identity.append(name, meta);
    const visibility = document.createElement('div');
    visibility.className = 'source-visibility';
    visibility.append(status, button);
    heading.append(identity, visibility);

    const addressLabel = document.createElement('span');
    addressLabel.className = 'source-address-label';
    addressLabel.textContent = 'SOURCE ADDRESS';
    address.prepend(addressLabel);

    const editor = document.createElement('details');
    editor.className = 'source-editor';
    const editorSummary = document.createElement('summary');
    editorSummary.textContent = 'Edit source';
    editor.append(editorSummary, custom, tools);
    row.append(heading, address, editor);
    list.append(row);
  }
}

function renderSourcesFromDraft() {
  const sources = Array.isArray(config?.sourceList) ? config.sourceList : [];
  $('sourceVisibleCount').textContent = String(sources.filter(s => !sourceDraft.has(s.id)).length);
  $('sourceHiddenCount').textContent = String(sources.filter(s => sourceDraft.has(s.id)).length);
  const list = $('sourceList');
  [...list.children].forEach((row) => {
    const source = sources.find((entry) => entry.id === row.dataset.sourceId);
    if (!source) return;
    const enabled = !sourceDraft.has(source.id);
    row.classList.toggle('is-off', !enabled);
    row.querySelector('.source-state').textContent = enabled ? 'Visible' : 'Hidden';
    const button = row.querySelector('.source-switch');
    button.classList.toggle('on', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', `${enabled ? 'Hide' : 'Show'} ${source.label}`);
  });
}

function renderConfig() {
  renderPages();
  renderMaintenance();
  renderOverride();
  renderForceLive();
  renderFilterChips();
  renderSources();
  renderAutoStreams();
  renderRelayControl();
  updateStorage();
  updateKpiStrip();
  renderFailover();
  $('configTime').textContent = `Snapshot loaded · ${new Date().toLocaleString()}`;
}

function showDelivery(delivery) {
  const el = $('headquartersDelivery');
  if (!el) return;
  const missed = delivery.filter(item => !item.delivered).map(item => item.name);
  const text = !delivery.length ? 'Saved, but no backend update targets are configured.' : missed.length ? `Saved, but update not delivered to: ${missed.join(', ')}. Retry from Headquarters when available.` : `Last update delivered to ${delivery.length} backend${delivery.length === 1 ? '' : 's'}.`;
  el.textContent = text;
  el.className = `status-line${missed.length || !delivery.length ? ' error' : ''}`;
  const banner = $('replicaDelivery');
  if (banner) { banner.textContent = text; banner.hidden = !missed.length && delivery.length > 0; banner.className = 'status-line error'; }
}

function renderFailover() {
  const el = $('failoverStatus');
  if (el) el.textContent = config?.failover?.active ? 'Backup redirect is ON.' : 'Backup redirect is OFF.';
}
async function setFailover(active) {
  if (!confirm(active ? 'Redirect visitors from the main site to the backup?' : 'Stop redirecting visitors to the backup?')) return;
  try {
    const result = await api('/failover', { method:'POST', body:JSON.stringify({ active }) });
    config.failover = result.failover;
    renderFailover();
    showToast(active ? 'Backup redirect enabled.' : 'Main site restored.');
  } catch (error) { showToast(error.message, 'error'); }
}
$('activateFailover')?.addEventListener('click', () => setFailover(true));
$('deactivateFailover')?.addEventListener('click', () => setFailover(false));

async function loadHeadquarters() {
  const result = await api('/headquarters');
  const section = $('headquartersSection');
  if (!section || !result.enabled) return;
  section.hidden = false;
  const list = $('headquartersTargets');
  list.replaceChildren();
  for (const item of result.targets || []) {
    const row = document.createElement('p');
    row.className = 'section-note';
    row.textContent = `${item.type === 'frontend' ? 'Frontend' : 'Backend'} · ${item.name} — ${item.online ? 'Online' : 'Unavailable'}${item.status ? ` (HTTP ${item.status})` : ''} · ${new Date(item.checkedAt).toLocaleTimeString()}`;
    list.appendChild(row);
  }
  if (!result.targets?.length) list.textContent = 'No services configured yet.';
  $('headquartersMessage').textContent = `Last shared-store operation: ${result.storageConnected ? 'successful' : 'unavailable'}${result.lastSharedSync ? ` · ${new Date(result.lastSharedSync).toLocaleTimeString()}` : ''} · Services checked ${new Date(result.checkedAt).toLocaleTimeString()}`;
}
$('retryHeadquartersSync')?.addEventListener('click', async () => {
  try { await api('/headquarters/sync', { method: 'POST' }); }
  catch (error) { setStatusLine('headquartersDelivery', error.message, 'error'); }
});
$('refreshHeadquarters')?.addEventListener('click', () => loadHeadquarters().catch(error => setStatusLine('headquartersMessage', error.message, 'error')));

async function loadConfig({ silent = false } = {}) {
  const payload = await api('/config');
  if (payload.controlRole === 'replica') {
    const subtitle = document.querySelector('.page-sub');
    if (subtitle) subtitle.textContent = 'Changes are saved through Headquarters and sent to the configured backends.';
  }
  if (payload.controlRole === 'headquarters') {
    document.title = 'Headquarters — FreeF1';
    document.querySelectorAll('.brand-tag').forEach(el => { el.textContent = 'Headquarters'; });
    const subtitle = document.querySelector('.page-sub');
    if (subtitle) subtitle.textContent = 'Changes are sent to configured backends when saved; retry any missed updates when the backend is available.';
    if (!silent) loadHeadquarters().catch(() => {});
  }
  if (payload.linkReport?.siteUrl) linkSiteUrl = publicSiteUrl(payload.linkReport.siteUrl);
  if (Array.isArray(payload.linkReport?.streams)) {
    linkReport = {};
    for (const row of payload.linkReport.streams) linkReport[row.id] = row;
    linkCheckedAt = Number(payload.linkReport.checkedAt) || Date.now();
  }
  config = {
    failover: payload.failover || { active: false },
    maintenance: payload.maintenance || {},
    pages: payload.pages || { disabled: [] },
    pageList: Array.isArray(payload.pageList) && payload.pageList.length ? payload.pageList : DEFAULT_PAGE_LIST,
    sources: payload.sources || { disabled: [] },
    streamOverride: payload.streamOverride || {},
    streamWindow: payload.streamWindow || { active: false, reason: '', startedAt: null, updatedAt: null },
    experimental: payload.experimental || {},
    sourceList: payload.sourceList || [],
    storage: payload.storage || {}
  };
  sourceDraft = new Set((config.sources.disabled || []).map(String));
  removedDraft = new Set((config.sources.removed || []).map(String));
  customDraft = {};
  renderConfig();
  if (silent) return;
  return payload;
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

function renderAutoStreams() {
  const enabled = config?.sources?.autoStreams === true;
  $('autoStreamsToggle').textContent = enabled ? 'Disable Auto-Streams' : 'Enable Auto-Streams';
  $('autoStreamsToggle').setAttribute('aria-pressed', String(enabled));
  $('autoStreamsDetail').textContent = enabled ? 'Automatic feeds refresh every 10 minutes from 3 hours before Practice 1 until about 3 hours after the race. Manual settings are preserved.' : 'Manual sources are active. Auto-Streams checks providers only during race weekends and uses no video relay.';
}
$('autoStreamsToggle').addEventListener('click', async () => {
  const button = $('autoStreamsToggle'); button.disabled = true;
  try {
    const result = await api('/stream/auto', { method: 'POST', body: JSON.stringify({ enabled: !config?.sources?.autoStreams }) });
    config.sources = result.sources; renderAutoStreams();
    acceptWrite(result, 'Stream mode updated.', 'sourcesMessage');
  } catch (error) { setStatusLine('sourcesMessage', error.message, 'error'); }
  finally { button.disabled = false; }
});

function renderRelayControl() {
  const disabled = config?.sources?.relaysDisabled === true;
  $('relayControlToggle').textContent = disabled ? 'Enable stream relays' : 'Disable stream relays';
  $('relayControlToggle').setAttribute('aria-pressed', String(disabled));
  $('relayControlDetail').textContent = disabled
    ? 'Relays are off. Stripped feeds stop; Sky HD and Other Streams use direct embeds. Direct players may show ads.'
    : 'Stripped players and playlist/key relays are available. Disabling them preserves your source settings.';
}
$('relayControlToggle').addEventListener('click', async () => {
  const button = $('relayControlToggle'); button.disabled = true;
  try {
    const result = await api('/stream/relays', { method: 'POST', body: JSON.stringify({ disabled: config?.sources?.relaysDisabled !== true }) });
    config.sources = result.sources; renderRelayControl();
    acceptWrite(result, 'Stream relay setting updated.', 'sourcesMessage');
  } catch (error) { setStatusLine('sourcesMessage', error.message, 'error'); }
  finally { button.disabled = false; }
});

$('saveSources').addEventListener('click', async () => {
  setStatusLine('sourcesMessage', '');
  try {
    const list = config?.sourceList || [];
    const custom = []; const overrides = {};
    for (const source of list) {
      const draft = customDraft[source.id] || { label: source.customLabel || '', url: source.customUrl || '' };
      const label = draft.label.trim(), url = draft.url.trim();
      if (source.isCustom) {
        if (!label || !url) throw new Error(`A name and HTTPS link are required for ${source.label}.`);
        custom.push({ id: source.id, label, url, tab: source.tab === 'other' ? 'other' : 'en' });
      } else if (label || url) overrides[source.id] = { label, url };
    }
    const result = await api('/stream/catalogue', { method: 'POST', body: JSON.stringify({ custom, overrides, disabled: [...sourceDraft], removed: [...removedDraft], order: list.map(s => s.id) }) });
    config.sources = result.sources; config.sourceList = result.sourceList;
    sourceDraft = new Set(config.sources.disabled); removedDraft = new Set(config.sources.removed); customDraft = {};
    renderFilterChips(); renderSources(); acceptWrite(result, 'Source settings saved.', 'sourcesMessage');
  } catch (error) { setStatusLine('sourcesMessage', error.message, 'error'); showToast(error.message, 'error'); }
});

$('addSourceForm').addEventListener('submit', event => {
  event.preventDefault();
  const label = $('newSourceName').value.trim(), value = $('newSourceUrl').value.trim();
  let url; try { url = new URL(value); } catch (_) {}
  if (!label || !url || url.protocol !== 'https:' || url.username || url.password) { setStatusLine('sourcesMessage', 'Enter a name and a full HTTPS link.', 'error'); return; }
  if ((config.sourceList || []).filter(source => source.isCustom).length >= 50) { setStatusLine('sourcesMessage', 'At most 50 custom sources are allowed.', 'error'); return; }
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const source = { id, label, baseLabel: label, customLabel: label, customUrl: url.href, defaultUrl: url.href, provider: 'custom', tab: $('newSourceTab').value, isCustom: true };
  config.sourceList.push(source); customDraft[id] = { label, url: url.href };
  sourceFilter = 'all'; sourceQuery = ''; $('sourceSearch').value = ''; $('addSourceForm').reset();
  renderFilterChips(); renderSources(); setStatusLine('sourcesMessage', 'Source added to draft. Save to publish.');
});

$('restoreSources').addEventListener('click', async () => {
  if (!removedDraft.size) { setStatusLine('sourcesMessage', 'No default sources have been removed.'); return; }
  try {
    const reply = await api('/stream/sources');
    const originals = reply.sources || [];
    for (const source of originals) if (removedDraft.has(source.id) && !config.sourceList.some(item => item.id === source.id)) config.sourceList.push({ ...source, baseLabel: source.label, customLabel: '', customUrl: '' });
    removedDraft.clear(); renderFilterChips(); renderSources(); setStatusLine('sourcesMessage', 'Defaults restored to draft. Save to publish.');
  } catch(error) { setStatusLine('sourcesMessage', error.message, 'error'); }
});

$('enableAllSources').addEventListener('click', () => {
  sourceDraft = new Set();
  renderFilterChips();
  if (sourceFilter === 'on' || sourceFilter === 'off') renderSources();
  else renderSourcesFromDraft();
  setStatusLine('sourcesMessage', 'All sources enabled in draft. Click Save source settings to publish.');
});

$('refreshLinks').addEventListener('click', () => {
  void loadLinks({ quiet: false });
});

$('sourceSearch').addEventListener('input', (event) => {
  sourceQuery = String(event.target.value || '').trim();
  renderSources();
});

$('clearCustomSources').addEventListener('click', () => {
  for (const source of config?.sourceList || []) if (!source.isCustom) customDraft[source.id] = { label: '', url: '' };
  renderSources(); setStatusLine('sourcesMessage', 'Custom names and links cleared in draft. Save to publish.');
});

$('resetAll').addEventListener('click', async () => {
  if (!window.confirm('Reset Race Control to shipped defaults? This restores all pages, re-enables every stream source, clears custom labels/links, stops overrides, turns off maintenance.')) return;
  try {
    const result = await api('/reset-all', { method: 'POST' });
    await loadConfig({ silent: true });
    acceptWrite(result, 'Race Control reset to shipped defaults.');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

async function initialize() {
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
