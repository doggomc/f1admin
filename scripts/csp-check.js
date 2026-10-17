#!/usr/bin/env node
'use strict';

/* CSP/cache/asset contract for the split architecture. The static Netlify site
   and the Render admin intentionally have different CSPs; this check validates
   each independently and confirms all fonts are self-hosted. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const siteDir = path.resolve(process.env.SITE_DIR || path.join(root, '..', 'netlifyf1'));
let port = 37000 + Math.floor(Math.random() * 1000);

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freef1-csp-data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir,
      ADMIN_USER: 'csp-admin', ADMIN_PASS: 'csp-password', ADMIN_SECRET: 'csp-check-secret',
      ADMIN_IP_ALLOWLIST: '', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
      KV_REST_API_URL: '', KV_REST_API_TOKEN: '', DISCORD_BOT_TOKEN: '', DISCORD_TICKETS_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk.toString(); });
  child.stderr.on('data', chunk => { log += chunk.toString(); });
  return { child, base: `http://127.0.0.1:${port}`, dataDir, log: () => log };
}
async function waitForServer(server) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${server.base}/healthz`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Race Control failed to start: ${server.log()}`);
}
function parsePolicy(text) {
  const directives = new Map();
  for (const part of text.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values.join(' '));
  }
  return directives;
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return /node_modules|\.git/.test(entry.name) ? [] : walk(full);
    return [full];
  });
}

(async () => {
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) throw new Error(`Set SITE_DIR; frontend was not found at ${siteDir}`);

  const server = startServer();
  let adminPolicy = '';
  try {
    await waitForServer(server);
    const response = await fetch(`${server.base}/admin/`);
    adminPolicy = response.headers.get('content-security-policy') || '';
    check('Render admin sends a Content-Security-Policy', adminPolicy.length > 0);
    check('admin policy denies framing by other sites', /frame-ancestors 'self'/.test(adminPolicy));
    check('admin policy keeps scripts same-origin', /script-src 'self'/.test(adminPolicy) && !/script-src[^;]*https:/.test(adminPolicy));
    check('admin policy uses only self-hosted fonts', /font-src 'self' data:/.test(adminPolicy) && !/fonts\.(?:googleapis|gstatic)\.com/.test(adminPolicy));
  } finally {
    server.child.kill('SIGTERM');
    await new Promise(resolve => server.child.once('exit', resolve));
    fs.rmSync(server.dataDir, { recursive: true, force: true });
  }

  const headersText = fs.readFileSync(path.join(siteDir, '_headers'), 'utf8');
  const sitePolicy = (/Content-Security-Policy:\s*(.+)/.exec(headersText) || [])[1] || '';
  const directives = parsePolicy(sitePolicy);
  check('Netlify _headers declares a policy', sitePolicy.length > 0);
  check('site connect-src contains Race Control and direct data providers',
    ['https://f1admin.onrender.com', 'https://api.openf1.org', 'https://api.jolpi.ca'].every(host => directives.get('connect-src')?.includes(host)), directives.get('connect-src') || '');
  const counterOrigin = 'wss://freef1-viewer-counter.calvinbotha1julie.workers.dev';
  const counterEndpoint = `${counterOrigin}/ws`;
  const indexHtml = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  const viewerCounterJs = fs.readFileSync(path.join(siteDir, 'viewer-counter.js'), 'utf8');
  check('site connect-src allows the exact deployed Cloudflare WebSocket host',
    directives.get('connect-src')?.split(/\s+/).includes(counterOrigin), directives.get('connect-src') || '');
  check('index configures and loads the matching live-count client',
    indexHtml.includes(`name=\"freef1-viewer-counter-ws\" content=\"${counterEndpoint}\"`) &&
    /<script src=\"\/viewer-counter\.js\?v=[^\"]+\" defer><\/script>/.test(indexHtml));
  check('live-count client sends no application messages or periodic heartbeats',
    !/\.send\s*\(|setInterval\s*\(/.test(viewerCounterJs));
  check('site framing and media allow HTTPS embeds directly from hosts', directives.get('frame-src')?.includes('https:') && directives.get('media-src')?.includes('https:'));
  check('site fonts are self-hosted', directives.get('font-src')?.includes("'self'") && !/fonts\.(?:googleapis|gstatic)\.com/.test(sitePolicy));
  check('site does not enable external font stylesheets in CSP', !directives.get('style-src')?.includes('fonts.googleapis.com'));
  const helpHtml = fs.readFileSync(path.join(siteDir, 'help.html'), 'utf8');
  const helpJs = fs.readFileSync(path.join(siteDir, 'help.js'), 'utf8');
  const helpCacheRules = ['/help.html', '/help.css', '/help.js'].every(route =>
    headersText.includes(`${route}\n  Cache-Control: public, max-age=0, must-revalidate`));
  check('Help page declares the same-origin backend and loads local cached-busting assets',
    helpHtml.includes('https://f1admin.onrender.com') &&
    /<script src=\"\/help\.js\?v=[^\"]+\" defer><\/script>/.test(helpHtml) &&
    helpHtml.includes('/help.css?v=') && helpCacheRules);
  check('Help chat uses POST plus SSE and contains no polling or upload code',
    helpJs.includes('/api/help/ticket/messages') && helpJs.includes('/api/help/events') &&
    !/setInterval\s*\(|EventSource\s*\(/.test(helpJs) && !/input[^>]+type=\"file\"/i.test(helpHtml));

  const browserFiles = walk(siteDir).concat(walk(path.join(root, 'admin')))
    .filter(file => /\.(html|css|js)$/.test(file));
  const activeGoogleFontReferences = [];
  for (const file of browserFiles) {
    const raw = fs.readFileSync(file, 'utf8');
    const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--([\s\S]*?)-->/g, ' ');
    if (/href=["'][^"']*fonts\.googleapis\.com|@import\s+url\([^)]*fonts\.googleapis\.com|src:\s*url\([^)]*fonts\.googleapis\.com/i.test(noComments)) activeGoogleFontReferences.push(path.relative(root, file));
  }
  check('no served HTML/CSS actively requests Google Fonts', activeGoogleFontReferences.length === 0, activeGoogleFontReferences.join(', '));

  const brokenFonts = [];
  for (const cssFile of [path.join(siteDir, 'fonts.css'), path.join(root, 'admin', 'fonts.css')]) {
    if (!fs.existsSync(cssFile)) { brokenFonts.push(`${path.relative(root, cssFile)} missing`); continue; }
    const content = fs.readFileSync(cssFile, 'utf8');
    for (const match of content.matchAll(/src:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
      const url = match[1].split('?')[0];
      const baseDir = cssFile.startsWith(siteDir) ? siteDir : path.join(root, 'admin');
      const target = url.startsWith('/') ? path.join(baseDir, url.slice(1)) : path.resolve(path.dirname(cssFile), url);
      if (!fs.existsSync(target)) brokenFonts.push(`${path.relative(root, cssFile)} → ${url}`);
    }
  }
  check('all self-hosted font files exist', brokenFonts.length === 0, brokenFonts.join(', '));

  const brokenPreloads = [];
  const htmlFiles = walk(siteDir).concat(walk(path.join(root, 'admin'))).filter(file => file.endsWith('.html'));
  for (const file of htmlFiles) {
    const isAdmin = file.startsWith(path.join(root, 'admin'));
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/<link\b[^>]*rel=["']preload["'][^>]*>/gi)) {
      const href = (/href=["']([^"']+)["']/i.exec(match[0]) || [])[1];
      if (!href || /^https?:/i.test(href) || href.startsWith('data:')) continue;
      const localHref = href.split('?')[0];
      const target = isAdmin
        ? path.join(root, localHref.replace(/^\/?admin\//, 'admin/').replace(/^\//, ''))
        : path.join(siteDir, localHref.replace(/^\//, ''));
      if (!fs.existsSync(target)) brokenPreloads.push(`${path.relative(root, file)} → ${href}`);
    }
  }
  check('all local preload references resolve to files', brokenPreloads.length === 0, brokenPreloads.join(', '));

  const siteJs = fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8') + viewerCounterJs + helpJs;
  const retired = ['/api/visitors/', '/api/analytics', '/api/events', '/api/stream/ticket', 'sky-uk-2', 'sky-sports-f1', 'flyembed.click/embed/44.php'];
  const retiredFound = retired.filter(value => siteJs.includes(value));
  check('front-end bundle has no retired tracking or removed stream APIs', retiredFound.length === 0, retiredFound.join(', '));

  let failed = 0;
  for (const item of checks) {
    if (!item.pass) failed++;
    console.log(` ${item.pass ? ' ok ' : 'FAIL'}   ${item.label}${item.pass || !item.detail ? '' : `  →  ${item.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error('csp-check failed:', error.message);
  process.exit(1);
});
