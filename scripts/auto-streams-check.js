'use strict';
const assert = require('node:assert/strict');
const { createAutoResolver, parseWeelo, parsePpv, parseStrmfree, parseEmb } = require('../auto-streams');
(async () => {
  const now=100000;
  const weelo=parseWeelo({events:[{series_key:'f2',start:now,end:now+30,channels:[{name:'F2',stream:'abcdef'}]}, {series_key:'f1',start:now,end:now+100,live:true,channels:[{name:'International Feed',stream:'abcdef',lang:'EN'}, {name:'Charles Leclerc',stream:'xyzdef',lang:'FR'}]}]},now);
  assert.equal(weelo.length,2); assert.equal(weelo[1].tab,'other'); assert.equal(weelo[1].special,'onboard');
  assert.equal(parseWeelo({events:[{series_key:'f1',end:now-4000}]},now).length,0);
  const ppv=parsePpv({streams:[{category:'Formula 1',streams:[{name:'F1 Race',ends_at:now+100,locale:'en',iframe:'https://taifood-blog.asia/embed/f1/race',substreams:[{name:'Spanish',locale:'es',iframe:'https://taifood-blog.asia/embed/f1/es'},{name:'SD 540p',iframe:'https://taifood-blog.asia/embed/f1/540p'},{name:'bad',iframe:'https://evil.test/embed'}]}]},{category:'Football',streams:[{name:'Soccer',iframe:'https://taifood-blog.asia/embed/x'}]}]},now);
  assert.equal(ppv.length,2);assert.equal(ppv[1].tab,'other');
  const sf=parseStrmfree({streams:[{name:'Sky Sports F1',sources:[{quality:'FHD',broadcast:'Sky',url:'https://strmfree.st/embed/racing/skyf1'}]},{name:'Football',sources:[{url:'https://strmfree.st/embed/football/x'}]}]});assert.equal(sf.length,1);
  const emb=parseEmb({channels:[{channelname:'f1frisky',id:'abc'},{channelname:'f1friesp',id:'def'}, {channelname:'f1fri540p',id:'x'}, {channelname:'football',id:'xyz'}]});assert.equal(emb.length,2);assert.equal(emb[1].tab,'other');
  let calls=0; const resolver=createAutoResolver({clock:()=>now*1000,fetcher:async()=>{calls++;return {ok:true,text:async()=>'{"events":[],"streams":[],"channels":[]}'}}});
  await Promise.all([resolver.list(),resolver.list()]);await resolver.list();assert.equal(calls,4);
  console.log('Auto-Streams discovery, filtering, and cache checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
