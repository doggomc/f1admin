'use strict';
/* Metadata-only discovery. Fixed catalogue endpoints, bounded responses, no video proxy. */
const crypto = require('node:crypto');
const PROVIDERS = {
  weelo: 'https://weelo.live/players/events.json',
  ppv: 'https://api.ppv.st/api/streams',
  strmfree: 'https://strmfree.st/api/v1/streams',
  embdlol: 'https://api.embdlol.st/struct',
};
const isF1 = value => /(?:\bf\s*1\b|\bformula\s*1\b|\bskyf1\b)/i.test(String(value || ''));
const otherLang = value => { const s = String(value || '').trim().toLowerCase(); return Boolean(s && !/^(en|eng|english|en[-_][a-z]+)$/.test(s)); };
function safeUrl(value, hosts) {
  try { const u = new URL(String(value || '')); return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname.toLowerCase()) ? u.href : ''; } catch { return ''; }
}
function makeEntry(provider, name, url, lang, tag, extra = {}) {
  if (!name || !url) return null;
  const hash = crypto.createHash('sha256').update(`${provider}:${url}`).digest('hex').slice(0, 16);
  return { id: `auto-${provider}-${hash}`, label: String(name).trim().slice(0, 80), provider, url, tab: otherLang(lang) ? 'other' : 'en', tag: String(tag || provider).slice(0, 40), ...extra };
}
function parseWeelo(data, now) {
  const events = (Array.isArray(data?.events) ? data.events : []).filter(e => (e.series_key === 'f1' || /^formula\s*1$/i.test(e.series || '')) && Number(e.end) >= now - 3600);
  events.sort((a,b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || Number(a.start) - Number(b.start));
  const event = events[0]; if (!event) return [];
  return (Array.isArray(event.channels) ? event.channels : []).flatMap(c => {
    if (!/^[A-Za-z0-9_-]{3,180}$/.test(String(c.stream || ''))) return [];
    const name = String(c.name || '').trim();
    const special = /data/i.test(name) ? 'data' : /tracker|onboard|camera/i.test(name) || !/f1 tv|international|sky|world/i.test(name) ? 'onboard' : undefined;
    const entry = makeEntry('weelo', name, `https://weellz.live/beta?stream=${encodeURIComponent(c.stream)}`, c.lang, event.live ? 'Weelo · Live' : 'Weelo · Upcoming', special ? { special } : {});
    return entry ? [entry] : [];
  });
}
function parsePpv(data, now) {
  const result = [];
  for (const group of Array.isArray(data?.streams) ? data.streams : []) for (const item of Array.isArray(group.streams) ? group.streams : []) {
    const description = `${group.category || ''} ${item.name || ''} ${item.tag || ''} ${item.iframe || ''}`;
    if (/\b(?:moto\s*gp|formula\s*[23e]\b|f[23]\s+championship|indycar|nascar|wrc|wec)\b/i.test(description)) continue;
    if (!(isF1(description) || /\/embed\/f1\//i.test(description) || /\bgrand\s*prix\b/i.test(description)) || (item.ends_at && Number(item.ends_at) < now - 3600)) continue;
    for (const row of [item, ...(Array.isArray(item.substreams) ? item.substreams : [])]) {
      if (/\b(?:360|480|540)p\b/i.test(`${row.uri_name || ''} ${row.source_tag || ''} ${row.name || ''}`)) continue;
      const url = safeUrl(row.iframe, ['taifood-blog.asia']);
      const entry = makeEntry('ppv', row.name || item.name, url, row.locale || item.locale, row.source_tag || 'PPV');
      if (entry) result.push(entry);
    }
  }
  return result;
}
function parseStrmfree(data) {
  const result=[];
  for (const row of Array.isArray(data?.streams) ? data.streams : []) {
    if (!isF1(`${row.name || ''} ${row.league || ''} ${row.stream_key || ''}`)) continue;
    for (const source of Array.isArray(row.sources) ? row.sources : []) {
      const url = safeUrl(source.url || source.iframe || source.embed_url, ['strmfree.st','streamfree.top']);
      if (/\b(?:360|480|540)p\b|^sd$/i.test(String(source.quality || '') + ' ' + JSON.stringify(source)) || /^sd$/i.test(String(source.quality || ''))) continue;
      const entry = makeEntry('strmfree', source.name || source.broadcast || row.name, url, source.lang || source.language, source.quality || 'StreamFree');
      if (entry) result.push(entry);
    }
  }
  return result;
}
function parseEmb(data) {
  const result=[];
  for (const c of Array.isArray(data?.channels) ? data.channels : []) {
    const name=String(c.channelname || c.name || '');
    if (!/^f1(?:[\s_-]|[a-z0-9])/i.test(name) || /(?:360|480|540)p|\b(?:replay|recording)\b/i.test(name) || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(c.id || ''))) continue;
    const other = /spanish|italian|german|(?:esp|ita|deu|skyit|skyde)$/i.test(name);
    const entry=makeEntry('embdlol', name, `https://embdlol.st/embed/${encodeURIComponent(c.id)}`, other ? 'other' : 'en', 'EMB');
    if(entry)result.push(entry);
  }
  return result;
}
function createAutoResolver({ fetcher = fetch, ttl = 120000, clock = Date.now } = {}) {
  let cached=null, expires=0, pending=null;
  async function list() {
    if(cached && clock()<expires)return cached;
    if(pending)return pending;
    pending=(async()=>{
      const rows=await Promise.all(Object.entries(PROVIDERS).map(async ([provider,url])=>{
        try {
          const response=await fetcher(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(6500)});
          if(!response.ok)throw Error(`HTTP ${response.status}`);
          const text=await response.text(); if(text.length>2_000_000)throw Error('Catalogue too large');
          const data=JSON.parse(text); const now=Math.floor(clock()/1000);
          const entries=({weelo:parseWeelo,ppv:parsePpv,strmfree:parseStrmfree,embdlol:parseEmb})[provider](data,now);
          return {provider, ok:true, entries};
        } catch { return {provider,ok:false,entries:[]}; }
      }));
      const unique=new Map(); for(const row of rows)for(const item of row.entries)unique.set(item.id,item);
      const result={streams:[...unique.values()].slice(0,200), providers:rows.map(({provider,ok,entries})=>({provider,ok,count:entries.length})), updatedAt:clock()};
      cached=result;expires=clock()+ttl;return result;
    })().finally(()=>{pending=null}); return pending;
  }
  return {list};
}
module.exports={createAutoResolver,parseWeelo,parsePpv,parseStrmfree,parseEmb};
