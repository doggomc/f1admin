'use strict';
const { createHash } = require('crypto');
const { renderResultsImage } = require('./results-image');
const YEAR = 2026;
const OPENF1 = 'https://api.openf1.org/v1';
const JOLPI = `https://api.jolpi.ca/ergast/f1/${YEAR}`;
const RETRY_MS = 30_000;
const MAX_BACKLOG_MS = 14 * 86400_000;
const keyFor = (event, session) => `results:${YEAR}:${event.round}:${session.slug}`;
const resultNonce = (guildId, key) => createHash('sha256').update(`${guildId}:${key}`).digest('hex').slice(0, 24);
function duration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
  const ms = Math.round(Number(value) * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${h ? `${h}:${String(m).padStart(2,'0')}:` : `${m}:`}${String(s).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}
function best(v) { return Array.isArray(v) ? [...v].reverse().find(n => Number.isFinite(Number(n)) && Number(n) > 0) : v; }
function openF1Time(row, kind) {
  if (row.dsq) return 'DSQ'; if (row.dns) return 'DNS'; if (row.dnf) return 'DNF';
  if (kind !== 'race') return duration(best(row.duration));
  if (Number(row.position) === 1) return duration(row.duration);
  if (typeof row.gap_to_leader === 'string') return row.gap_to_leader.startsWith('+') ? row.gap_to_leader : `+ ${row.gap_to_leader}`;
  if (row.gap_to_leader != null && Number.isFinite(Number(row.gap_to_leader))) return `+ ${Number(row.gap_to_leader).toFixed(3)}`;
  return '—';
}
function openF1Rows(results, drivers, kind) {
  const roster = new Map(drivers.map(d=>[Number(d.driver_number),d]));
  if (!results.length || results.length < Math.max(10, Math.ceil(roster.size * .9))) return null;
  if (results.some(r => !roster.has(Number(r.driver_number)))) return null;
  return [...results].sort((a,b) => (Number(a.position)||999)-(Number(b.position)||999)).map(r=>{
    const d=roster.get(Number(r.driver_number));
    return { position: String(r.position || '—').padStart(2,'0'), name: [d.first_name,d.last_name].filter(Boolean).join(' ') || d.full_name || `#${r.driver_number}`, team:d.team_name||'Unknown team', color: `#${d.team_colour || '8c929e'}`, time:openF1Time(r,kind) };
  });
}
const TEAM_COLORS = { McLaren:'#ff8000', Ferrari:'#dc0000', 'Red Bull':'#1e41ff', Mercedes:'#00d2be', Williams:'#005aff', 'Aston Martin':'#006f62', 'Alpine F1 Team':'#ff0080', 'Haas F1 Team':'#e6e6e6', Audi:'#e62213', 'RB F1 Team':'#6692ff', 'Cadillac F1 Team':'#b4a07a' };
function jolpiRaceResult(race) {
  if (!race || !Array.isArray(race.Results) || race.Results.length < 10) return null;
  const leaderLaps = Number(race.Results[0]?.laps);
  return { event: race.raceName, session:'Race', kind:'race', rows:race.Results.map(r => {
    let time = r.Time?.time || r.status || '—';
    if (r.status === 'Lapped' && Number.isFinite(leaderLaps) && leaderLaps > Number(r.laps)) {
      const laps = leaderLaps - Number(r.laps); time = `+ ${laps} LAP${laps === 1 ? '' : 'S'}`;
    } else if (r.status === 'Retired') time = 'DNF';
    else if (r.status === 'Did not start') time = 'DNS';
    else if (r.status === 'Disqualified') time = 'DSQ';
    return { position:String(r.position || r.positionText || '—').padStart(2,'0'), name:`${r.Driver?.givenName || ''} ${r.Driver?.familyName || ''}`.trim(),
      team:r.Constructor?.name || 'Unknown team', color:TEAM_COLORS[r.Constructor?.name] || '#8c929e', time };
  }) };
}

function normalName(name) { return String(name || '').toLowerCase().replace(/[^a-z\d]+/g,''); }
function matchingSession(sessions, scheduled) {
  const expected = normalName(scheduled.name);
  const equivalent = n => normalName(n) === expected || (expected === 'sprintqualifying' && normalName(n) === 'sprintshootout');
  return sessions.filter(s => !s.is_cancelled && equivalent(s.session_name) && Math.abs(Date.parse(s.date_start) - scheduled.ts) <= 8 * 3600_000)
    .sort((a,b) => Math.abs(Date.parse(a.date_start)-scheduled.ts)-Math.abs(Date.parse(b.date_start)-scheduled.ts))[0];
}
function createResultsService({ fetchImpl = fetch, now = Date.now } = {}) {
  let sessionsCache = null, sessionsAt = 0, raceCache = null, raceAt = 0;
  async function json(url) {
    const res = await fetchImpl(url,{ headers:{Accept:'application/json'}, signal:AbortSignal.timeout(10000) });
    if (!res.ok) throw Error(`Results provider HTTP ${res.status}`);
    return res.json();
  }
  async function latestRace() {
    if (raceCache && now()-raceAt < 60_000) return raceCache;
    const data=await json(`${JOLPI}/last/results.json?limit=100`);
    const race=data?.MRData?.RaceTable?.Races?.[0];
    if (!race || Number(race.season)!==YEAR || !Number(race.round) || !jolpiRaceResult(race)) return null;
    raceAt=now(); return (raceCache=race);
  }
  async function currentSessions() {
    if (sessionsCache && now()-sessionsAt<30*60_000) return sessionsCache;
    const data=await json(`${OPENF1}/sessions?year=${YEAR}`);
    if (!Array.isArray(data)) throw Error('Invalid OpenF1 sessions');
    sessionsAt=now(); return (sessionsCache=data);
  }
  async function sessionResults(event, session, startedAt) {
    const match=matchingSession(await currentSessions(), session);
    if (!match || !Number.isFinite(Date.parse(match.date_start))) return null;
    // Do not flood the channel with historical practice results on first deployment.
    if (session.ts < startedAt && Date.parse(match.date_end) <= startedAt) return { skipped:true };
    const rows=await json(`${OPENF1}/session_result?session_key=${encodeURIComponent(match.session_key)}`);
    if (!Array.isArray(rows) || !rows.length) return null;
    const drivers=await json(`${OPENF1}/drivers?session_key=${encodeURIComponent(match.session_key)}`);
    if (!Array.isArray(drivers) || !drivers.length) return null;
    const kind = session.slug === 'race' || session.slug === 'sprint' ? 'race' : 'timed';
    const parsed=openF1Rows(rows,drivers,kind);
    if (!parsed) return null;
    return { event:event.name, session:session.name, kind, rows:parsed };
  }
  return {latestRace, sessionResults};
}
function resultsChannel(guild) {
  const matches = [...guild.channels.cache.values()].filter(c=>c.name === 'results' && c.type === 0 && typeof c.send === 'function');
  return matches.length === 1 ? matches[0] : null;
}
function resultPayload(result, guildId, key) {
  return { files:[{attachment:renderResultsImage(result),name:'freef1-session-results.png',description:`${result.event} ${result.session}: ${result.rows.map(r=>`${r.position} ${r.name}, ${r.team}, ${r.time}`).join('; ')}`.slice(0,1024)}], allowedMentions:{parse:[]}, nonce:resultNonce(guildId,key), enforceNonce:true };
}
function createResultsPublisher({ store, client, season, service, log = () => {}, payloadBuilder = resultPayload }) {
  const nextAttempt = new Map(), sessionNext = new Map(), running = new Set();
  async function publish(guildId, channel, key, result, now) {
    let state = (await store.load({ refresh:true })).guilds[guildId];
    if (state?.sent?.[key]) return true;
    const claim = await store.claimAlert(guildId, key);
    if (!claim.acquired) return false;
    try {
      state = (await store.load({ refresh:true })).guilds[guildId];
      if (state?.sent?.[key]) { await claim.release(); return true; }
      const message = await channel.send(payloadBuilder(result, guildId, key));
      state.sent[key] = { messageId: message.id, at: now };
      // Keep the distributed claim if saving fails after a successful send.
      await store.save({ strict:true });
      log(`results posted: ${key}`);
      return true;
    } catch (error) {
      // Keep the local/durable claim after a confirmed send; otherwise retry.
      if (!state?.sent?.[key]) await claim.release();
      throw error;
    }
  }
  return async function checkResults(guildId, state, now) {
    if (running.has(guildId) || now < (nextAttempt.get(guildId) || 0)) return;
    running.add(guildId);
    nextAttempt.set(guildId, now + RETRY_MS);
    try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channel = resultsChannel(guild);
    if (!channel) return; // No guessed channel when missing or ambiguous.
    if (!state.sent) state.sent = {};
    if (!state.sent['results:init']) {
      state.sent['results:init'] = { at: now };
      try { await store.save({ strict:true }); } catch (error) { delete state.sent['results:init']; throw error; }
    }
    const startedAt = state.sent['results:init'].at;
    if (!state.sent['results:bootstrap']) {
      try {
        const race = await service.latestRace();
        if (race) {
          const event = season.find(ev => Number(ev.round) === Number(race.round));
          const session = event?.sessions.find(s => s.slug === 'race');
          if (event && session && session.ts <= now) {
            const key = keyFor(event, session);
            if (await publish(guildId, channel, key, jolpiRaceResult(race), now)) {
              const latest = (await store.load()).guilds[guildId];
              latest.sent['results:bootstrap'] = { at: now };
              await store.save({ strict:true });
            }
          }
        }
      } catch (error) { log('latest race results unavailable:', error.message); }
    }
    // Only sessions occurring from initialization onward (plus one already in progress).
    for (const event of season) for (const session of event.sessions) {
      if (session.ts < startedAt - 4*3600_000 || session.ts > now || now-session.ts > MAX_BACKLOG_MS) continue;
      const key=keyFor(event,session);
      const current=(await store.load()).guilds[guildId];
      if (current.sent[key]) continue;
      const attemptKey = `${guildId}:${key}`;
      if (now < (sessionNext.get(attemptKey) || 0)) continue;
      sessionNext.set(attemptKey, now + (now - session.ts > 4*3600_000 ? 5*60_000 : RETRY_MS));
      try {
        const result=await service.sessionResults(event,session,startedAt);
        if (result?.skipped) { sessionNext.set(attemptKey, Infinity); continue; }
        if (!result) continue;
        await publish(guildId,channel,key,result,now);
      } catch (error) { log(`session results unavailable (${event.slug}/${session.slug}):`,error.message); }
    }
    } finally { running.delete(guildId); }
  };
}
module.exports = {createResultsService,createResultsPublisher,resultsChannel,resultPayload,jolpiRaceResult,keyFor,matchingSession,openF1Rows,openF1Time,duration,RETRY_MS,MAX_BACKLOG_MS};
