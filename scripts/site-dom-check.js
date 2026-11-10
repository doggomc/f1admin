#!/usr/bin/env node
'use strict';
/* The static site now uses TypeScript/Vite modules rather than root-level app.js.
   Run its maintained, current site configuration, source, routing and interaction tests. */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'vercelf1');
const result = spawnSync('npm', ['run','test','--','tests/site-config.test.ts','tests/managed-sources.test.ts','tests/source-groups.test.ts','tests/clean-urls.test.ts','tests/interaction-guard.test.ts','tests/relay-control.test.ts'], {cwd:siteDir,stdio:'inherit',env:process.env});
if (result.error) { console.error('Frontend test runner could not start:', result.error.message); process.exit(1); }
if (result.status !== 0) process.exit(result.status || 1);
console.log('Current Vite site configuration, sources, routing and interaction checks passed.');
