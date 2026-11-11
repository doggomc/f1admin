'use strict';

/* Render locally: no image-service requests and no video traffic. */
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
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
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1c2027"/><stop offset="1" stop-color="#090b0e"/></linearGradient><linearGradient id="red" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#ff3b32"/><stop offset="1" stop-color="#a80000"/></linearGradient><clipPath id="clip"><rect width="1200" height="630" rx="28"/></clipPath></defs>
  <g clip-path="url(#clip)"><rect width="1200" height="630" fill="url(#bg)"/>
  <path d="M750 -40 L1220 -40 L945 670 L475 670 Z" fill="#ffffff" opacity=".022"/><path d="M905 -40 L1040 -40 L765 670 L630 670 Z" fill="#ffffff" opacity=".025"/>
  <path d="M1030 0 L1200 0 L1200 630 L785 630 Z" fill="#e10600" opacity=".065"/>
  <path d="M0 0 H1200 V7 H0 Z" fill="url(#red)"/><path d="M75 75h46l-15 30h38l-12 23H94l-12 25H55z M157 75h52l-12 23h-52z" fill="#e10600"/>
  <text x="229" y="133" fill="#f8f8fa" font-family="DejaVu Sans, sans-serif" font-size="40" font-weight="800" letter-spacing="-1">FreeF1</text>
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
async function renderAlertImage(event, session, state) {
  return new Resvg(alertSvg(event, session, state), { font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
}
module.exports = { alertSvg, renderAlertImage, STATES };
