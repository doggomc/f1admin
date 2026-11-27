'use strict';
const assert = require('node:assert/strict');
const { filterDisabledAutoStreams, createAutoResolver, parseWeelo, parseRacingLap, parsePpv, parseStrmfree, parseStrmfreeSky, parseCdnLive, parseEmb, parseBinTV, parseTimChannels } = require('../auto-streams');
(async () => {
  const now=100000;
  const weelo=parseWeelo({events:[{series_key:'f2',start:now,end:now+30,channels:[{name:'F2',stream:'abcdef'}]}, {series_key:'f1',start:now,end:now+100,live:true,channels:[{name:'International Feed',stream:'abcdef',lang:'EN'}, {name:'Charles Leclerc',stream:'xyzdef',lang:'FR'}]}]},now);
  assert.equal(weelo.length,2); assert.equal(weelo[1].tab,'other'); assert.equal(weelo[1].special,'onboard');
  assert.equal(parseWeelo({events:[{series_key:'f1',end:now-4000}]},now).length,0);
  assert.equal(parseWeelo({events:[{series_key:'f1',start:now,end:now+100,live:true,channels:[{name:'Driver Tracker',stream:'tracker'}]}]},now)[0].special,undefined);
  const rlUrl='https://weellz.live/beta?stream=abc123'; const rlBackup='https://weellz.live/at?id=xyz123';
  const racing={api:'racinglap',version:1,events:[{series:{key:'f1'},type:'fp1',session:'Practice 1',state:'live',start:new Date(now*1000).toISOString(),end:new Date((now+100)*1000).toISOString(),channels:[
    {name:'International Feed',language:'en',onboard:false,embed:rlUrl,backups:[rlBackup,'https://evil.test/at?id=abc']},
    {name:'Driver Tracker',language:'en',onboard:false,embed:'https://weellz.live/beta?stream=tracker'},
    {name:'Data Channel',language:'en',onboard:false,embed:'https://weellz.live/beta?stream=datastream'},
    {name:'Kimi Antonelli',language:'en',onboard:true,embed:'https://weellz.live/beta?stream=onboard'},
    {name:'F2',embed:'https://evil.test/beta?stream=abcd'}]}]};
  const parsedRacing=parseRacingLap(racing,now);assert.equal(parsedRacing.length,4);
  assert.equal(parsedRacing[0].url,rlUrl);assert.deepEqual(parsedRacing[0].backups,[rlBackup]);assert.equal(parsedRacing[0].eventStart,now*1000);assert.equal(parsedRacing[0].eventSession,'Practice 1');
  assert.equal(parsedRacing[1].special,undefined);assert.equal(parsedRacing[2].special,'data');assert.equal(parsedRacing[3].special,'onboard');
  assert.deepEqual(parseRacingLap({api:'racinglap',version:1,events:[]},now),[]);
  assert.throws(()=>parseRacingLap({events:[]},now));
  let used=[];const raceResolver=createAutoResolver({clock:()=>now*1000,fetcher:async url=>{used.push(url);return {ok:true,text:async()=>JSON.stringify(url.includes('racinglap.net')?racing:{events:[],streams:[],channels:[]})}}});
  let listed=await raceResolver.list();assert.equal(used.length,8);assert(!used.some(x=>x.includes('weelo.live/players/events')));assert(listed.streams.some(x=>x.url===rlUrl));
  used=[];const legacyResolver=createAutoResolver({clock:()=>now*1000,fetcher:async url=>{used.push(url);return {ok:true,text:async()=>JSON.stringify(url.includes('racinglap.net')?{}:url.includes('weelo.live/players/events')?{events:[{series_key:'f1',start:now,end:now+100,live:true,channels:[{name:'F1 TV',stream:'abcdef',lang:'en'}]}]}:{})}}});
  listed=await legacyResolver.list();assert(used.some(x=>x.includes('weelo.live/players/events')));assert.equal(listed.providers.find(x=>x.provider==='weelo').fallback,true);assert(listed.streams.some(x=>x.provider==='weelo'&&x.label==='F1 TV'));
  used=[];const emptyResolver=createAutoResolver({clock:()=>now*1000,fetcher:async url=>{used.push(url);return {ok:true,text:async()=>JSON.stringify(url.includes('racinglap.net')?{api:'racinglap',version:1,events:[]}:{})}}});
  await emptyResolver.list();assert(!used.some(x=>x.includes('weelo.live/players/events')),'valid empty catalogue must not fall back');
  const ppv=parsePpv({streams:[{category:'Formula 1',streams:[{name:'F1 Race',ends_at:now+100,locale:'en',iframe:'https://taifood-blog.asia/embed/f1/race',substreams:[{name:'Spanish',locale:'es',iframe:'https://taifood-blog.asia/embed/f1/es'},{name:'SD 540p',iframe:'https://taifood-blog.asia/embed/f1/540p'},{name:'bad',iframe:'https://evil.test/embed'}]}]},{category:'Football',streams:[{name:'Soccer',iframe:'https://taifood-blog.asia/embed/x'}]}]},now);
  assert.equal(ppv.length,2);assert.equal(ppv[1].tab,'other');
  const languages=parsePpv({streams:[{category:'Formula 1',streams:[{name:'Las Vegas Grand Prix - Practice 1',tag:'Formula 1',locale:'en',iframe:'https://taifood-blog.asia/embed/las-vegas-practice-1-en',source_tag:'HD | Sky Sport F1',substreams:[
    {name:'Las Vegas Grand Prix - Practice 1',locale:'it',iframe:'https://taifood-blog.asia/embed/las-vegas-practice-1-32430',source_tag:'HD | Sky Sport F1'},
    {name:'Las Vegas Grand Prix - Practice 1',locale:'de',iframe:'https://taifood-blog.asia/embed/las-vegas-practice-1-32429',source_tag:'HD | Sky Sport F1'},
    {name:'Las Vegas Grand Prix - Practice 1',iframe:'https://taifood-blog.asia/embed/las-vegas-practice-1-unknown',source_tag:'HD | Sky Sport F1'},
    {name:'Las Vegas Grand Prix - Practice 1',locale:'it',iframe:'https://taifood-blog.asia/embed/las-vegas-practice-1-other',source_tag:'HD | Other'}]}]}]},now);
  assert.deepEqual(languages.map(x=>x.tag), ['HD | Sky Sport F1','HD | Sky Sport F1 · IT','HD | Sky Sport F1 · DE','HD | Sky Sport F1','HD | Other']);
  assert.deepEqual(languages.map(x=>x.tab), ['en','other','other','en','other']);
  assert.ok(languages.every(x=>x.label==='Las Vegas Grand Prix - Practice 1'));
  const sf=parseStrmfree({streams:[{name:'Sky Sports F1',sources:[{quality:'FHD',broadcast:'Sky',url:'https://strmfree.st/embed/racing/skyf1'}]},{name:'Football',sources:[{url:'https://strmfree.st/embed/football/x'}]}]});assert.equal(sf.length,1);
  const sky = parseStrmfreeSky({stream_key:'skyf1',sources:[{quality:'FHD',live:true,url:'https://strmfree.st/embed/racing/skyf11080p'},{live:false,url:'https://strmfree.st/embed/racing/offline'}]});
  assert.equal(sky.length,1); assert.equal(sky[0].label,'Sky Sports F1');
  assert.equal(parseStrmfree({streams:[{name:'F1 Grand Prix',iframe:'https://strmfree.st/embed/racing/f1',additional_sources:[{iframe:'https://streamfree.top/embed/racing/f1-alt'}]}]}).length,2);
  const ppvFilter = parsePpv({streams:[{category:'F1',streams:[{name:'F1',starts_at:now-1,ends_at:now+60,iframe:'https://taifood-blog.asia/embed/f1/main',substreams:[{source_tag:'SD | F1',uri_name:'f1/race_540p',iframe:'https://taifood-blog.asia/embed/f1/race_540p'}]},{name:'Future F1',starts_at:now+1,iframe:'https://taifood-blog.asia/embed/f1/future'}]}]},now);
  assert.equal(ppvFilter.length,2);assert.equal(ppvFilter[0].url,'https://taifood-blog.asia/embed/f1/main');assert.equal(ppvFilter[1].url,'https://taifood-blog.asia/embed/f1/future');
  const cdn=parseCdnLive({channels:[{name:'Sky Sports F1 FHD UK',status:'online',url:'https://evil.example'},{name:'DAZN F1 FHD',status:'offline'},{name:'F1 Fake',status:'online'}]});
  assert.equal(cdn.length,1);assert.ok(cdn[0].url.startsWith('https://cdnlivetv.tv/'));assert.equal(cdn[0].sourceId,'sky-f1-uk');
  const tim = parseTimChannels({channels:[
    {url:'sky-sports-f1',streams:[{url:'https://shoewiki.click/sky-1',vip:false},{url:'https://shoewiki.click/vip',vip:true}]},
    {url:'sky-sport-f1-italia',streams:[{url:'https://shoewiki.click/it-1'}]},
    {url:'sky-sports-main-event',streams:[{url:'https://shoewiki.click/main-1'}]},
    {url:'other',streams:[{url:'https://shoewiki.click/other'}]}]});
  assert.deepEqual(tim.map(x=>x.label), ['Sky Sports F1','Sky Sport F1 Italia','Sky Sports Main Event']);
  assert.deepEqual(tim.map(x=>x.tab), ['en','other','en']);
  assert.equal(parseTimChannels({channels:[{url:'sky-sports-f1',streams:[{url:'https://shoewiki.click.evil.test/foo'}]}]}).length,0);
  assert.equal(parseTimChannels({channels:[{url:'sky-sports-f1',streams:[{url:'https://shoewiki.click/vip',vip:true}]}]}).length,0);
  const timResolver = createAutoResolver({clock:()=>now*1000,fetcher:async url=>({ok:true,text:async()=>JSON.stringify(url.includes('tim-streams.com')?{channels:[{url:'sky-sports-f1',streams:[{url:'https://shoewiki.click/sky-1'}]}]}:url.includes('cdnlivetv.tv')?{channels:[{name:'Sky Sports F1 FHD UK',status:'online'}]}:url.includes('racinglap.net')?{api:'racinglap',version:1,events:[]}:{} )})});
  const timList=(await timResolver.list()).streams;
  assert(timList.findIndex(x=>x.provider==='timstreams') < timList.findIndex(x=>x.provider==='cdnlive'));
  const encode=x=>Buffer.from(x).toString('base64url');
  const good=`https://bintv-sources.pages.dev/?id=${encode('https://ehgembxe.cfd/bintv/test-123')}`;
  const bad=`https://bintv-sources.pages.dev/?id=${encode('https://evil.test/bintv/test')}`;
  const rotated=`https://bintv-sources.pages.dev/?id=${encode('https://shoewiki.click/bintv/test-123')}`;
  const spoof=`https://bintv-sources.pages.dev/?id=${encode('https://shoewiki.click.evil.test/bintv/test')}`;
  const rotatedList=parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'English',Iframe:rotated},{Name:'German',Iframe:spoof}]}]});
  assert.equal(rotatedList.length,1); assert.equal(rotatedList[0].url,rotated);

  const bintv=parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'English',Iframe:good},{Name:'Italian',Iframe:good},{Name:'German',Iframe:bad},{Name:'4K HEVC',Iframe:good+'&extra=1'}]},{ID:'different',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'English',Iframe:good}]}]});
  assert.equal(bintv.length,2);assert.equal(bintv[0].tab,'en');assert.equal(bintv[1].tab,'other');assert.equal(bintv[0].provider,'bintv');
  const hevc=parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'4K HEVC',Iframe:good},{Name:'German',Iframe:good}]}]});
  assert.equal(hevc[0].tab,'en');assert.equal(hevc[0].label,'Sky Sports F1 · 4K HEVC');assert.equal(hevc[0].url,good);assert.equal(hevc[1].tab,'other');
  assert.equal(parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'offline',Streams:[{Name:'English',Iframe:good}]}]}).length,0);
  const eventList=parseBinTV({'Live Events':[
    {Name:'Heineken Las Vegas Grand Prix - Race',Category:'Motorsport',Status:'Live',Streams:[{Name:'Apple TV 4K HEVC',Iframe:rotated},{Name:'Sky Sports F1',Iframe:good},{Name:'DAZN F1',Iframe:good},{Name:'Apple TV 4K HEVC',Iframe:spoof}]},
    {Name:'MotoGP Grand Prix - Race',Category:'Motorsport',Status:'Live',Streams:[{Name:'Sky Sports F1',Iframe:good}]},
    {Name:'Las Vegas Grand Prix - Race',Category:'Motorsport',Status:'Upcoming',Streams:[{Name:'Sky Sports F1',Iframe:good}]},
    {Name:'Football Grand Prix - Race',Category:'Football',Status:'Live',Streams:[{Name:'Sky Sports F1',Iframe:good}]},
    {Name:'Unknown Grand Prix - Race',Category:'Motorsport',Status:'Live',Streams:[{Name:'Apple TV',Iframe:good}]}
  ]});
  assert.deepEqual(eventList.map(x=>x.label),['Apple TV','Sky Sports F1','DAZN F1']);
  assert.equal(eventList[0].tag,'4K'); assert.equal(eventList[0].tab,'en'); assert.equal(eventList[2].tab,'other');
  assert.equal(eventList[0].eventSession,'Heineken Las Vegas Grand Prix - Race');
  const emb=parseEmb({channels:[{channelname:'f1frisky',id:'abc'},{channelname:'f1friesp',id:'def'}, {channelname:'f1fri540p',id:'x'}, {channelname:'football',id:'xyz'}]});assert.equal(emb.length,2);assert.equal(emb[1].tab,'other');
  const currentEmb = parseEmb({channels: ['skyf1_en','f1_appletv','daznf1_hd','skyf1de','skyf1it','skyf1uhd','ssmotorsport_sd','Sky Sport Event 1','skyf1_540p'].map((channelname,i)=>({channelname,id:`id-${i}`}))});
  assert.equal(currentEmb.length,6);
  assert.deepEqual(currentEmb.map(x=>x.label),['Sky Sports F1','Apple TV','DAZN F1','Sky F1 · DE','Sky F1 · IT','Sky F1 UHD']);
  assert.deepEqual(currentEmb.map(x=>x.tab),['en','en','other','other','other','en']);
  const newEmb = parseEmb({channels: ['skyf1','f1atvp','daznf1','skyf1de','skyf1it','skyf1uhd','SkyMainEvent'].map((channelname,i)=>({channelname,id:`new-${i}`}))});
  assert.deepEqual(newEmb.map(x=>x.label), ['Sky Sports F1','Apple TV','DAZN F1','Sky F1 · DE','Sky F1 · IT','Sky F1 UHD']);
  assert.deepEqual(newEmb.map(x=>x.tab), ['en','en','other','other','other','en']);
  const uk = parseEmb({channels:[{channelname:'skyf1uk',id:'current-uk'}]});
  assert.equal(uk.length,1); assert.equal(uk[0].label,'Sky Sports F1'); assert.equal(uk[0].tab,'en'); assert.equal(uk[0].url,'https://embdlol.st/embed/current-uk');
  // Captured current provider naming: keep each ID separate and never invent a broadcaster.
  const liveNames = ['SkyF1','skyf1de','daznf1','f1uhd','f1atv','f1506'];
  const currentLive = parseEmb({channels:liveNames.map((channelname,i)=>({channelname,id:`live-${i}`}))});
  assert.deepEqual(currentLive.map(e=>e.label), ['Sky Sports F1','Sky F1 · DE','DAZN F1','F1 UHD','Apple TV','Fox Sports 506']);
  assert.deepEqual(currentLive.map(e=>e.url), liveNames.map((_,i)=>`https://embdlol.st/embed/live-${i}`));
  assert.equal(parseEmb({channels:[{channelname:'SkyF1SD',id:'sd'}]}).length,0);
  const skyEvents = parseEmb({channels:[{channelname:'skyeventit',id:'event-a'},{channelname:'skyeventit2',id:'event-b'}]});
  assert.deepEqual(skyEvents.map(x=>x.label), ['Sky Event IT','Sky Event IT 2']);
  assert.deepEqual(skyEvents.map(x=>x.tab), ['other','other']);
  assert.deepEqual(skyEvents.map(x=>x.url), ['https://embdlol.st/embed/event-a','https://embdlol.st/embed/event-b']);
  const specialEmb = parseEmb({channels:['f1drivertracker','f1pitlane','f1lewis','f1kimi','f1mixedonboard','f1timingchannel','f1stroll'].map((channelname,i)=>({channelname,id:`special-${i}`}))});
  assert.deepEqual(specialEmb.map(e=>e.label), ['Driver Tracker','Pit Lane','Lewis Hamilton','Kimi Antonelli','Mixed Onboard','Data Channel','Lance Stroll']);
  assert.ok(specialEmb.every(e=>e.tab==='en'));
  assert.equal(parseEmb({channels:[{channelname:'skyf1_en',id:'../bad'}]}).length,0);

  let calls=0; const resolver=createAutoResolver({clock:()=>now*1000,fetcher:async url=>{calls++;return {ok:true,text:async()=>String(url).includes('racinglap.net')?'{"api":"racinglap","version":1,"events":[]}':'{"events":[],"streams":[],"channels":[]}'}}});
  await Promise.all([resolver.list(),resolver.list()]);await resolver.list();assert.equal(calls,8);
  const wikiResolver=createAutoResolver({clock:()=>now*1000,fetcher:async()=>({ok:true,text:async()=>'{}'}),resolveDynamic:async path=>({url:path==='wikisport/1'?'https://siempreon.shop/fslivepro.php?stream=F81':''})});
  const wiki=await wikiResolver.list();assert.equal(wiki.streams.filter(x=>x.provider==='wikisport').length,1);assert.equal(wiki.streams.find(x=>x.provider==='wikisport').sourceId,'wikisport');
  assert.equal(filterDisabledAutoStreams(wiki.streams,{disabled:['wikisport']}).filter(x=>x.provider==='wikisport').length,0);
  assert.equal(filterDisabledAutoStreams(cdn,{removed:['sky-f1-uk']}).length,0);
  const permanentSky = await createAutoResolver({clock:()=>now*1000,fetcher:async url=>({ok:true,text:async()=>String(url).includes('/api/v1/streams') && String(url).includes('strmfree') ? JSON.stringify({streams:[{name:'F1 Other',iframe:'https://strmfree.st/embed/racing/other'}]}) : '{}'})}).list();
  assert.equal(permanentSky.streams[0].sourceId,'sky-strmfree');
  assert.equal(permanentSky.streams[0].url,'https://strmfree.st/embed/racing/skyf11080p');
  assert.equal(permanentSky.streams[0].tag,'StreamFree · Status unknown');
  assert.equal(filterDisabledAutoStreams(permanentSky.streams,{disabled:['sky-strmfree']}).some(x=>x.sourceId==='sky-strmfree'),false);
  assert.equal(sky[0].sourceId,'sky-strmfree');
  const fallback = await createAutoResolver({clock:()=>now*1000,fetcher:async url=>{if(String(url).includes('sources/skyf1')) throw Error('offline');return {ok:true,text:async()=>'{}'}}}).list();
  assert.ok(fallback.streams.some(x=>x.provider==='strmfree' && x.tag.includes('Status unknown')));
  let t = 1000000, embState = 'success', requestCount = 0;
  const retained = createAutoResolver({ttl:600000,clock:()=>t,fetcher:async url=>{
    requestCount++;
    if (String(url).includes('api.embdlol.st')) {
      if (embState === 'failure') throw Error('upstream unavailable');
      return {ok:true,text:async()=>JSON.stringify({channels:embState === 'success' ? [{channelname:'skyf1uk',id:'uk-123'}] : []})};
    }
    return {ok:true,text:async()=>'{}'};
  }});
  let response = await retained.list();
  assert.equal(response.streams.filter(x=>x.provider==='embdlol').length,1);
  embState='failure'; t+=600001; response=await retained.list();
  assert.equal(response.streams.filter(x=>x.provider==='embdlol').length,1);
  assert.deepEqual(response.providers.find(x=>x.provider==='embdlol'),{provider:'embdlol',ok:false,count:1,stale:true,staleUntil:1000000+1200000});
  const beforeCached = requestCount; await retained.list(); assert.equal(requestCount,beforeCached);
  t=1000000+1200000; response=await retained.list();
  assert.equal(response.streams.filter(x=>x.provider==='embdlol').length,0);
  embState='success'; t+=600001; response=await retained.list(); assert.equal(response.streams.filter(x=>x.provider==='embdlol').length,1);
  embState='empty'; t+=600001; response=await retained.list(); assert.equal(response.streams.filter(x=>x.provider==='embdlol').length,0);
  embState='failure'; t+=600001; response=await retained.list(); assert.equal(response.streams.filter(x=>x.provider==='embdlol').length,0);
  // Explicit owner refresh bypasses cache; trusted replicas can adopt its result.
  let forceCalls=0, forceNow=5000000;
  const forced=createAutoResolver({clock:()=>forceNow,fetcher:async url=>{forceCalls++;return {ok:true,text:async()=>String(url).includes('racinglap.net')?'{"api":"racinglap","version":1,"events":[]}':'{}'}}});
  const first=await forced.list(); await forced.list(); assert.equal(forceCalls,8);
  forceNow++; const fresh=await forced.list({force:true}); assert.equal(forceCalls,16); assert.ok(fresh.updatedAt>first.updatedAt);
  const replica=createAutoResolver({clock:()=>forceNow,fetcher:async()=>{throw Error('should not fetch')}});
  assert.equal(replica.adopt(fresh),true); assert.deepEqual(await replica.list(),fresh);
  assert.equal(replica.adopt({...fresh,updatedAt:forceNow-60001}),false);
  assert.equal(replica.adopt({...fresh,streams:[{id:'x',provider:'x',url:'javascript:alert(1)'}]}),false);
  console.log('Auto-Streams discovery, filtering, and cache checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
