#!/usr/bin/env node
'use strict';

/* Motion regression gate.

   "Smooth on every device" is not something a single measurement can promise —
   but the handful of mistakes that make a site stutter are all detectable in the
   source, and they are exactly the ones that creep back in:

     1. animating a layout property (width/height/top/margin/padding…) — the
        browser must re-lay-out the page on every frame;
     2. `transition: all` — silently animates whatever gets added later;
     3. easing `backdrop-filter` — not compositable: the browser re-blurs the
        whole element width on every frame of the ramp;
     4. leaving `will-change: transform` on everything — one composited layer per
        element, each holding a full-size image in GPU memory on phones;
     5. reading layout after writing style inside a scroll/rAF handler — forces a
        synchronous re-layout on top of every frame;
     6. reading layout inside a perpetual animation loop (the old ticker read
        `scrollWidth` every frame, forever);
     7. an implied but missing background guard — an animating loop that keeps
        running in a hidden tab burns battery for nothing;
     8. orphaned `@keyframes` — dead animation code that still ships (this is how
        a `height`-animating equaliser sat unused in both stylesheets).

   Runs against both repos: the site checkout (SITE_DIR, default ../../netlifyf1)
   and this repo's own admin dashboard. */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const siteDir = process.env.SITE_DIR || path.resolve(root, '..', 'netlifyf1');

const checks = [];
const check = (label, pass, detail = '') => checks.push({ label, pass: Boolean(pass), detail });

const LAYOUT_PROPS = new Set([
  'top', 'left', 'right', 'bottom', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-left', 'margin-right', 'margin-bottom',
  'padding', 'padding-top', 'padding-left', 'padding-right', 'padding-bottom',
  'font-size', 'line-height', 'inset', 'grid-template-columns', 'grid-template-rows', 'flex-basis'
]);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

function keyframesOf(css) {
  const out = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const body = css.slice(start, i - 1);
    const props = [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map(x => x[1]))];
    out.push({ name: m[1], props, body });
  }
  return out;
}

