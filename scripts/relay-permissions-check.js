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
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy');
    const ancestors = policy.split(';').map(x => x.trim()).find(x => x.startsWith('frame-ancestors '));
    for (const site of ['https://freef1.netlify.app', 'https://freef1-live.vercel.app', 'https://freef1-git-design-modern-cockpit-motion-f4-ac7f.vercel.app', 'https://explicit-preview.example']) assert(ancestors.includes(site), site);
    assert(!ancestors.includes('*.vercel.app') && !ancestors.includes('*.netlify.app'));
    for (const site of ['https://random-other-site.netlify.app', 'https://freef1-impersonator.vercel.app']) {
      assert.equal((await fetch(url, { headers: { Origin: site } })).status, 403);
      assert.equal((await fetch(base + '/api/stream/weellz-embed?stream=test', { headers: { Referer: site, 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
    }
    for (const site of ['https://freef1.netlify.app', 'https://freef1-git-design-modern-cockpit-motion-f4-ac7f.vercel.app', 'https://explicit-preview.example']) {
      const r = await fetch(url, { headers: { Origin: site } });
      assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), site);
    }
    const sandbox = await fetch(url, { headers: { Origin: 'null' } });
    assert.equal(sandbox.status, 200); assert.equal(sandbox.headers.get('access-control-allow-origin'), '*');
    console.log('Relay permissions: exact approved origins, explicit preview, wildcard rejection and sandbox compatibility verified.');
  } finally { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
