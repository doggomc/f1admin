'use strict';
/* One shared, cached F1 calendar; fail closed when we cannot establish a weekend. */
const CALENDAR_URL = 'https://api.jolpi.ca/ergast/f1/current.json?limit=100';
const HOUR = 3600_000;
const CALENDAR_TTL = 12 * HOUR;
const REFRESH_MS = 10 * 60_000;
const RETRY_MS = 15 * 60_000;
const BEFORE_PRACTICE = 3 * HOUR;
// Jolpica supplies a scheduled start, not an actual finish. Allow 2 hours of racing and 3 afterwards.
const AFTER_RACE_START = 5 * HOUR;

function parseWeekendWindows(json) {
  const races = json?.MRData?.RaceTable?.Races;
  if (!Array.isArray(races) || !races.length) throw Error('Empty F1 calendar');
  const windows = [];
  for (const race of races) {
    const fp = race?.FirstPractice;
    if (!fp?.date || !fp?.time || !race?.date || !race?.time) continue;
    const practice = Date.parse(`${fp.date}T${fp.time}`);
    const startRace = Date.parse(`${race.date}T${race.time}`);
    if (!Number.isFinite(practice) || !Number.isFinite(startRace) || startRace <= practice || startRace - practice > 5 * 24 * HOUR) continue;
    windows.push({ start: practice - BEFORE_PRACTICE, end: startRace + AFTER_RACE_START, race: String(race.raceName || 'Grand Prix').slice(0, 100) });
  }
  if (!windows.length) throw Error('No complete F1 weekend times');
  return windows.sort((a,b) => a.start - b.start);
}
function windowAt(windows, now) {
  const current = windows.find(window => now >= window.start && now < window.end);
  const next = windows.find(window => window.start > now);
  if (current) return { active:true, start:current.start, end:current.end, race:current.race, nextCheckAt:Math.min(now + REFRESH_MS, current.end), serverTime:now };
  return { active:false, start:next?.start || null, end:next?.end || null, race:next?.race || null, nextCheckAt:Math.min(next?.start || Infinity, now + CALENDAR_TTL), serverTime:now };
}
function createRaceWeekend({ fetcher=fetch, clock=Date.now } = {}) {
  let windows = null, expires = 0, inFlight = null;
  async function getWindow() {
    const now=clock();
    if (now >= expires) {
      if (!inFlight) inFlight=(async()=>{
        try {
          const r=await fetcher(CALENDAR_URL,{headers:{accept:'application/json'},signal:AbortSignal.timeout(6500)});
          if (!r.ok) throw Error(`Calendar HTTP ${r.status}`);
          const text=await r.text(); if (text.length>1_000_000) throw Error('Calendar too large');
          windows=parseWeekendWindows(JSON.parse(text)); expires=clock()+CALENDAR_TTL;
        } catch { expires=clock()+RETRY_MS; }
      })().finally(()=>{inFlight=null});
      await inFlight;
    }
    const checked=clock();
    if (!windows) return { active:false, reason:'schedule-unavailable', start:null, end:null, race:null, nextCheckAt:checked+RETRY_MS, serverTime:checked };
    return windowAt(windows,checked);
  }
  return { getWindow };
}
async function resolveAutoStreams({ enabled, weekend, resolver, clock=Date.now }) {
  if (!enabled) return { streams:[], providers:[], updatedAt:null, window:{ active:false, reason:'mode-disabled', serverTime:clock(), nextCheckAt:clock()+CALENDAR_TTL } };
  let window = await weekend.getWindow();
  if (!window.active) return { streams:[], providers:[], window, updatedAt:null };
  const result = await resolver.list();
  if (clock() >= window.end) {
    window = await weekend.getWindow();
    return { streams:[], providers:[], window, updatedAt:null };
  }
  const now = clock();
  window = { ...window, serverTime:now, nextCheckAt:Math.min(window.end, Number(result.updatedAt) + REFRESH_MS) };
  return { ...result, window };
}
module.exports={createRaceWeekend,parseWeekendWindows,windowAt,resolveAutoStreams,REFRESH_MS,CALENDAR_TTL};
