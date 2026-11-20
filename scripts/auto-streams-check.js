'use strict';
const assert = require('node:assert/strict');
const { filterDisabledAutoStreams, createAutoResolver, parseWeelo, parsePpv, parseStrmfree, parseStrmfreeSky, parseCdnLive, parseEmb, parseBinTV } = require('../auto-streams');
(async () => {
  const now=100000;
  const weelo=parseWeelo({events:[{series_key:'f2',start:now,end:now+30,channels:[{name:'F2',stream:'abcdef'}]}, {series_key:'f1',start:now,end:now+100,live:true,channels:[{name:'International Feed',stream:'abcdef',lang:'EN'}, {name:'Charles Leclerc',stream:'xyzdef',lang:'FR'}]}]},now);
  assert.equal(weelo.length,2); assert.equal(weelo[1].tab,'other'); assert.equal(weelo[1].special,'onboard');
  assert.equal(parseWeelo({events:[{series_key:'f1',end:now-4000}]},now).length,0);
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
  const encode=x=>Buffer.from(x).toString('base64url');
  const good=`https://bintv-sources.pages.dev/?id=${encode('https://ehgembxe.cfd/bintv/test-123')}`;
  const bad=`https://bintv-sources.pages.dev/?id=${encode('https://evil.test/bintv/test')}`;
  const bintv=parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'English',Iframe:good},{Name:'Italian',Iframe:good},{Name:'German',Iframe:bad},{Name:'4K HEVC',Iframe:good+'&extra=1'}]},{ID:'different',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'English',Iframe:good}]}]});
  assert.equal(bintv.length,2);assert.equal(bintv[0].tab,'en');assert.equal(bintv[1].tab,'other');assert.equal(bintv[0].provider,'bintv');
  const hevc=parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'Live',Streams:[{Name:'4K HEVC',Iframe:good},{Name:'German',Iframe:good}]}]});
  assert.equal(hevc[0].tab,'en');assert.equal(hevc[0].label,'Sky Sports F1 · 4K HEVC');assert.equal(hevc[0].url,good);assert.equal(hevc[1].tab,'other');
  assert.equal(parseBinTV({'24/7 Channels':[{ID:'ch_2e8bd51a1742',Name:'Sky Sports F1',Status:'offline',Streams:[{Name:'English',Iframe:good}]}]}).length,0);
  const emb=parseEmb({channels:[{channelname:'f1frisky',id:'abc'},{channelname:'f1friesp',id:'def'}, {channelname:'f1fri540p',id:'x'}, {channelname:'football',id:'xyz'}]});assert.equal(emb.length,2);assert.equal(emb[1].tab,'other');
  const currentEmb = parseEmb({channels: ['skyf1_en','f1_appletv','daznf1_hd','skyf1de','skyf1it','skyf1uhd','ssmotorsport_sd','Sky Sport Event 1','skyf1_540p'].map((channelname,i)=>({channelname,id:`id-${i}`}))});
  assert.equal(currentEmb.length,6);
  assert.deepEqual(currentEmb.map(x=>x.label),['Sky Sports F1','F1 Apple TV','DAZN F1','Sky F1 · DE','Sky F1 · IT','Sky F1 UHD']);
  assert.deepEqual(currentEmb.map(x=>x.tab),['en','en','other','other','other','en']);
  assert.equal(parseEmb({channels:[{channelname:'skyf1_en',id:'../bad'}]}).length,0);

  let calls=0; const resolver=createAutoResolver({clock:()=>now*1000,fetcher:async()=>{calls++;return {ok:true,text:async()=>'{"events":[],"streams":[],"channels":[]}'}}});
  await Promise.all([resolver.list(),resolver.list()]);await resolver.list();assert.equal(calls,7);
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
  console.log('Auto-Streams discovery, filtering, and cache checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
