'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readTargets, checkTargets } = require('../headquarters');
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-hq-'));
  const store = new Map(); let online = true, reads = 0;
  const redis = http.createServer((req, res) => {
    let body = ''; req.on('data', x => body += x); req.on('end', () => {
      if (!online) { res.writeHead(503); return res.end(); }
      const run = cmd => {
        const [op, key, value, mode] = cmd;
        if (op === 'GET') { if (key === 'freef1:headquarters:control:v1') reads++; return { result: store.get(key) || null }; }
        if (op === 'SET') { if (mode === 'NX' && store.has(key)) return { result: null }; store.set(key, value); return { result:'OK' }; }
        if (op === 'DEL') { store.delete(key); return { result: 1 }; }
        return { result: null };
      };
      const input = JSON.parse(body); const result = Array.isArray(input[0]) ? input.map(run) : run(input);
      res.setHeader('content-type','application/json'); res.end(JSON.stringify(result));
    });
  });
  redis.listen(0, '127.0.0.1'); await once(redis, 'listening');
  const children = [];
  async function port() { const s=net.createServer(); s.listen(0,'127.0.0.1'); await once(s,'listening'); const n=s.address().port; await new Promise(r=>s.close(r)); return n; }
  async function start(role, folder, initialize = false, forcedPort = null, targets = [], hqUrl = '') {
    const p = forcedPort || await port();
    const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:String(p),DATA_DIR:path.join(dir,folder),CONTROL_ROLE:role,HQ_INITIALIZE:String(initialize),HQ_PUSH_SECRET:'test-secret-for-sync',HQ_PUSH_TARGETS:JSON.stringify(targets),HQ_URL:hqUrl,HQ_UPSTASH_REDIS_REST_URL:`http://127.0.0.1:${redis.address().port}`,HQ_UPSTASH_REDIS_REST_TOKEN:'test',ADMIN_USER:'test',ADMIN_PASS:'test-password',ADMIN_SECRET:'test-secret',DISCORD_BOT_TOKEN:''},stdio:'ignore'}); children.push(child);
    const base=`http://127.0.0.1:${p}`;
    for(let i=0;i<100;i++){try { if((await fetch(base+'/healthz')).ok) return {base,child}; } catch {} await pause(50); } throw Error('server failed to start');
  }
  async function login(base) { const r=await fetch(base+'/admin/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'test',password:'test-password'})}); assert.equal(r.status,200); return r.headers.get('set-cookie').split(',').map(x=>x.trim().split(';')[0]).join('; '); }
  async function change(base,cookie,active){return fetch(base+'/admin/api/maintenance',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({active,message:'HQ test',eta:'Soon'})});}
  async function config(base){return (await (await fetch(base+'/api/site/config')).json()).maintenance.active;}
  async function waitActive(base, desired){for(let i=0;i<50;i++){if(await config(base)===desired)return; await pause(100);} throw Error('replica did not converge');}
  async function stop(child){ if(child.exitCode===null){child.kill(); await once(child,'exit');} }
  try {
    assert.throws(()=>readTargets('[{"name":"x","type":"backend","url":"http://x"}]'));
    assert.deepEqual(await checkTargets([]), []);
    const storeUrl = `http://127.0.0.1:${redis.address().port}`;
    store.set('freef1:race-control:v1', JSON.stringify({ maintenance: {active:false}, pages: {disabled:[]}, sources: {disabled:[]} }));
    async function seed() {
      const c=spawn(process.execPath,['scripts/headquarters-seed.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,SOURCE_UPSTASH_URL:storeUrl,SOURCE_UPSTASH_TOKEN:'test',HQ_UPSTASH_REDIS_REST_URL:storeUrl,HQ_UPSTASH_REDIS_REST_TOKEN:'test',CONFIRM_HQ_SEED:'yes'},stdio:'ignore'});
      return (await once(c,'exit'))[0];
    }
    assert.equal(await seed(),0,'existing settings seeded');
    assert.equal(await seed(),1,'seed never overwrites shared snapshot');
    const p1 = await port(), p2 = await port(), hp = await port();
    const targets = [{name:'Replica 1',url:`http://127.0.0.1:${p1}`},{name:'Replica 2',url:`http://127.0.0.1:${p2}`}];
    const hq=await start('headquarters','hq',true,hp,targets);
    const replica=await start('replica','replica',false,p1,[],hq.base); const replica2=await start('replica','replica2',false,p2,[],hq.base);
    assert.equal((await fetch(replica.base+'/internal/headquarters/sync',{method:'POST'})).status,401,'unauthorized notifications rejected');
    await pause(300); const idleReads = reads; await pause(700); assert.equal(reads, idleReads, 'replicas do not poll shared storage');
    const hc=await login(hq.base); const rc=await login(replica.base);
    assert.equal((await change(replica.base,'',true)).status,401,'replica requires login');
    assert.equal((await change(hq.base,'',true)).status,401,'HQ requires login or server credential');
    assert.equal((await change(replica.base,rc,true)).status,200,'replica admin edits through HQ');
    await waitActive(replica2.base,true);
    assert.equal((await change(replica.base,rc,false)).status,200);
    await waitActive(replica2.base,false);
    const controller = new AbortController();
    const stream = await fetch(replica.base + '/api/site/updates', { signal: controller.signal });
    const reader = stream.body.getReader();
    let events = new TextDecoder().decode((await reader.read()).value);
    assert.equal((await change(hq.base,hc,true)).status,200);
    for (let i = 0; i < 10 && !events.includes('HQ test'); i++) events += new TextDecoder().decode((await reader.read()).value);
    assert.match(events, /HQ test/, 'replica broadcasts synced changes to open tabs');
    controller.abort();
    await Promise.all([waitActive(replica.base,true),waitActive(replica2.base,true)]);
    await stop(hq.child); assert.equal(await config(replica.base),true,'replica remains available when Headquarters is offline');
    assert.equal((await change(replica.base,rc,false)).status,503,'replica refuses writes while Headquarters is offline');
    assert.equal(await config(replica.base),true);
    const hqAgain=await start('headquarters','hq',false,hp,targets); const hcAgain=await login(hqAgain.base);
    online=false;
    assert.equal((await change(hqAgain.base,hcAgain,false)).status,503);
    assert.equal(await config(hqAgain.base),true); assert.equal(await config(replica.base),true);
    await stop(replica.child); const restart=await start('replica','replica',false,p1,[],hq.base); assert.equal(await config(restart.base),true,'disk snapshot survives restart while shared store unavailable');
    online=true;
    await stop(hqAgain.child); const hq2=await start('headquarters','hq',false,hp,targets); const hc2=await login(hq2.base);
    assert.equal((await change(hq2.base,hc2,false)).status,200);
    await Promise.all([waitActive(restart.base,false),waitActive(replica2.base,false)]);
    // One backend can miss a push. Its last known state remains until restart or manual retry.
    await stop(replica2.child);
    let result = await change(hq2.base,hc2,true); const body = await result.json();
    assert.equal(result.status,200); assert.equal(body.delivery.filter(x=>!x.delivered).length,1);
    await waitActive(restart.base,true);
    const replica2restart=await start('replica','replica2',false,p2,[],hq.base); assert.equal(await config(replica2restart.base),true,'startup catches up from store');
    const retry=await fetch(hq2.base+'/admin/api/headquarters/sync',{method:'POST',headers:{cookie:hc2}}); assert.equal(retry.status,200); assert((await retry.json()).delivery.every(x=>x.delivered));
    console.log('Headquarters: editable replica forwarding, authenticated push, offline delivery, retry, restart, SSE and recovery passed');
  } finally { for(const c of children) await stop(c); await new Promise(r=>redis.close(r)); fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
