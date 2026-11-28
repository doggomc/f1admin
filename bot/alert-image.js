'use strict';

/* Render locally: no image-service requests and no video traffic. */
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { PNG } = require('pngjs');
const { constants } = require('zlib');
const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const BRAND_FONT = path.join(__dirname, '..', 'assets', 'fonts', 'Archivo-Bold.ttf');
const STATES = Object.freeze({
  start: { title: 'STARTING SOON', accent: '#ffb020', subtitle: 'GET READY FOR THE SESSION' },
  live:  { title: 'LIVE NOW', accent: '#41e68b', subtitle: 'YOUR FRONT ROW SEAT AWAITS' },
  end:   { title: 'SESSION ENDED', accent: '#ff5650', subtitle: 'THE CHEQUERED FLAG IS OUT' },
});
function escapeXml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c])); }
function short(value, n) { const s = String(value || '').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; }
function alertSvg(event, session, state, peakViewers = null) {
  if (!STATES[state]) throw new Error('Unknown test alert state');
  const live = state === 'live';
  const race = escapeXml(short(event.name, 34));
  const sessionName = escapeXml(short(session.name, 32));
  const location = escapeXml(short([event.locality, event.country].filter(Boolean).join(', '), 45));
  const footerLocation = escapeXml(short(event.locality || 'the circuit', 30));
  const round = escapeXml(String(event.round || '—'));
  const eventFont = String(event.name || '').length > 25 ? 44 : 57;
  const peak = Number.isSafeInteger(peakViewers) && peakViewers >= 0 && peakViewers <= 1_000_000 ? peakViewers.toLocaleString('en-US') : '—';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="bg" cx="50%" cy="0%" r="85%"><stop stop-color="#252127"/><stop offset=".65" stop-color="#0e0f12"/><stop offset="1" stop-color="#0b0c0f"/></radialGradient><radialGradient id="card" cx="50%" cy="0%" r="80%"><stop stop-color="#292023"/><stop offset=".72" stop-color="#18191d"/><stop offset="1" stop-color="#18191d"/></radialGradient><filter id="shadow" x="-25%" y="-25%" width="150%" height="160%"><feGaussianBlur stdDeviation="22"/></filter><clipPath id="clip"><rect width="1200" height="630" rx="26"/></clipPath></defs>
<g clip-path="url(#clip)"><rect width="1200" height="630" fill="url(#bg)"/>
<rect x="91" y="70" width="1018" height="520" rx="28" fill="#000" opacity=".45" filter="url(#shadow)"/>
<rect x="84" y="54" width="1032" height="522" rx="24" fill="url(#card)" stroke="#ffffff" stroke-opacity=".12"/><path d="M108 54h984a24 24 0 0 1 24 24" fill="none" stroke="#fff" stroke-opacity=".07"/>
${state === 'end' ? `<rect x="130" y="262" width="223" height="38" rx="19" fill="#ef4444" fill-opacity=".12" stroke="#ef4444" stroke-opacity=".35"/><circle cx="151" cy="281" r="5" fill="#f05252"/><text x="166" y="287" fill="#fca5a5" font-family="DejaVu Sans" font-size="14" font-weight="700">Session ended</text>
` : `<rect x="130" y="262" width="223" height="38" rx="19" fill="${live ? '#22c55e' : '#f59e0b'}" fill-opacity=".12" stroke="${live ? '#22c55e' : '#f59e0b'}" stroke-opacity=".35"/><circle cx="151" cy="281" r="5" fill="${live ? '#4ade80' : '#f59e0b'}"/><text x="166" y="287" fill="${live ? '#86efac' : '#fcd34d'}" font-family="DejaVu Sans" font-size="14" font-weight="700">${live ? 'Live now' : 'Starting soon'}</text>
`}
<text x="130" y="166" fill="#fff" font-family="Archivo" font-size="${eventFont}" font-weight="700" letter-spacing="-1">${race}</text>
<text x="132" y="211" fill="#e4e5e9" font-family="DejaVu Sans" font-size="25" font-weight="700">${sessionName}</text>
<text x="132" y="242" fill="#a9abaf" font-family="DejaVu Sans" font-size="16" font-weight="700">Round ${round}  ·  ${location}</text>
<path d="M130 328H1070" stroke="#fff" stroke-opacity=".09"/>
<rect x="130" y="352" width="940" height="110" rx="15" fill="#212227" stroke="#fff" stroke-opacity=".09"/>
${state === 'end' ? `<rect x="153" y="378" width="56" height="56" rx="14" fill="#e10600" fill-opacity=".14"/><svg x="169" y="394" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff7770" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
<text x="230" y="398" fill="#f4f4f6" font-family="DejaVu Sans" font-size="19" font-weight="700">Peak viewers</text><text x="230" y="426" fill="#a9abaf" font-family="DejaVu Sans" font-size="14" font-weight="700">Concurrent viewers in the live cockpit</text>
<text x="1036" y="419" text-anchor="end" fill="#fff" font-family="Archivo" font-size="43" font-weight="700">${peak}</text>
` : `<rect x="153" y="378" width="56" height="56" rx="14" fill="${live ? '#22c55e' : '#f59e0b'}" fill-opacity=".13"/>
<circle cx="181" cy="406" r="10" fill="none" stroke="${live ? '#86efac' : '#fcd34d'}" stroke-width="2"/><path d="${live ? 'M178 401l8 5-8 5z' : 'M181 400v6l4 3'}" fill="${live ? '#86efac' : 'none'}" stroke="${live ? '#86efac' : '#fcd34d'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<text x="230" y="398" fill="#f4f4f6" font-family="DejaVu Sans" font-size="19" font-weight="700">${live ? 'The session is live' : 'The session is starting soon'}</text><text x="230" y="426" fill="#a9abaf" font-family="DejaVu Sans" font-size="14" font-weight="700">${live ? 'Head to the cockpit to watch.' : 'Get ready to join us in the cockpit.'}</text>
`}
<path d="M130 492H1070" stroke="#fff" stroke-opacity=".08"/>
<rect x="130" y="514" width="28" height="28" rx="8" fill="#d70600"/><svg x="136" y="520" width="16" height="16" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg><text x="170" y="534" fill="#dddfe4" font-family="Archivo" font-size="19" font-weight="700">FreeF1</text>
<text x="1070" y="533" text-anchor="end" fill="#85898f" font-family="DejaVu Sans" font-size="13" font-weight="700">${state === 'end' ? 'The chequered flag is out' : live ? `Live from ${footerLocation}` : 'See you in the cockpit'}  ·  freef1-live.vercel.app</text>
</g></svg>`;
}
function alertsPanelSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="bg" cx="50%" cy="0%" r="85%"><stop stop-color="#252127"/><stop offset=".65" stop-color="#0e0f12"/><stop offset="1" stop-color="#0b0c0f"/></radialGradient><radialGradient id="card" cx="50%" cy="0%" r="80%"><stop stop-color="#292023"/><stop offset=".72" stop-color="#18191d"/><stop offset="1" stop-color="#18191d"/></radialGradient><filter id="shadow" x="-25%" y="-25%" width="150%" height="160%"><feGaussianBlur stdDeviation="22"/></filter><clipPath id="clip"><rect width="1200" height="630" rx="26"/></clipPath></defs>
<g clip-path="url(#clip)"><rect width="1200" height="630" fill="url(#bg)"/>
<rect x="91" y="70" width="1018" height="520" rx="28" fill="#000" opacity=".45" filter="url(#shadow)"/>
<rect x="84" y="54" width="1032" height="522" rx="24" fill="url(#card)" stroke="#ffffff" stroke-opacity=".12"/><path d="M108 54h984a24 24 0 0 1 24 24" fill="none" stroke="#fff" stroke-opacity=".07"/>
<rect x="130" y="262" width="205" height="38" rx="19" fill="#ef4444" fill-opacity=".12" stroke="#ef4444" stroke-opacity=".35"/><circle cx="151" cy="281" r="5" fill="#f05252"/><text x="166" y="287" fill="#fca5a5" font-family="DejaVu Sans" font-size="14" font-weight="700">Stay in the loop</text>
<text x="130" y="166" fill="#fff" font-family="Archivo" font-size="57" font-weight="700" letter-spacing="-1">Stream Alerts</text>
<text x="132" y="211" fill="#e4e5e9" font-family="DejaVu Sans" font-size="25" font-weight="700">Never miss a session.</text>
<text x="132" y="242" fill="#a9abaf" font-family="DejaVu Sans" font-size="16" font-weight="700">Get notified when the action begins.</text>
<path d="M130 328H1070" stroke="#fff" stroke-opacity=".09"/>
<rect x="130" y="352" width="940" height="110" rx="15" fill="#212227" stroke="#fff" stroke-opacity=".09"/>
<rect x="153" y="378" width="56" height="56" rx="14" fill="#e10600" fill-opacity=".14"/><svg x="169" y="394" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff7770" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
<text x="230" y="398" fill="#f4f4f6" font-family="DejaVu Sans" font-size="19" font-weight="700">Choose your notifications</text><text x="230" y="426" fill="#a9abaf" font-family="DejaVu Sans" font-size="14" font-weight="700">Use the button below to opt in or out.</text>
<path d="M130 492H1070" stroke="#fff" stroke-opacity=".08"/>
<rect x="130" y="514" width="28" height="28" rx="8" fill="#d70600"/><svg x="136" y="520" width="16" height="16" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg><text x="170" y="534" fill="#dddfe4" font-family="Archivo" font-size="19" font-weight="700">FreeF1</text>
<text x="1070" y="533" text-anchor="end" fill="#85898f" font-family="DejaVu Sans" font-size="13" font-weight="700">Never miss lights out  ·  freef1-live.vercel.app</text>
</g></svg>`;
}
function websiteSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="280" viewBox="0 0 720 280">
  <rect width="720" height="280" rx="20" fill="#101216"/>
  <rect width="720" height="5" fill="#e10600"/>
  <rect x="43" y="38" width="56" height="56" rx="14" fill="#d00600"/>
  <svg x="54" y="49" width="34" height="34" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg>
  <text x="114" y="78" fill="#f7f8fa" font-family="Archivo, sans-serif" font-size="37" font-weight="700">FreeF1</text>
  <text x="44" y="153" fill="#f7f8fa" font-family="DejaVu Sans, sans-serif" font-size="25" font-weight="700">One Cockpit. Every Session.</text>
  <text x="44" y="190" fill="#b5b9c1" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700">All for Free.</text>
  <path d="M44 219H676" stroke="#303238"/>
  <text x="44" y="251" fill="#9298a4" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700">freef1-live.vercel.app</text>
  </svg>`;
}

function renderPng(svg) {
  const source = new Resvg(svg, { font: { fontFiles: [FONT, BRAND_FONT], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
  // PNG re-encoding is lossless: only filtering/DEFLATE settings change.
  return PNG.sync.write(PNG.sync.read(source), { filterType: -1, deflateLevel: 9, deflateStrategy: constants.Z_DEFAULT_STRATEGY });
}
async function renderAlertImage(event, session, state, peakViewers = null) { return renderPng(alertSvg(event, session, state, peakViewers)); }
let panelImage;
async function renderAlertsPanelImage() { return panelImage || (panelImage = renderPng(alertsPanelSvg())); }
let websiteImage;
async function renderWebsiteImage() { return websiteImage || (websiteImage = renderPng(websiteSvg())); }
module.exports = { alertSvg, renderAlertImage, alertsPanelSvg, renderAlertsPanelImage, websiteSvg, renderWebsiteImage, STATES };
