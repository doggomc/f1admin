'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-relays-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: tmp, ADMIN_USER: 'test', ADMIN_PASS: 'test-pass', ADMIN_SECRET: 'relay-test-secret', DISCORD_BOT_TOKEN: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', NODE_ENV: 'test' }, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
    throw Error('Test server did not start');
  }
  async function stop() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await once(child, 'exit'); }
  try {
    await start();
    let r = await fetch(base + '/admin/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:'test',password:'test-pass'}) });
    assert.equal(r.status, 200); const cookie = r.headers.get('set-cookie').split(',').map(x => x.trim().split(';')[0]).join('; ');
    const post = (route, body) => fetch(base + route, {method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
    r = await post('/admin/api/stream/relays', {disabled:true}); assert.equal(r.status,200); assert.equal((await r.json()).sources.relaysDisabled,true);
    const paths = ['/api/stream/weellz-embed?stream=abcd','/api/stream/weellz-key/abc','/api/stream/embdlol-embed?id=abcd','/api/stream/strmfree-embed?variant=skyf11080p','/api/stream/strmfree-m3u8/live/skyf11080p/index.m3u8','/api/stream/ppv-embed?slug=abc','/api/stream/ppv-m3u8/index.m3u8?slug=abc','/api/stream/ppv-m3u8/sub.m3u8?slug=abc'];
    for (const p of paths) { const res=await fetch(base+p); assert.equal(res.status,503,p); assert.equal((await res.json()).code,'relays-disabled',p); assert.match(res.headers.get('cache-control'),/no-store/); }
    let config=await (await fetch(base+'/api/site/config')).json(); assert.equal(config.sources.relaysDisabled,true);
    r=await post('/admin/api/stream/catalogue',{custom:[],disabled:[],removed:[],order:[],overrides:{}}); assert.equal((await r.json()).sources.relaysDisabled,true);
    await stop(); await start(); config=await (await fetch(base+'/api/site/config')).json(); assert.equal(config.sources.relaysDisabled,true,'disabled state survives restart');
    r=await post('/admin/api/stream/relays',{disabled:false}); assert.equal((await r.json()).sources.relaysDisabled,false);
    r=await fetch(base+'/api/stream/embdlol-embed?id=abcd'); assert.equal(r.status,200,'enabling restores relay route');
    assert.equal((await fetch(base+'/api/stream/auto')).status,200,'auto endpoint remains available');
    console.log('relay control: routes, catalogue persistence, restart and re-enable passed');
  } finally { await stop(); fs.rmSync(tmp,{recursive:true,force:true}); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
