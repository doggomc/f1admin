'use strict';
const assert = require('node:assert/strict');
const { singleFlight } = require('../single-flight');
(async () => {
  let calls = 0, finish;
  const run = singleFlight(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const results = Array.from({ length: 2000 }, () => run());
  await Promise.resolve();
  assert.equal(calls, 1, 'concurrent requests should share one upstream operation');
  finish('ready');
  assert.deepEqual(await Promise.all(results), Array(2000).fill('ready'));
  const next = run(); await Promise.resolve(); assert.equal(calls, 2, 'subsequent calls must run again'); finish('next'); await next;
  let attempts = 0;
  const flaky = singleFlight(() => { attempts++; if (attempts === 1) throw new Error('offline'); return 'recovered'; });
  const failures = await Promise.allSettled([flaky(), flaky()]);
  assert.ok(failures.every(r => r.status === 'rejected'));
  assert.equal(await flaky(), 'recovered', 'a failed request must not poison retries');
  console.log('single-flight: concurrency, retry and no-result-cache checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
