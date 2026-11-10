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
  console.log('stream-resolver: source catalogue, live EMB precedence, cache and dynamic allowlist checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
