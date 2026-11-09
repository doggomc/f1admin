'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const candidates = process.env.SITE_DIR ? [process.env.SITE_DIR] : ['../vercelf1', '../netlifyf1'];
const site = candidates.map(dir => path.resolve(__dirname, '..', dir)).find(dir => fs.existsSync(path.join(dir, 'package.json')));
if (!site) { console.error('Public site repository not found. Set SITE_DIR to its directory.'); process.exit(1); }
const result = spawnSync('npm', ['--prefix', site, 'run', 'check'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
