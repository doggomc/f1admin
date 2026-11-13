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
const sourceDir = path.resolve(process.env.SITE_DIR || path.join(root, '..', 'netlifyf1'));
const modern = fs.existsSync(path.join(sourceDir, 'src/app.ts'));
const siteDir = modern ? path.join(sourceDir, 'dist') : sourceDir;
const browserSource = name => fs.readFileSync(path.join(sourceDir, modern ? `src/${name}.ts` : `${name}.js`), 'utf8');
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

  /* The counter is part of the public header on every page: the logo sits left, the
     menu and the open-page count sit right. Each page declares the deployed endpoint
     and its entry imports the client, so a schedule page shows a real count too. */
  const viewerCounterJs = browserSource('viewer-counter');
  const counterPages = ['index.html', 'cockpit.html', 'schedule.html', 'standings.html', 'drivers.html', 'teams.html', 'live-timing.html'];
  const entryFor = { 'index.html': 'src/pages/home.ts', 'cockpit.html': 'src/main.ts' };
  const wired = counterPages.filter(page => {
    const file = path.join(siteDir, page);
    if (!fs.existsSync(file)) return false;
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes('name="freef1-viewer-counter-ws" content="' + counterEndpoint + '"')) return false;
    if (!modern) return /viewer-counter\.js/.test(html);
    /* siteDir is dist/ in modern mode; the page entries are source files. */
    const entry = entryFor[page] || 'src/pages/' + page.replace('.html', '.ts');
    const entryFile = path.join(sourceDir, entry);
    return fs.existsSync(entryFile) && fs.readFileSync(entryFile, 'utf8').includes('viewer-counter');
  });
  check('every page wires the live-count client to the deployed endpoint',
    wired.length === counterPages.length, 'wired on ' + wired.length + '/' + counterPages.length);
  check('live-count sends only bounded page context and no periodic heartbeats',
    !/setInterval\s*\(/.test(viewerCounterJs) && /type:\s*'page'/.test(viewerCounterJs) && /payload\.pages === true/.test(viewerCounterJs));
  check('site framing and media allow HTTPS embeds directly from hosts', directives.get('frame-src')?.includes('https:') && directives.get('media-src')?.includes('https:'));
  check('site fonts are self-hosted', directives.get('font-src')?.includes("'self'") && !/fonts\.(?:googleapis|gstatic)\.com/.test(sitePolicy));
  check('site does not enable external font stylesheets in CSP', !directives.get('style-src')?.includes('fonts.googleapis.com'));
  const helpHtml = fs.readFileSync(path.join(siteDir, 'help.html'), 'utf8');
  const helpJs = browserSource('help');
  const helpCacheRules = modern
    ? headersText.includes('/*.html\n  Cache-Control: public, max-age=60, must-revalidate') &&
      headersText.includes('/bundles/*\n  Cache-Control: public, max-age=31536000, immutable')
    : ['/help.html', '/help.css', '/help.js'].every(route => headersText.includes(`${route}\n  Cache-Control: public, max-age=0, must-revalidate`));
  check('Help page uses local build assets with safe HTML and versioned-asset caching',
    helpHtml.includes('https://f1admin.onrender.com') &&
    (modern ? /<script type="module"[^>]+src="\/bundles\//.test(helpHtml) && /href="\/bundles\/help-[^"]+\.css"/.test(helpHtml)
      : helpHtml.includes('/help.js?v=') && helpHtml.includes('/help.css?v=')) && helpCacheRules);
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
  /* Fonts live in the repo-root assets/ folder; the admin stylesheet references
     them root-relative (/assets/fonts/...). */
  const assetDirs = [path.join(root, 'assets'), siteDir, path.join(root, 'admin')];
  for (const cssFile of [path.join(siteDir, 'fonts.css'), path.join(root, 'admin', 'fonts.css')]) {
    if (!fs.existsSync(cssFile)) { brokenFonts.push(`${path.relative(root, cssFile)} missing`); continue; }
    const content = fs.readFileSync(cssFile, 'utf8');
    for (const match of content.matchAll(/src:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
      const url = match[1].split('?')[0];
      const baseDir = cssFile.startsWith(siteDir) ? siteDir : path.join(root, 'admin');
      const target = url.startsWith('/')
        ? assetDirs.map(dir => path.join(dir, url.slice(1))).find(candidate => fs.existsSync(candidate)) || path.join(baseDir, url.slice(1))
        : path.resolve(path.dirname(cssFile), url);
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

  const siteJs = browserSource('app') + viewerCounterJs + helpJs;
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
