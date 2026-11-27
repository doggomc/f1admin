'use strict';
const assert = require('node:assert/strict');
const { createStreamResolver, STREAM_SOURCES } = require('../stream-resolver');

const sky=STREAM_SOURCES.filter(source => source.provider==='strmfree');
assert.equal(sky.length, 1);
assert.equal(sky[0].id, 'sky-strmfree');
assert.notEqual(sky[0].stripped, true);
assert.equal(sky[0].sandboxDirect, true);
assert.ok(sky[0].links.every(link => /^https:\/\/(?:strmfree\.st|streamfree\.top)\/embed\/racing\/skyf1/.test(link.url)));

function resolverFor(channels) {
  let requests = 0;
  const resolver = createStreamResolver({
    log: { warn() {} },
    fetchImpl: async url => {
      if (!String(url).includes('api.embdlol.st/struct')) throw new Error('Unexpected upstream request');
      requests++;
      return { ok: true, status: 200, json: async () => ({ channels }) };
    }
  });
  return { resolver, calls: () => requests };
}

(async () => {
  const live = { id: 'live-id', channelname: 'F1 - Brazil - Live - Sky' };
  const recording = { id: 'recording-id', channelname: 'F1 - Brazil - Saturday - Sky' };
  for (const entries of [[live, recording], [recording, live]]) {
    const { resolver, calls } = resolverFor(entries);
    const map = await resolver.embdlolPublicChannels();
    assert.equal(map.channels.sky, 'live-id', 'live EMB feed must win regardless of catalogue order');
    assert.equal(map.channels.fullhd1, 'live-id', 'English HD alias should use the same live feed');
    await resolver.embdlolPublicChannels();
    assert.equal(calls(), 1, 'fresh catalogue should be cached');
  }
  const current = resolverFor([
    { id: 'sky-id', channelname: 'skyf1' }, { id: 'apple-id', channelname: 'f1atvp' },
    { id: 'dazn-id', channelname: 'daznf1' }, { id: 'de-id', channelname: 'skyf1de' },
    { id: 'it-id', channelname: 'skyf1it' }, { id: 'uhd-id', channelname: 'skyf1uhd' },
    { id: 'event-a', channelname: 'skyeventit' }, { id: 'event-b', channelname: 'skyeventit2' },
    { id: 'other-id', channelname: 'SkyMainEvent' }
  ]);
  const currentMap = (await current.resolver.embdlolPublicChannels()).channels;
  assert.equal(currentMap.fullhd1, 'sky-id'); assert.equal(currentMap.fullhd3, 'apple-id');
  assert.equal(currentMap.dazn, 'dazn-id'); assert.equal(currentMap.skyde, 'de-id');
  assert.equal(currentMap.skyeventit, 'event-a'); assert.equal(currentMap.skyeventit2, 'event-b');
  assert.equal(currentMap.skyit, 'it-id'); assert.equal(currentMap.uhd, undefined);
  const currentSources = await current.resolver.listSources();
  assert.equal(currentSources.find(x => x.id === 'emb-skyeventit').resolvedUrl, 'https://embdlol.st/embed/event-a');
  assert.equal(currentSources.find(x => x.id === 'emb-skyeventit2').resolvedUrl, 'https://embdlol.st/embed/event-b');
  assert.equal(currentSources.find(x => x.id === 'emb-skyeventit2').tab, 'other');
  assert.equal(currentSources.find(x => x.id === 'emb-fullhd1').label, 'Sky Sports F1 (EMB)');
  assert.equal(currentSources.find(x => x.id === 'emb-fullhd3').label, 'Apple TV (EMB)');
  assert.equal(currentSources.find(x => x.id === 'emb-stripped-fullhd1').label, 'Sky Sports F1 (EMB Stripped)');
  const legacy = resolverFor([{id:'legacy',channelname:'f1fullhd1'}]);
  assert.equal((await legacy.resolver.listSources()).find(x => x.id === 'emb-fullhd1').label, 'Full HD 1 (EMB)');
  assert.equal(await current.resolver.resolveUhdUrl(), 'https://embdlol.st/embed/uhd-id');
  const liveUhd = { id: 'live-uhd', channelname: 'F1 - Brazil - Live - UHD' };
  const oldUhd = { id: 'old-uhd', channelname: 'F1 - Brazil - Saturday - UHD' };
  for (const entries of [[liveUhd, oldUhd], [oldUhd, liveUhd]]) {
    const { resolver } = resolverFor(entries);
    assert.equal(await resolver.resolveUhdUrl(), 'https://embdlol.st/embed/live-uhd', '4K resolution must prefer the live feed');
  }
  const onlyRecording = resolverFor([recording]);
  assert.equal((await onlyRecording.resolver.embdlolPublicChannels()).channels.sky, 'recording-id', 'existing recording-only fallback remains available');
  const empty = resolverFor([]);
  assert.deepEqual((await empty.resolver.embdlolPublicChannels()).channels, {});
  const ids = STREAM_SOURCES.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'source IDs must be unique');
  assert.ok(STREAM_SOURCES.every(item => item.id && item.label && item.provider && Array.isArray(item.links)), 'every source needs complete catalogue metadata');
  assert.equal((await empty.resolver.resolveDynamic('unknown/path')).code, 'unknown-provider');
  const pages = {
    'https://wikisport.info/strm/f1.php': '<iframe src="https://wikisport.info/strm/30.php"></iframe>',
    'https://wikisport.info/strm/30.php': '<iframe src="https://siempreon.shop/fslivepro.php?stream=F81"></iframe>',
    'https://wikisport.info/fsl/f1s2.php': '<iframe src="https://taifood-blog.asia/embed/f1/2026/brazil/race"></iframe>',
    'https://wikisport.info/fsl/f1s3.php': '<iframe src="https://embedsports.me/streams/sky-sports-f1-sky-f1-stream-1"></iframe>',
    'https://wikisport.info/fsl/f1s4.php': '<iframe src="https://thedaddy.li/stream/stream-60.php"></iframe>',
    'https://wikisport.info/fsl/f1s5.php': '<iframe src="https://tvpclive.com/embed/stream-60.php"></iframe>'
  };
  const wiki = createStreamResolver({ log: { warn() {} }, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual', 'WikiSport lookups never follow arbitrary redirects');
    assert.ok(Object.hasOwn(pages, String(url)), 'lookups are restricted to the known WikiSport pages');
    return { ok: true, status: 200, text: async () => pages[String(url)] };
  } });
  const expected = ['https://siempreon.shop/fslivepro.php?stream=F81', 'https://taifood-blog.asia/embed/f1/2026/brazil/race', 'https://embedsports.me/streams/sky-sports-f1-sky-f1-stream-1', 'https://thedaddy.li/stream/stream-60.php', 'https://tvpclive.com/embed/stream-60.php'];
  for (let i = 1; i <= 5; i++) {
    const result = await wiki.resolveDynamic(`wikisport/${i}`);
    assert.equal(result.url, expected[i - 1], 'return the direct embed, not WikiSport HTML');
    assert.equal((await wiki.resolveDynamic(`wikisport/${i}`)).cached, true);
  }
  assert.equal((await wiki.resolveDynamic('wikisport/6')).code, 'unknown-provider');
  const hostile = createStreamResolver({ log: { warn() {} }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<iframe src="https://evil.example/embed/stream-60.php"></iframe>' }) });
  assert.equal((await hostile.resolveDynamic('wikisport/5')).code, 'unsupported-embed');
  const redirected = createStreamResolver({ log: { warn() {} }, fetchImpl: async () => ({ ok: false, status: 302 }) });
  assert.equal((await redirected.resolveDynamic('wikisport/2')).code, 'provider-302');
  console.log('stream-resolver: source catalogue, live EMB precedence, cache and dynamic allowlist and direct WikiSport checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
