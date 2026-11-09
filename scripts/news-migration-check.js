'use strict';
// Exercise the destructive migration against a disposable in-memory Redis REST mock.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runCase(failWrite) {
  const data = new Map([
    ['freef1:race-control:v1', JSON.stringify({ news:[{title:'Retired',body:'private'}], maintenance:{active:true,message:'Preserve maintenance',eta:'Later'}, sources:{disabled:['dazn']}, streamWindow:{active:true,reason:'Keep window'} })],
    ['freef1:news:v1', JSON.stringify([{title:'Legacy',body:'private'}])]
  ]);
  const operations=[];
  const redis = http.createServer((req,res) => {
    let raw=''; req.on('data',chunk=>{raw+=chunk}); req.on('end',()=>{
      const body=JSON.parse(raw);
      const exec = ([op,key,value]) => { operations.push([op,key]); if(op==='GET') return {result:data.get(key)??null}; if(op==='DEL'){data.delete(key);return {result:1};} if(op==='SET'){if(failWrite&&key==='freef1:race-control:v1')return {error:'simulated write failure'};data.set(key,value);return {result:'OK'};}return {error:'unknown'}; };
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Array.isArray(body[0])?body.map(exec):exec(body)));
    });
  });
  await new Promise(resolve=>redis.listen(0,'127.0.0.1',resolve));
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'freef1-migration-'));
  const port=35000+Math.floor(Math.random()*10000);
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),NODE_ENV:'test',DATA_DIR:dataDir,ADMIN_USER:'test',ADMIN_PASS:'test',ADMIN_SECRET:'test-secret',UPSTASH_REDIS_REST_URL:`http://127.0.0.1:${redis.address().port}`,UPSTASH_REDIS_REST_TOKEN:'test',KV_REST_API_URL:'',KV_REST_API_TOKEN:'',DISCORD_BOT_TOKEN:'',DISCORD_TICKETS_ENABLED:'false'},stdio:'ignore'});
  try {
    let config; for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/site/config`);if(r.ok){config=await r.json();break}}catch{}await pause(50)}
    if(!config) throw Error('server did not respond');
    const saved=JSON.parse(data.get('freef1:race-control:v1'));
    if(failWrite){
      if(!saved.news || !data.has('freef1:news:v1') || operations.some(([op,key])=>op==='DEL'&&key==='freef1:news:v1')) throw Error('failed write deleted legacy data');
    } else {
      if('news' in saved || data.has('freef1:news:v1') || saved.maintenance.message!=='Preserve maintenance' || !saved.sources.disabled.includes('dazn') || saved.streamWindow.reason!=='Keep window') throw Error('migration lost unrelated state or failed to delete news');
      const set=operations.findIndex(([op,key])=>op==='SET'&&key==='freef1:race-control:v1');const del=operations.findIndex(([op,key])=>op==='DEL'&&key==='freef1:news:v1');
      if(set<0 || del<set) throw Error('legacy key removed before safe snapshot');
    }
  } finally { child.kill(); await new Promise(resolve=>redis.close(resolve));fs.rmSync(dataDir,{recursive:true,force:true}); }
}
(async()=>{try{await runCase(false);console.log(' ok    Redis migration deletes News only after preserving other state');await runCase(true);console.log(' ok    Redis migration preserves old data when snapshot write fails');}catch(e){console.error(' FAIL  ',e.message);process.exitCode=1;}})();
