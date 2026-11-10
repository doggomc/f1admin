#!/usr/bin/env node
'use strict';
// Behavioral Race Times test for the current Vite/TypeScript cockpit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const siteDir = process.env.SITE_DIR || path.resolve(__dirname, '..', '..', 'vercelf1');
const esbuild = require(require.resolve('esbuild', { paths:[siteDir] }));
const js = esbuild.buildSync({ entryPoints:[path.join(siteDir,'src/features/race-times.ts')], bundle:true, write:false, format:'iife', globalName:'RaceTimesTest', platform:'browser' }).outputFiles[0].text;
const dom = new JSDOM(fs.readFileSync(path.join(siteDir,'cockpit.html'),'utf8'), {runScripts:'outside-only',pretendToBeVisual:true,url:'https://freef1-live.vercel.app/cockpit'});
const { window } = dom; window.eval(js); const $ = id => window.document.getElementById(id);
const now = Date.parse('2026-10-01T12:00:00Z'); window.Date.now = () => now;
const event = (slug, offset, tz) => ({slug,round:1,name:slug,locality:slug,tz,sessions:[{slug:'fp1',name:'Practice 1',ts:now+offset},{slug:'race',name:'Race',ts:now+offset+86400000}]});
const store = new Map();
window.RaceTimesTest.init({store:{get:k=>store.get(k),set:(k,v)=>store.set(k,v)},schedule:[event('finished',-10*86400000,'UTC'),event('upcoming',86400000,'Asia/Kuala_Lumpur')],fadeSwapContent:(_el,fn)=>fn(),escapeHtml:value=>String(value),openModal:el=>el.classList.add('open'),closeModal:el=>el.classList.remove('open')});
$('raceTimesBtn').click(); assert($('raceTimesOverlay').classList.contains('open')); assert.equal($('raceTimesGp').options.length,1); assert.equal($('raceTimesGp').value,'upcoming'); assert.equal($('raceTimesList').querySelectorAll('.rt-row').length,2);
$('raceTimesMode').querySelector('[data-time-mode="track"]').click(); assert.match($('raceTimesTimezone').textContent,/Asia\/Kuala_Lumpur/); assert.equal(store.get('freef1_race_times_mode'),'track'); $('raceTimesClose').click(); assert(!$('raceTimesOverlay').classList.contains('open')); dom.window.close(); console.log('Race Times modal, future schedule and timezone controls passed');