function auditStylesheet(label, cssPath) {
  if (!fs.existsSync(cssPath)) { check(`${label}: stylesheet found`, false, cssPath); return; }
  const css = stripComments(fs.readFileSync(cssPath, 'utf8'));

  // 1. no keyframe animates layout
  const offenders = [];
  for (const kf of keyframesOf(css)) {
    const bad = kf.props.filter(p => LAYOUT_PROPS.has(p));
    if (bad.length) offenders.push(`${kf.name} animates ${bad.join(', ')}`);
  }
  check(`${label}: no @keyframes animates a layout property`, offenders.length === 0, offenders.join(' | '));

  // 2. no transition: all
  const allTransitions = [...css.matchAll(/transition:\s*all\b/g)].length;
  check(`${label}: no "transition: all"`, allTransitions === 0, `${allTransitions} occurrence(s)`);

  // 3. backdrop-filter ramps stay short
  const ramps = [];
  for (const m of css.matchAll(/transition:\s*([^;}]+)/g)) {
    for (const part of m[1].split(',')) {
      if (!/backdrop-filter/.test(part)) continue;
      const seconds = /([\d.]+)s/.exec(part);
      const ms = seconds ? parseFloat(seconds[1]) * 1000 : 0;
      if (ms > 250) ramps.push(`${ms}ms`);
    }
  }
  check(`${label}: backdrop-filter ramps are ≤ 250ms`, ramps.length === 0, ramps.join(', '));

  // 4. will-change is deliberate, not sprayed
  const willChange = [...css.matchAll(/([^{}]+)\{([^}]*will-change:\s*(?!auto)([a-z-]+)[^}]*)\}/g)]
    .map(m => ({ selector: m[1].trim().split('\n').pop().trim(), prop: m[3] }));
  const allowedSelectors = ['.hero-layer', '.ticker-track'];
  const strays = willChange.filter(w => !allowedSelectors.some(a => w.selector.includes(a)));
  check(`${label}: will-change only on the constantly-animating layers`, strays.length === 0,
    strays.map(s => `${s.selector} → ${s.prop}`).join(' | '));

  // 4b. and it is dropped where the animation does not run
  check(`${label}: lite-motion releases the hero layer hint`,
    !/\.hero-layer/.test(css) || /html\.lite-motion[^{]*\{\s*will-change:\s*auto/.test(css),
    'expected an html.lite-motion { will-change: auto } override');

  // 8. no orphaned keyframes
  const orphans = keyframesOf(css)
    .map(kf => kf.name)
    .filter(name => !new RegExp(`animation[^;{}]*\\b${name}\\b`).test(css));
  check(`${label}: every @keyframes is actually used`, orphans.length === 0, orphans.join(', '));
}

function auditScript(label, jsPath, { scrollHandler, tickerLoop, canvasLoop }) {
  if (!fs.existsSync(jsPath)) { check(`${label}: script found`, false, jsPath); return; }
  const src = fs.readFileSync(jsPath, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ');

  // 5. the scroll handler must measure before it writes
  if (scrollHandler) {
    const at = code.indexOf('function onScroll');
    const body = at === -1 ? '' : code.slice(at, code.indexOf('addEventListener(\'scroll\'', at));
    const lastRead = body.lastIndexOf('getBoundingClientRect');
    const firstWrite = body.indexOf('.style.');
    check(`${label}: scroll handler measures before it writes`,
      at !== -1 && lastRead !== -1 && firstWrite !== -1 && lastRead < firstWrite,
      at === -1 ? 'function onScroll not found' : `last layout read at ${lastRead}, first style write at ${firstWrite}`);
  }

  // 6. no layout reads inside a perpetual animation loop. The current site
  // ticker is CSS-only so it has no JS frame loop to inspect.
  if (tickerLoop === false) {
    const start = code.indexOf('function initTicker');
    const end = start === -1 ? -1 : code.indexOf('const navEl', start);
    const body = start !== -1 && end !== -1 ? code.slice(start, end) : '';
    check(`${label}: ticker uses no JS frame loop or layout reads`, Boolean(body) &&
      !/requestAnimationFrame|scrollWidth|offsetWidth|getBoundingClientRect/.test(body), 'expected CSS-only ticker animation');
  } else if (tickerLoop) {
    const at = code.indexOf(tickerLoop);
    const body = at === -1 ? '' : code.slice(at, code.indexOf('requestAnimationFrame(tick)', at + 1));
    const reads = ['scrollWidth', 'offsetWidth', 'clientWidth', 'getBoundingClientRect', 'offsetHeight', 'clientHeight']
      .filter(prop => body.includes(prop));
    check(`${label}: ticker frame loop performs no layout reads`, at !== -1 && reads.length === 0,
      at === -1 ? 'tick loop not found' : `reads: ${reads.join(', ')}`);
  }

  // 7. perpetual loops stop when the tab is hidden
  if (canvasLoop) {
    const at = code.indexOf(canvasLoop);
    const body = at === -1 ? '' : code.slice(at, at + 4000);
    check(`${label}: canvas loop pauses in a hidden tab`, /document\.hidden/.test(body), '');
    check(`${label}: canvas loop is frame-rate capped`, /frameInterval|targetFps/.test(body), '');
  }

  // prefers-reduced-motion is honoured in script
  check(`${label}: scripts honour reduced motion`, /prefers-reduced-motion/.test(code), '');
}

auditStylesheet('site', path.join(siteDir, 'app.css'));
auditScript('site', path.join(siteDir, 'app.js'), {
  scrollHandler: true,
  tickerLoop: false,
  canvasLoop: 'function initSpeedCanvas'
});

auditStylesheet('admin', path.join(root, 'admin', 'admin.css'));
auditScript('admin', path.join(root, 'admin', 'admin.js'), {});

/* Decoration must never eat a tap, and it must not be drawn where it collides
   with the hero call to action (measured overlapping at every width from 641px
   to 940px before this). */
{
  const siteCss = fs.readFileSync(path.join(siteDir, 'app.css'), 'utf8');
  const siteJs = fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8');
  const tickerBase = /\.ticker-track\s*\{([^}]*)\}/.exec(siteCss)?.[1] || '';
  const liteTicker = /html\.lite-motion\s+\.ticker-track\s*\{([^}]*)\}/.exec(siteCss)?.[1] || '';
  check('site: telemetry ribbon stays animated on small and data-saver devices',
    /animation:\s*slide\s+34s\s+linear\s+infinite/.test(tickerBase) &&
      !/animation(?:-name)?\s*:\s*none/.test(liteTicker),
    'lite-motion must not disable the CSS ticker');

  const reducedTickerIndex = siteCss.lastIndexOf('.ticker-track, .brand-mark::after, .pill.live .dot');
  const reducedMotionIndex = reducedTickerIndex < 0 ? -1 :
    siteCss.slice(0, reducedTickerIndex).lastIndexOf('@media(prefers-reduced-motion:reduce)');
  const reducedMotionCss = reducedMotionIndex < 0 ? '' :
    siteCss.slice(reducedMotionIndex, reducedTickerIndex + 180);
  check('site: the ticker still respects reduced-motion preferences',
    /\.ticker-track[^{}]*\{[^}]*animation:\s*none\s*!important/.test(reducedMotionCss),
    'prefers-reduced-motion must stop the continuous ticker');

  const liteScanlines = /html\.lite-motion\s+\.scanlines\s*\{([^}]*)\}/.exec(siteCss)?.[1] || '';
  check('site: scanlines remain visible at a reduced visual intensity on lite devices',
    /opacity:\s*\.2/.test(liteScanlines) && !/display:\s*none/.test(liteScanlines),
    'the scanline overlay should remain visible without the grain layer');
  check('site: lite devices skip the decorative speed canvas',
    /html\.lite-motion #speedCanvas\s*\{[^}]*display:\s*none/.test(siteCss) &&
      /if\s*\(!canvas\s*\|\|\s*liteMotion\)\s*return/.test(siteJs),
    'do not keep the canvas animation running on low-motion devices');

  const nextPill = /\.pill\.next\s*\{([^}]*)\}/.exec(siteCss)?.[1] || '';
  check('site: the next-session pill wraps instead of clipping',
    /white-space:\s*normal/.test(nextPill) && /overflow-wrap:\s*anywhere/.test(nextPill) &&
      !/overflow:\s*hidden/.test(nextPill),
    'the countdown pill must remain readable when it wraps');
  check('site: hero metadata stacks the countdown on narrow screens',
    /\.hero-meta\s*\{[^}]*display:\s*grid/.test(siteCss) &&
      /\.hero-meta \.pill\.next\s*\{[^}]*width:\s*100%/.test(siteCss),
    'the countdown should have the full hero width on phones');

  const resultsFade = /@keyframes resultsFadeIn\s*\{([\s\S]*?)\n\}/.exec(siteCss)?.[1] || '';
  check('site: Session Results enter with an opacity-only fade',
    /#sessionsResultsLoading\.results-fade-in/.test(siteCss) &&
      /#sessionsResults\.results-fade-in/.test(siteCss) &&
      /from\s*\{[^}]*opacity:\s*0/.test(resultsFade) &&
      /to\s*\{[^}]*opacity:\s*1/.test(resultsFade) && !/transform\s*:/.test(resultsFade) &&
      /fadeInSessionContent\(sRes\)/.test(siteJs),
    'loading state and loaded results should use a compositor-friendly fade');
  check('site: stale Session Results requests cannot overwrite newer selections',
    /requestId !== sessionResultsRequest/.test(siteJs),
    'ignore a slower response after the user changes the race/session');

  check('site: shared content swaps fade out and back in using opacity only',
    /\.content-fade-target\s*\{[^}]*transition:\s*opacity\s+\.18s/.test(siteCss) &&
      /\.content-fade-target\.content-fading-out\s*\{[^}]*opacity:\s*0/.test(siteCss) &&
      /function fadeSwapContent\([\s\S]*?content-fading-out/.test(siteJs) &&
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]{0,260}?\.content-fade-target\s*\{[^}]*transition:\s*none!important/.test(siteCss) &&
      /reduceMotion/.test(siteJs),
    'shared data transitions should not animate layout and must honor reduced motion');
  check('site: Grid and driver career updates crossfade',
    /fadeSwapContent\(el,/.test(siteJs) && /fadeSwapContent\(box,/.test(siteJs),
    'driver cards and career telemetry should use the common fade swap');
  check('site: Race Times crossfades on Grand Prix and timezone changes',
    /fadeSwapContent\(raceTimesList,/.test(siteJs) && /fadeSwapContent\(raceTimesTimezone,/.test(siteJs),
    'both session rows and the timezone note should transition together');
  check('site: Radio and Race Control data crossfade on session changes',
    /fadeSwapContent\(radioRcRadioList,/.test(siteJs) && /fadeSwapContent\(radioRcRcList,/.test(siteJs),
    'both telemetry lists should transition when a session is selected');
  check('site: live telemetry polling skips repeat fades',
    /radioRcSelectSession\(sessionKey, \{ animate: false \}\)/.test(siteJs),
    'only user-driven selection changes should animate refreshed lists');

  check('site: the scroll hint ignores pointer events',
    /\.scroll-hint\s*\{[^}]*pointer-events:\s*none/.test(siteCss),
    '.scroll-hint must not intercept clicks meant for the CTA');
  check('site: the scroll hint is hidden where the hero stacks',
    /@media\(max-width:\s*960px\)[\s\S]{0,300}?\.scroll-hint\s*\{[^}]*display:\s*none/.test(siteCss),
    'no ≤960px rule hiding .scroll-hint');

  // beertjie is a standalone page with its own <style>; its nav carries a
  // decorative pill next to a real button and used to overflow a phone.
  const bee = fs.readFileSync(path.join(siteDir, 'beertjie.html'), 'utf8');
  check('beertjie: the decorative nav pill is dropped on phones',
    /@media\s*\(max-width:\s*640px\)[\s\S]{0,400}?\.nav-right \.pill\.secret\s*\{[^}]*display:\s*none/.test(bee),
    'the Paddock Easter Egg pill must not push the Return to Cockpit button off screen');
  check('beertjie: the nav brand text is dropped on small phones',
    /@media\s*\(max-width:\s*430px\)[\s\S]{0,300}?\.brand-text\s*\{[^}]*display:\s*none/.test(bee),
    'no ≤430px rule hiding beertjie brand text');
}

/* The dashboard's sticky nav is styled by .nav.stuck in admin.css; the class is
   useless if no script ever applies it (it was missing once, and every panel
   scrolled visibly through the bar on a phone). */
{
  const adminJs = fs.readFileSync(path.join(root, 'admin', 'admin.js'), 'utf8');
  const adminCss = fs.readFileSync(path.join(root, 'admin', 'admin.css'), 'utf8');
  check('admin: the sticky nav class is applied on scroll',
    /classList\.toggle\('stuck'/.test(adminJs) && adminCss.includes('.nav.stuck'),
    'admin.js must toggle .stuck and admin.css must style it');
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.label}${c.pass || !c.detail ? '' : `  →  ${c.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
