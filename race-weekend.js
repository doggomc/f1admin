'use strict';
/* One shared, cached F1 calendar; fail closed when we cannot establish a weekend. */
const CALENDAR_URL = 'https://api.jolpi.ca/ergast/f1/current.json?limit=100';
const HOUR = 3600_000;
// Deployment snapshot mirrors the site's schedule; used only when Jolpica cannot be reached.
const BUNDLED_CALENDAR = require('./data/weekend-calendar-2026.json');
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
function bundledWindows(calendar, now) {
  if (!calendar || new Date(now).getUTCFullYear() !== calendar.season || !Array.isArray(calendar.events)) return null;
  const races = calendar.events.map(event => {
    const practice = Date.parse(event.practice), race = Date.parse(event.race);
    return { start: practice - BEFORE_PRACTICE, end: race + AFTER_RACE_START, race: String(event.name || 'Grand Prix').slice(0, 100) };
  });
  if (!races.length || races.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start || w.end - w.start > 6 * 24 * HOUR)) return null;
  return races.sort((a,b) => a.start-b.start);
}
function createRaceWeekend({ fetcher=fetch, clock=Date.now, fallbackCalendar=BUNDLED_CALENDAR } = {}) {
  let windows = null, expires = 0, inFlight = null, usingFallback = false;
  async function getWindow() {
    const now=clock();
    if (now >= expires) {
      if (!inFlight) inFlight=(async()=>{
        try {
          const r=await fetcher(CALENDAR_URL,{headers:{accept:'application/json'},signal:AbortSignal.timeout(6500)});
          if (!r.ok) throw Error(`Calendar HTTP ${r.status}`);
          const text=await r.text(); if (text.length>1_000_000) throw Error('Calendar too large');
          windows=parseWeekendWindows(JSON.parse(text)); usingFallback=false; expires=clock()+CALENDAR_TTL;
        } catch {
          // Retain a previously successful live calendar. If none is available, use the
          // bundled current-season schedule and retry the live source soon.
          if (!windows) { windows=bundledWindows(fallbackCalendar, clock()); usingFallback=Boolean(windows); }
          expires=clock()+RETRY_MS;
        }
      })().finally(()=>{inFlight=null});
      await inFlight;
    }
    const checked=clock();
    if (!windows) return { active:false, reason:'schedule-unavailable', start:null, end:null, race:null, nextCheckAt:checked+RETRY_MS, serverTime:checked };
    if (usingFallback && new Date(checked).getUTCFullYear() !== fallbackCalendar?.season) { windows=null; usingFallback=false; return { active:false, reason:'schedule-unavailable', start:null, end:null, race:null, nextCheckAt:checked+RETRY_MS, serverTime:checked }; }
    const window = windowAt(windows,checked);
    return usingFallback ? {...window, scheduleSource:'bundled', nextCheckAt:Math.min(window.nextCheckAt, expires)} : window;
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
  window = { ...window, serverTime:now, nextCheckAt:Math.min(window.end, window.nextCheckAt, Number(result.updatedAt) + REFRESH_MS) };
  return { ...result, window };
}
module.exports={createRaceWeekend,parseWeekendWindows,windowAt,resolveAutoStreams,REFRESH_MS,CALENDAR_TTL};
