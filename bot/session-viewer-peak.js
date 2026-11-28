'use strict';
// Match the live cockpit's existing per-session counter key; this is the main
// site's concurrent cockpit connections, not an all-site or unique-user count.
const COUNTER = 'https://freef1-viewer-counter.calvinbotha1julie.workers.dev/admin/peaks?site=main';
async function sessionViewerPeak(event, session, fetcher = fetch) {
  const timestamp = Number(session?.ts);
  const round = Number(event?.round);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isInteger(round) || round < 1 || round > 99) return null;
  const year = new Date(timestamp).getUTCFullYear();
  if (year < 2020 || year > 2100) return null;
  try {
    const response = await fetcher(COUNTER, {signal:AbortSignal.timeout(4000), redirect:'error'});
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 1_000_000) return null;
    const data = JSON.parse(text);
    if (!Array.isArray(data.peaks)) return null;
    const entry = data.peaks.find(x => x?.kind === 'live' && x.key === `${year}:${round}:${timestamp}`);
    return Number.isSafeInteger(entry?.peak) && entry.peak >= 0 && entry.peak <= 1_000_000 ? entry.peak : null;
  } catch { return null; }
}
module.exports = { sessionViewerPeak };
