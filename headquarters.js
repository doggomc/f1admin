'use strict';

// Targets are configured by the deployer, not supplied through an HTTP request.
// JSON format: [{"name":"Main site","type":"frontend","url":"https://..."}, ...]
function readTargets(raw) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { throw new Error('HQ_TARGETS must be a JSON array'); }
  if (!Array.isArray(list) || list.length > 30) throw new Error('HQ_TARGETS must be an array of at most 30 targets');
  return list.map(item => {
    let url;
    try { url = new URL(item.url); } catch { throw new Error('Invalid HQ target URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['frontend', 'backend'].includes(item.type) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) throw new Error('Invalid HQ target');
    return { name: item.name.trim(), type: item.type, url: url.href };
  });
}
function readPushTargets(raw, allowLocal = false) {
  if (!raw) return [];
  let targets;
  try { targets = JSON.parse(raw); } catch { throw new Error('HQ_PUSH_TARGETS must be a JSON array'); }
  if (!Array.isArray(targets) || targets.length > 30) throw new Error('HQ_PUSH_TARGETS must contain at most 30 backends');
  const seen = new Set();
  return targets.map(item => {
    let url; try { url = new URL(item.url); } catch { throw new Error('Invalid push target'); }
    const local = allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (!(url.protocol === 'https:' || local) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || seen.has(url.origin)) throw new Error('Push targets must be unique HTTPS backend origins');
    seen.add(url.origin);
    return { name: item.name.trim(), url: url.origin };
  });
}
async function pushUpdates(targets, secret) {
  return Promise.all(targets.map(async target => {
    try {
      const response = await fetch(target.url + '/internal/headquarters/sync', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      await response.body?.cancel();
      return { name: target.name, url: target.url, delivered: response.ok, status: response.status, checkedAt: Date.now() };
    } catch { return { name: target.name, url: target.url, delivered: false, status: null, checkedAt: Date.now() }; }
  }));
}
async function checkTargets(targets) {
  return Promise.all(targets.map(async target => {
    const started = Date.now();
    try {
      const response = await fetch(target.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'FreeF1-Headquarters-Health/1.0' } });
      await response.body?.cancel();
      return { ...target, online: response.ok, status: response.status, checkedAt: Date.now(), durationMs: Date.now() - started };
    } catch {
      return { ...target, online: false, status: null, checkedAt: Date.now(), durationMs: Date.now() - started };
    }
  }));
}
module.exports = { readTargets, readPushTargets, pushUpdates, checkTargets };
