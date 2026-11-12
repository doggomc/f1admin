'use strict';
// One-time migration only. No legacy keys are changed and a populated HQ key is never overwritten.
const sourceUrl = String(process.env.SOURCE_UPSTASH_URL || '').replace(/\/+$/, '');
const sourceToken = process.env.SOURCE_UPSTASH_TOKEN;
const targetUrl = String(process.env.HQ_UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const targetToken = process.env.HQ_UPSTASH_REDIS_REST_TOKEN;
if (!sourceUrl || !sourceToken || !targetUrl || !targetToken || process.env.CONFIRM_HQ_SEED !== 'yes') {
  console.error('Set SOURCE_UPSTASH_URL, SOURCE_UPSTASH_TOKEN, HQ_UPSTASH_REDIS_REST_URL, HQ_UPSTASH_REDIS_REST_TOKEN and CONFIRM_HQ_SEED=yes. Pause all old Race Control writes before running.'); process.exit(1);
}
async function command(url, token, cmd) {
  const r = await fetch(url, { method:'POST', headers:{ authorization:`Bearer ${token}`, 'content-type':'application/json' }, body:JSON.stringify(cmd), signal:AbortSignal.timeout(10000), redirect:'error' });
  if (!r.ok) throw Error(`Store returned HTTP ${r.status}`);
  const value=await r.json(); if(value.error) throw Error('Store rejected command'); return value.result;
}
(async()=>{
  const raw = await command(sourceUrl, sourceToken, ['GET','freef1:race-control:v1']);
  const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.sources || !state.pages || !state.maintenance) throw Error('Source snapshot missing or invalid; migrate legacy data with the existing server first.');
  // Retired News data is intentionally excluded.
  const { maintenance, pages, sources, streamOverride, streamWindow, experimental } = state;
  const result = await command(targetUrl, targetToken, ['SET','freef1:headquarters:control:v1',JSON.stringify({maintenance,pages,sources,streamOverride,streamWindow,experimental}),'NX']);
  if (result !== 'OK') throw Error('Destination already contains a snapshot; nothing was replaced.');
  console.log('Shared snapshot seeded. Existing data was not changed. Verify before cutover.');
})().catch(error=>{console.error('Seed failed:',error.message);process.exitCode=1;});
