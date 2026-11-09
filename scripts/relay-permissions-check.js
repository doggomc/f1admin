#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const port = 39000 + Math.floor(Math.random() * 2000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-permissions-'));
const server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: {
  ...process.env, NODE_ENV: 'production', PORT: String(port), DATA_DIR: dir,
  ADMIN_USER: 'test', ADMIN_PASS: 'test-password', ADMIN_SECRET: 'test-secret-at-least-32-characters',
  ALLOWED_ORIGIN: 'https://freef1.netlify.app', RELAY_ALLOWED_ORIGINS: 'https://explicit-preview.example',
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', KV_REST_API_URL: '', KV_REST_API_TOKEN: '',
  DISCORD_BOT_TOKEN: ''
}, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { await fetch(base + '/healthz'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert(ready, 'server did not start');
    const url = base + '/api/stream/embdlol-embed?id=test';
    const live = 'https://freef1-live.vercel.app';
    const previews = ['https://freef1-mpwk36a5o-f4-ac7f.vercel.app', 'https://freef1-git-design-modern-cockpit-motion-f4-ac7f.vercel.app'];
    const rejected = ['https://freef1.netlify.app', 'https://freef1.vercel.app', 'https://freef1-impersonator.vercel.app', 'https://freef1-mpwk36a5o-other.vercel.app', 'https://evil.example'];
    for (const site of [live, ...previews]) {
      const r = await fetch(url, { headers: { Origin: site, Referer: site + '/' } });
      assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), site);
      const ancestors = r.headers.get('content-security-policy').split(';').map(x => x.trim()).find(x => x.startsWith('frame-ancestors '));
      assert(ancestors.includes(live)); assert(ancestors.includes(site));
      assert(!ancestors.includes('*.vercel.app') && !ancestors.includes('netlify.app'));
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('netlify-cdn-cache-control'), 'no-store');
      assert.match(r.headers.get('vary'), /referer/i);
    }
    for (const site of rejected) {
      assert.equal((await fetch(url, { headers: { Origin: site } })).status, 403, site);
      assert.equal((await fetch(base + '/api/stream/weellz-embed?stream=test', { headers: { Referer: site, 'Sec-Fetch-Dest': 'iframe' } })).status, 403, site);
      const r = await fetch(url, { headers: { Referer: site } });
      const ancestors = r.headers.get('content-security-policy').split(';').find(x => x.trim().startsWith('frame-ancestors '));
      assert(!ancestors.includes(site), site);
    }
    const sandbox = await fetch(url, { headers: { Origin: 'null' } });
    assert.equal(sandbox.status, 200); assert.equal(sandbox.headers.get('access-control-allow-origin'), '*');
    console.log('Relay permissions: production, preview patterns, rejection, isolated policies and sandbox compatibility verified.');
  } finally { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
