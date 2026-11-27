'use strict';
/* Metadata-only discovery. Fixed catalogue endpoints, bounded responses, no video proxy. */
const crypto = require('node:crypto');
const PROVIDERS = {
  weelo: 'https://racinglap.net/api/v1/streams.json',
  ppv: 'https://api.ppv.st/api/streams',
  strmfree: 'https://strmfree.st/api/v1/streams',
  strmfreeSky: 'https://strmfree.st/api/v1/sources/skyf1',
  bintv: 'https://api.bintv.link/api/public/bintvjson',
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
    const special = /data/i.test(name) ? 'data' : /tracker/i.test(name) ? undefined : /onboard|camera/i.test(name) || !/f1 tv|international|sky|world/i.test(name) ? 'onboard' : undefined;
    const entry = makeEntry('weelo', name, `https://weellz.live/beta?stream=${encodeURIComponent(c.stream)}`, c.lang, event.live ? 'Weelo · Live' : 'Weelo · Upcoming', special ? { special } : {});
    return entry ? [entry] : [];
  });
}
// RacingLap publishes direct players; keep them intact and constrain to known player routes.
function racingLapPlayer(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 512) return '';
    const u=new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'weellz.live' || u.username || u.password || u.port || u.hash) return '';
    const key=u.pathname==='/beta'?'stream':u.pathname==='/at'?'id':'';
    if (!key || [...u.searchParams.keys()].some(k=>k!==key) || u.searchParams.getAll(key).length!==1 || !/^[A-Za-z0-9_-]{3,180}$/.test(u.searchParams.get(key)||'')) return '';
    return raw;
  } catch { return ''; }
}
function parseRacingLap(data, now) {
  if (!data || data.api !== 'racinglap' || data.version !== 1 || !Array.isArray(data.events)) throw Error('Invalid RacingLap catalogue');
  const types={fp1:'Practice 1',fp2:'Practice 2',fp3:'Practice 3',qualifying:'Qualifying',race:'Race',sprint:'Sprint',shootout:'Sprint Qualifying','sprint-qualifying':'Sprint Qualifying'};
  const events=data.events.filter(e=>e?.series?.key==='f1' && ['live','upcoming'].includes(e.state) && types[e.type] && Number.isFinite(Date.parse(e.start)) && (!e.end || (Number.isFinite(Date.parse(e.end)) && Date.parse(e.end)>=now*1000-3600000)) && Array.isArray(e.channels));
  events.sort((a,b)=>Number(b.state==='live')-Number(a.state==='live') || Date.parse(a.start)-Date.parse(b.start));
  const event=events[0]; if (!event) return [];
  const result=[];
  for (const c of event.channels) {
    const name=String(c?.name || '').trim(); const url=racingLapPlayer(c?.embed);
    if (!name || !url || isLowQuality(name)) continue;
    const backups=(Array.isArray(c.backups)?c.backups:[]).map(racingLapPlayer).filter((v,i,a)=>v && v!==url && a.indexOf(v)===i).slice(0,5);
    const special=/\bdata\b/i.test(name)?'data':c.onboard===true?'onboard':undefined;
    const entry=makeEntry('weelo',name,url,c.language,'RacingLap',{eventSession:types[event.type],eventStart:Date.parse(event.start),...(special?{special}:{}),...(backups.length?{backups}:{})});
    if (entry) result.push(entry);
  }
  if (event.channels.length && !result.length) throw Error('No valid RacingLap players');
  return result;
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
      // PPV uses the same Sky caption for different audio feeds. Only label the
      // language when this individual row explicitly supplies it; do not infer
      // a substream's language from its parent event.
      const tag = String(row.source_tag || 'PPV').trim();
      const locale = String(row.locale || '').trim().toLowerCase().split(/[-_]/)[0];
      const language = ({ it: 'IT', de: 'DE' })[locale];
      const displayTag = language && /\bsky\s+sports?\b/i.test(tag) && !new RegExp(`(?:^|[^a-z])${language}(?:$|[^a-z])`, 'i').test(tag)
        ? `${tag.slice(0, 35).trimEnd()} · ${language}` : tag;
      const entry = makeEntry('ppv', row.name || item.name, url, row.locale || item.locale, displayTag);
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
      const entry = makeEntry('strmfree', source.broadcast || source.name || row.name, url, source.lang || source.language, source.quality || 'StreamFree', url === 'https://strmfree.st/embed/racing/skyf11080p' ? {sourceId:'sky-strmfree'} : {});
      if (entry) result.push(entry);
    }
  }
  return result;
}
function parseStrmfreeSky(data) {
  if (String(data?.stream_key || '').toLowerCase() !== 'skyf1') return [];
  return parseStrmfree({streams:[{name:'Sky Sports F1', sources:(Array.isArray(data.sources) ? data.sources : []).filter(s => s?.live === true)}]}).map(entry => ({...entry, sourceId:'sky-strmfree'}));
}
// BinTV rotates player IDs. Only its known wrappers and narrowly allowed player hosts are eligible.
function binTVPlayer(value) {
  try {
    const wrapper = new URL(String(value || ''));
    if (wrapper.protocol !== 'https:' || wrapper.hostname !== 'bintv-sources.pages.dev' || wrapper.username || wrapper.password || wrapper.port || wrapper.pathname !== '/' || wrapper.hash || [...wrapper.searchParams.keys()].some(k => k !== 'id') || wrapper.searchParams.getAll('id').length !== 1) return '';
    const id = wrapper.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{1,240}$/.test(id)) return '';
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== id) return '';
    const player = new URL(decoded);
    if (player.protocol !== 'https:' || !['ehgembxe.cfd', 'shoewiki.click'].includes(player.hostname) || player.port || player.username || player.password || player.search || player.hash || !/^\/bintv\/[a-z0-9-]{1,160}$/i.test(player.pathname)) return '';
    return `https://bintv-sources.pages.dev/?id=${id}`;
  } catch { return ''; }
}
function parseBinTV(data) {
  const channels = Array.isArray(data?.['24/7 Channels']) ? data['24/7 Channels'] : [];
  const result = [];
  for (const channel of channels) {
    if (channel?.ID !== 'ch_2e8bd51a1742' || channel.Name !== 'Sky Sports F1' || String(channel.Status || '').toLowerCase() !== 'live') continue;
    for (const stream of Array.isArray(channel.Streams) ? channel.Streams : []) {
      const name = String(stream?.Name || '').trim();
      if (!/^(English|Italian|German|4K HEVC)$/i.test(name)) continue;
      const entry = makeEntry('bintv', `Sky Sports F1 · ${name}`, binTVPlayer(stream.Iframe), /^(Italian|German)$/i.test(name) ? name : 'en', 'BinTV');
      if (entry) result.push(entry);
    }
  }
  // Live F1 weekend events only. A generic Grand Prix is not enough: require a
  // clearly F1-specific broadcast and reject other series. Unknown names fail closed.
  for (const event of Array.isArray(data?.['Live Events']) ? data['Live Events'] : []) {
    const title=String(event?.Name || '').trim();
    const streams=Array.isArray(event?.Streams) ? event.Streams : [];
    if (String(event?.Status || '').toLowerCase() !== 'live' || !/motorsport/i.test(String(event?.Category || '')) || /\b(?:moto\s*gp|formula\s*[23e]|f[23]\b|f1\s*academy|indycar|nascar)\b/i.test(title)) continue;
    if (!(isF1(title) || (/\bgrand\s*prix\b/i.test(title) && streams.some(s=>/^sky sports f1(?:\s|$)/i.test(String(s?.Name || '')))))) continue;
    for (const stream of streams) {
      const raw=String(stream?.Name || '').trim();
      const match=raw.match(/^(Apple TV|Sky Sports F1|SuperSport MotorSport|Fox Sports 506|DAZN F1|Eleven Sports 1)(?:\s+(4K(?:\s+HEVC)?|UHD))?$/i);
      if (!match) continue;
      const labels={'apple tv':'Apple TV','sky sports f1':'Sky Sports F1','supersport motorsport':'SuperSport MotorSport','fox sports 506':'Fox Sports 506','dazn f1':'DAZN F1','eleven sports 1':'Eleven Sports 1'};
      const label=labels[match[1].toLowerCase()];
      const lang=label==='DAZN F1'?'es':label==='Eleven Sports 1'?'pl':'en';
      const entry=makeEntry('bintv',label,binTVPlayer(stream.Iframe),lang,match[2]?'4K':'BinTV',{eventSession:title.slice(0,120)});
      if (entry) result.push(entry);
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
  // Explicit current channel aliases plus historical race-prefixed F1 names.
  // Do not infer that a generic Sky Sports or motorsport channel is F1.
  const aliases = {
    skyf1: ['Sky Sports F1', 'en'], skyf1en: ['Sky Sports F1', 'en'], skyf1uk: ['Sky Sports F1', 'en'], f1atvp: ['Apple TV', 'en'], f1atv: ['Apple TV', 'en'], f1appletv: ['Apple TV', 'en'],
    daznf1: ['DAZN F1', 'es'], daznf1hd: ['DAZN F1', 'es'], skyf1de: ['Sky F1 · DE', 'de'],
    skyf1it: ['Sky F1 · IT', 'it'], skyf1uhd: ['Sky F1 UHD', 'en'],
    f1uhd: ['F1 UHD', 'en'], f1506: ['Fox Sports 506', 'en'],
    f1drivertracker: ['Driver Tracker', 'en'], f1pitlane: ['Pit Lane', 'en'],
    f1lewis: ['Lewis Hamilton', 'en'], f1kimi: ['Kimi Antonelli', 'en'],
    f1mixedonboard: ['Mixed Onboard', 'en'], f1timingchannel: ['Data Channel', 'en'], f1stroll: ['Lance Stroll', 'en'],
  };
  for (const c of Array.isArray(data?.channels) ? data.channels : []) {
    const name=String(c?.channelname || c?.name || '').trim();
    const flat=name.toLowerCase().replace(/[\s_-]+/g, '');
    const alias=aliases[flat];
    if ((!alias && !/^f1(?:[\s_-]|[a-z0-9])/i.test(name)) || isLowQuality(name) || /(?:360|480|540)p|\b(?:replay|recording)\b/i.test(name) || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(c?.id || ''))) continue;
    const other = /spanish|italian|german|(?:esp|ita|deu|skyit|skyde)$/i.test(name);
    const entry=makeEntry('embdlol', alias?.[0] || name, `https://embdlol.st/embed/${encodeURIComponent(c.id)}`, alias?.[1] || (other ? 'other' : 'en'), 'EMB');
    if(entry)result.push(entry);
  }
  return result;
}
function createAutoResolver({ fetcher = fetch, ttl = 600000, clock = Date.now, resolveDynamic = null } = {}) {
  let cached=null, expires=0, pending=null, revision=0;
  // Retain only a recent, successfully fetched EMB catalogue; never refresh its age on failures.
  let lastEmb = null;
  const EMB_STALE_MAX_MS = 20 * 60_000;
  async function list({force = false} = {}) {
    if(!force && cached && clock()<expires)return cached;
    if(pending)return pending;
    const startedRevision = revision;
    pending=(async()=>{
      const rows=await Promise.all(Object.entries(PROVIDERS).map(async ([provider,url])=>{
        try {
          const get=async (address, timeout=6500)=>{
            const response=await fetcher(address,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeout)});
            if(!response.ok)throw Error(`HTTP ${response.status}`);
            const text=await response.text(); if(text.length>2_000_000)throw Error('Catalogue too large');
            return JSON.parse(text);
          };
          const now=Math.floor(clock()/1000);
          if (provider === 'weelo') {
            try { return {provider,ok:true,entries:parseRacingLap(await get(url,4000),now)}; }
            catch { const legacy=await get('https://weelo.live/players/events.json',4000); if (!Array.isArray(legacy?.events)) throw Error('Invalid legacy catalogue'); return {provider,ok:true,entries:parseWeelo(legacy,now),fallback:true}; }
          }
          const data=await get(url);
          const entries=({ppv:parsePpv,strmfree:parseStrmfree,strmfreeSky:parseStrmfreeSky,embdlol:parseEmb,cdnlive:parseCdnLive,bintv:parseBinTV})[provider](data,now);
          return {provider, ok:true, entries};
        } catch {
          const age = lastEmb ? clock() - lastEmb.at : Infinity;
          if (provider === 'embdlol' && lastEmb && age >= 0 && age < EMB_STALE_MAX_MS) {
            return {provider, ok:false, entries:lastEmb.entries, stale:true, staleUntil:lastEmb.at + EMB_STALE_MAX_MS};
          }
          return {provider,ok:false,entries:[]};
        }
      }));
      // A trusted snapshot that arrived during the fetch wins over the older in-flight result.
      if (startedRevision !== revision && cached) return cached;
      const embRow = rows.find(row => row.provider === 'embdlol');
      if (embRow?.ok) lastEmb = {entries:embRow.entries, at:clock()};
      // Keep the permanent direct Sky F1 player even if the dedicated catalogue
      // fails or has no live entry; this is a fallback, not a playback guarantee.
      const hasSky = rows.some(row => row.entries.some(entry => entry.provider === 'strmfree' && entry.url === 'https://strmfree.st/embed/racing/skyf11080p'));
      if (!hasSky) {
        rows.push({provider:'strmfreeFallback',ok:false,entries:[makeEntry('strmfree', 'Sky Sports F1', 'https://strmfree.st/embed/racing/skyf11080p', 'en', 'StreamFree · Status unknown', {sourceId:'sky-strmfree'})]});
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
      if (startedRevision !== revision && cached) return cached;
      const order = {strmfree:0,weelo:1,ppv:2,embdlol:3,bintv:4,cdnlive:5,wikisport:6};
      const unique=new Map(); for(const row of rows)for(const item of row.entries)unique.set(item.id,item);
      const streams=[...unique.values()].sort((a,b)=>(order[a.provider] ?? 9)-(order[b.provider] ?? 9) || Number(b.sourceId === 'sky-strmfree') - Number(a.sourceId === 'sky-strmfree'));
      const result={streams:streams.slice(0,200), providers:rows.map(({provider,ok,entries,stale,staleUntil,fallback})=>({provider,ok,count:entries.length,...(fallback ? {fallback:true} : {}),...(stale ? {stale:true,staleUntil} : {})})), updatedAt:clock()};
      const staleEmb = rows.find(row => row.provider === 'embdlol' && row.stale);
      cached=result; expires=staleEmb ? Math.min(clock()+ttl, staleEmb.staleUntil) : clock()+ttl; return result;
    })().finally(()=>{pending=null}); return pending;
  }
  // Accept only the trusted Headquarters snapshot, not arbitrary public input.
  function adopt(result) {
    if (!result || !Array.isArray(result.streams) || result.streams.length > 200 || !Array.isArray(result.providers) || result.providers.length > 12 || !Number.isFinite(result.updatedAt) || Math.abs(clock()-result.updatedAt) > 60000) return false;
    if (result.streams.some(x => !x || typeof x.id !== 'string' || typeof x.url !== 'string' || !/^https:\/\//.test(x.url) || typeof x.provider !== 'string')) return false;
    if (result.providers.some(x => !x || typeof x.provider !== 'string' || typeof x.ok !== 'boolean')) return false;
    const emb = result.providers.find(x=>x.provider==='embdlol');
    if (emb?.stale && (!Number.isFinite(emb.staleUntil) || emb.staleUntil <= clock() || emb.staleUntil > clock()+EMB_STALE_MAX_MS)) return false;
    if (emb?.ok) lastEmb = {entries:result.streams.filter(x=>x.provider==='embdlol'),at:result.updatedAt};
    cached=result; revision++; expires=Math.min(clock()+ttl,result.updatedAt+ttl,emb?.stale ? emb.staleUntil : Infinity); return true;
  }
  return {list,adopt};
}
function filterDisabledAutoStreams(streams, sources) {
  const disabled = new Set([...(sources?.disabled || []), ...(sources?.removed || [])]);
  return streams.filter(item => !item.sourceId || !disabled.has(item.sourceId));
}
module.exports={filterDisabledAutoStreams,createAutoResolver,parseWeelo,parseRacingLap,parsePpv,parseStrmfree,parseStrmfreeSky,parseCdnLive,parseEmb,parseBinTV};
