'use strict';
/* Metadata-only discovery. Fixed catalogue endpoints, bounded responses, no video proxy. */
const crypto = require('node:crypto');
const PROVIDERS = {
  weelo: 'https://weelo.live/players/events.json',
  ppv: 'https://api.ppv.st/api/streams',
  strmfree: 'https://strmfree.st/api/v1/streams',
  strmfreeSky: 'https://strmfree.st/api/v1/sources/skyf1',
  bintv: 'https://api.yosintv.fun/api/public/bintvjson',
  cdnlive: 'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free',
  embdlol: 'https://api.embdlol.st/struct',
};
const isF1 = value => /(?:\bf\s*1\b|\bformula\s*1\b|\bskyf1\b)/i.test(String(value || ''));
const isLowQuality = value => /(?:^|[^a-z0-9])(?:360|480|540)p(?:$|[^a-z0-9])|(?:^|[^a-z0-9])sd(?:$|[^a-z0-9])/i.test(String(value || '').replace(/_/g, ' '));
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
    if (!(isF1(description) || /\/embed\/f1\//i.test(description) || /\bgrand\s*prix\b/i.test(description)) || (item.ends_at && Number(item.ends_at) < now)) continue;
    for (const row of [item, ...(Array.isArray(item.substreams) ? item.substreams : [])]) {
      if (isLowQuality(`${row.uri_name || ''} ${row.iframe || ''} ${row.source_tag || ''} ${row.name || ''}`)) continue;
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
    const entries = [row, ...(Array.isArray(row.sources) ? row.sources : []), ...(Array.isArray(row.additional_sources) ? row.additional_sources : [])];
    for (const source of entries) {
      if (!source || typeof source !== 'object' || source.live === false) continue;
      const url = safeUrl(source.url || source.iframe || source.embed_url, ['strmfree.st','streamfree.top']);
      if (!url || isLowQuality(`${source.quality || ''} ${url}`) || !new URL(url).pathname.startsWith('/embed/')) continue;
      const entry = makeEntry('strmfree', source.broadcast || source.name || row.name, url, source.lang || source.language, source.quality || 'StreamFree');
      if (entry) result.push(entry);
    }
  }
  return result;
}
function parseStrmfreeSky(data) {
  if (String(data?.stream_key || '').toLowerCase() !== 'skyf1') return [];
  return parseStrmfree({streams:[{name:'Sky Sports F1', sources:(Array.isArray(data.sources) ? data.sources : []).filter(s => s?.live === true)}]});
}
// BinTV rotates player IDs. Only the known Sky F1 channel and a strictly
// validated player wrapper are eligible; never relay or fetch the video.
function parseBinTV(data) {
  const channels = Array.isArray(data?.['24/7 Channels']) ? data['24/7 Channels'] : [];
  const result = [];
  for (const channel of channels) {
    if (channel?.ID !== 'ch_2e8bd51a1742' || channel.Name !== 'Sky Sports F1' || String(channel.Status || '').toLowerCase() !== 'live') continue;
    for (const stream of Array.isArray(channel.Streams) ? channel.Streams : []) {
      const name = String(stream?.Name || '').trim();
      if (!/^(English|Italian|German|4K HEVC)$/i.test(name)) continue;
      try {
        const wrapper = new URL(String(stream.Iframe || ''));
        if (wrapper.protocol !== 'https:' || wrapper.hostname !== 'bintv-sources.pages.dev' || wrapper.username || wrapper.password || wrapper.port || wrapper.pathname !== '/' || wrapper.hash || [...wrapper.searchParams.keys()].some(k => k !== 'id') || wrapper.searchParams.getAll('id').length !== 1) continue;
        const id = wrapper.searchParams.get('id') || '';
        if (!/^[A-Za-z0-9_-]{1,240}$/.test(id)) continue;
        const decoded = Buffer.from(id, 'base64url').toString('utf8');
        if (Buffer.from(decoded, 'utf8').toString('base64url') !== id) continue;
        const player = new URL(decoded);
        if (player.protocol !== 'https:' || player.hostname !== 'ehgembxe.cfd' || player.port || player.username || player.password || player.search || player.hash || !/^\/bintv\/[a-z0-9-]{1,160}$/i.test(player.pathname)) continue;
        const entry = makeEntry('bintv', `Sky Sports F1 · ${name}`, `https://bintv-sources.pages.dev/?id=${id}`, /^(Italian|German|4K HEVC)$/i.test(name) ? name : 'en', 'BinTV');
        if (entry) result.push(entry);
      } catch { /* Invalid wrapper or embedded player. */ }
    }
  }
  return result;
}
const CDN_NAMES = new Set(['Sky Sports F1 FHD UK', 'DAZN F1 FHD']);
function parseCdnLive(data) {
  return (Array.isArray(data?.channels) ? data.channels : []).flatMap(row => {
    if (!CDN_NAMES.has(row?.name) || String(row.status).toLowerCase() !== 'online') return [];
    const name = row.name;
    const url = `https://cdnlivetv.tv/api/v1/channels/player/?name=${encodeURIComponent(name)}&code=&user=cdnlivetv&plan=free`;
    const entry = makeEntry('cdnlive', name, url, /DAZN/.test(name) ? 'es' : 'en', 'CDNLive · Backup', {sourceId:'sky-f1-uk'});
    return entry ? [entry] : [];
  });
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
function createAutoResolver({ fetcher = fetch, ttl = 600000, clock = Date.now, resolveDynamic = null } = {}) {
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
          const entries=({weelo:parseWeelo,ppv:parsePpv,strmfree:parseStrmfree,strmfreeSky:parseStrmfreeSky,embdlol:parseEmb,cdnlive:parseCdnLive,bintv:parseBinTV})[provider](data,now);
          return {provider, ok:true, entries};
        } catch { return {provider,ok:false,entries:[]}; }
      }));
      // Keep the known direct Sky F1 player as an unverified fallback only when
      // its dedicated status endpoint failed; never claim it is live.
      if (!rows.find(row => row.provider === 'strmfreeSky')?.ok && !rows.some(row => row.provider === 'strmfree' && row.entries.length)) {
        rows.push({provider:'strmfreeFallback',ok:false,entries:[makeEntry('strmfree', 'Sky Sports F1', 'https://strmfree.st/embed/racing/skyf11080p', 'en', 'StreamFree · Status unknown')]});
      }
      // WikiSport is discovery only; resolve fixed, allowlisted pages to player URLs.
      // Stream 4 points at TheDaddy, which is intentionally not integrated.
      if (resolveDynamic) {
        const wiki = await Promise.all([1,2,3,5].map(async n => {
          try {
            const resolved = await resolveDynamic(`wikisport/${n}`);
            const url = resolved?.url || '';
            const entry = url ? makeEntry('wikisport', `WikiSport · Stream ${n}`, url, 'en', 'WikiSport · Backup', {sourceId:n === 1 ? 'wikisport' : `wikisport-${n}`}) : null;
            return entry;
          } catch { return null; }
        }));
        rows.push({provider:'wikisport',ok:wiki.some(Boolean),entries:wiki.filter(Boolean)});
      }
      const order = {strmfree:0,weelo:1,ppv:2,embdlol:3,bintv:4,cdnlive:5,wikisport:6};
      const unique=new Map(); for(const row of rows)for(const item of row.entries)unique.set(item.id,item);
      const streams=[...unique.values()].sort((a,b)=>(order[a.provider] ?? 9)-(order[b.provider] ?? 9));
      const result={streams:streams.slice(0,200), providers:rows.map(({provider,ok,entries})=>({provider,ok,count:entries.length})), updatedAt:clock()};
      cached=result;expires=clock()+ttl;return result;
    })().finally(()=>{pending=null}); return pending;
  }
  return {list};
}
function filterDisabledAutoStreams(streams, sources) {
  const disabled = new Set([...(sources?.disabled || []), ...(sources?.removed || [])]);
  return streams.filter(item => !item.sourceId || !disabled.has(item.sourceId));
}
module.exports={filterDisabledAutoStreams,createAutoResolver,parseWeelo,parsePpv,parseStrmfree,parseStrmfreeSky,parseCdnLive,parseEmb,parseBinTV};
