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
module.exports = { readTargets, checkTargets };
