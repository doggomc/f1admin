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
function alertSvg(event, session, state) {
  const style = STATES[state];
  if (!style) throw new Error('Unknown test alert state');
  const race = escapeXml(short(event.name, 34));
  const sessionName = escapeXml(short(session.name, 32));
  const location = escapeXml(short([event.locality, event.country].filter(Boolean).join(', '), 45));
  const round = escapeXml(String(event.round || '—').padStart(2, '0'));
  const eventFont = String(event.name || '').length > 25 ? 48 : 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1c2027"/><stop offset="1" stop-color="#090b0e"/></linearGradient><linearGradient id="red" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#ff3b32"/><stop offset="1" stop-color="#a80000"/></linearGradient><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e10600"/><stop offset="1" stop-color="#8b0400"/></linearGradient><clipPath id="clip"><rect width="1200" height="630" rx="28"/></clipPath></defs>
  <g clip-path="url(#clip)"><rect width="1200" height="630" fill="url(#bg)"/>
  <path d="M750 -40 L1220 -40 L945 670 L475 670 Z" fill="#ffffff" opacity=".022"/><path d="M905 -40 L1040 -40 L765 670 L630 670 Z" fill="#ffffff" opacity=".025"/>
  <path d="M1030 0 L1200 0 L1200 630 L785 630 Z" fill="#e10600" opacity=".065"/>
  <path d="M0 0 H1200 V7 H0 Z" fill="url(#red)"/>
  <rect x="74" y="75" width="78" height="78" rx="20" fill="url(#brand)"/>
  <svg x="90" y="91" width="46" height="46" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg>
  <text x="171" y="128" fill="#f8f8fa" font-family="Archivo, sans-serif" font-size="40" font-weight="700" letter-spacing="-.4">FreeF1</text>
  <text x="1124" y="118" fill="#8f949e" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="700" letter-spacing="3">RACE CONTROL</text>
  <rect x="74" y="195" width="310" height="48" rx="24" fill="${style.accent}" opacity=".12"/><circle cx="101" cy="219" r="6" fill="${style.accent}"/><text x="120" y="226" fill="${style.accent}" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="800" letter-spacing="2">${style.title}</text>
  <text x="74" y="326" fill="#f7f8fa" font-family="DejaVu Sans, sans-serif" font-size="${eventFont}" font-weight="800" letter-spacing="-1.6">${race}</text>
  <text x="76" y="386" fill="#bec2cb" font-family="DejaVu Sans, sans-serif" font-size="29" font-weight="600">${sessionName}</text>
  <path d="M76 427H1124" stroke="#ffffff" stroke-opacity=".1"/>
  <text x="76" y="484" fill="#838a95" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">ROUND ${round}  ·  ${location}</text>
  <text x="76" y="555" fill="#f7f8fa" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">${style.subtitle}</text>
  <text x="1124" y="555" fill="#8e949e" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="600">freef1-live.vercel.app</text>
  </g></svg>`;
}
function alertsPanelSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1c2027"/><stop offset="1" stop-color="#090b0e"/></linearGradient><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e10600"/><stop offset="1" stop-color="#8b0400"/></linearGradient><linearGradient id="red" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#ff3b32"/><stop offset="1" stop-color="#a80000"/></linearGradient><clipPath id="clip"><rect width="1200" height="630" rx="28"/></clipPath></defs>
  <g clip-path="url(#clip)"><rect width="1200" height="630" fill="url(#bg)"/><path d="M750 -40 L1220 -40 L945 670 L475 670 Z" fill="#fff" opacity=".022"/><path d="M905 -40 L1040 -40 L765 670 L630 670 Z" fill="#fff" opacity=".025"/><path d="M1030 0 L1200 0 L1200 630 L785 630 Z" fill="#e10600" opacity=".065"/><path d="M0 0 H1200 V7 H0 Z" fill="url(#red)"/>
  <rect x="74" y="75" width="78" height="78" rx="20" fill="url(#brand)"/><svg x="90" y="91" width="46" height="46" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg>
  <text x="171" y="128" fill="#f8f8fa" font-family="Archivo, sans-serif" font-size="40" font-weight="700" letter-spacing="-.4">FreeF1</text><text x="1124" y="118" fill="#8f949e" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="700" letter-spacing="3">RACE CONTROL</text>
  <rect x="74" y="195" width="310" height="48" rx="24" fill="#e10600" opacity=".16"/><circle cx="101" cy="219" r="6" fill="#ff5650"/><text x="120" y="226" fill="#ff7067" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="800" letter-spacing="2">STAY IN THE LOOP</text>
  <text x="74" y="326" fill="#f7f8fa" font-family="DejaVu Sans, sans-serif" font-size="60" font-weight="800" letter-spacing="-1.6">Stream Alerts</text>
  <text x="76" y="386" fill="#bec2cb" font-family="DejaVu Sans, sans-serif" font-size="27" font-weight="600">Get pinged when a session is starting.</text>
  <path d="M76 427H1124" stroke="#ffffff" stroke-opacity=".1"/><text x="76" y="484" fill="#a6abb5" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700">Use the button below to opt in or out.</text>
  <text x="76" y="555" fill="#f7f8fa" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">NEVER MISS LIGHTS OUT</text><text x="1124" y="555" fill="#8e949e" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="600">freef1-live.vercel.app</text></g></svg>`;
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
async function renderAlertImage(event, session, state) { return renderPng(alertSvg(event, session, state)); }
let panelImage;
async function renderAlertsPanelImage() { return panelImage || (panelImage = renderPng(alertsPanelSvg())); }
let websiteImage;
async function renderWebsiteImage() { return websiteImage || (websiteImage = renderPng(websiteSvg())); }
module.exports = { alertSvg, renderAlertImage, alertsPanelSvg, renderAlertsPanelImage, websiteSvg, renderWebsiteImage, STATES };
