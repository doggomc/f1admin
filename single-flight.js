'use strict';

// Collapse only simultaneous calls; results and failures are never cached here.
// The resolver remains responsible for freshness, retry and provider-specific TTLs.
function singleFlight(fn) {
  let pending;
  return function (...args) {
    if (pending) return pending;
    pending = Promise.resolve().then(() => fn(...args)).finally(() => { pending = undefined; });
    return pending;
  };
}
module.exports = { singleFlight };
