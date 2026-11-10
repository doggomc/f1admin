'use strict';
const assert = require('node:assert/strict');
const { createStreamResolver, STREAM_SOURCES } = require('../stream-resolver');

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
