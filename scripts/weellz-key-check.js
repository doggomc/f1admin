'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createStreamResolver } = require('../stream-resolver');

(async () => {
  let calls = 0, fail = false;
  const fetchImpl = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: !fail, status: fail ? 503 : 200, headers: new Headers(), arrayBuffer: async () => new Uint8Array(16).buffer };
  };
  const resolver = createStreamResolver({ fetchImpl, log: { warn() {} } });
  const a = '1234567890.abcdefabcdefabcdef';
  const b = '1234567890.1111111111111111';
  assert.equal((await resolver.weellzAesKey('bad kid', a)).status, 400);
  assert.equal((await resolver.weellzAesKey('id', 'bad')).status, 400);
  assert.equal(calls, 0);
  const results = await Promise.all(Array.from({ length: 25 }, () => resolver.weellzAesKey('one', a)));
  assert(results.every(result => result.ok && result.body.length === 16));
  assert.equal(calls, 1);
  assert.equal((await resolver.weellzAesKey('one', a)).cached, true);
  await resolver.weellzAesKey('one', b);
  assert.equal(calls, 2, 'completed cache is token scoped');
  await Promise.all([resolver.weellzAesKey('two', a), resolver.weellzAesKey('two', b)]);
  assert.equal(calls, 4, 'different in-flight tokens are not shared');
  fail = true;
  const failed = await Promise.all([resolver.weellzAesKey('three', a), resolver.weellzAesKey('three', a)]);
  assert(failed.every(result => result.status === 503));
  assert.equal(calls, 5);
  fail = false;
  assert((await resolver.weellzAesKey('three', a)).ok);
  assert.equal(calls, 6, 'failed flights are cleared for retry');
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/stream/weellz-key/:kid'"), server.indexOf("app.get('/api/stream/uhd'"));
  assert.match(route, /varyQuery: 't'/);
  console.log('Weelo key: validation, same-token coalescing, token isolation, failure retry and query variation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
