'use strict';

// Logos are bundled so panel creation does not depend on an external image service.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { PNG } = require('pngjs');
const { constants } = require('zlib');
const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const BRAND_FONT = path.join(__dirname, '..', 'assets', 'fonts', 'Archivo-Bold.ttf');
const LOGOS = {
  Ferrari: 'ferrari', Mercedes: 'mercedes', Mclaren: 'mclaren', 'Red Bull': 'redbullracing',
  'Aston Martin': 'astonmartin', Williams: 'williams', Haas: 'haasf1team', Audi: 'audi',
  'Racing Bulls': 'racingbulls', Alpine: 'alpine', Cadillac: 'cadillac',
};
const NAMES = {
  LEC: 'Charles Leclerc', HAM: 'Lewis Hamilton', ANT: 'Kimi Antonelli', RUS: 'George Russell',
  NOR: 'Lando Norris', PIA: 'Oscar Piastri', VER: 'Max Verstappen', HAD: 'Isack Hadjar',
  ALO: 'Fernando Alonso', STR: 'Lance Stroll', ALB: 'Alex Albon', SAI: 'Carlos Sainz',
  CAM: 'Rafael Câmara', BEA: 'Oliver Bearman', BOR: 'Gabriel Bortoleto', HUL: 'Nico Hülkenberg',
  LAW: 'Liam Lawson', LIN: 'Arvid Lindblad', GAS: 'Pierre Gasly', COL: 'Franco Colapinto',
  PER: 'Sergio Pérez', BOT: 'Valtteri Bottas',
};
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
function gridSvg(teams, teamOnly = false) {
  const height = teamOnly ? 1100 + (Math.ceil(teams.length / 2) - 6) * 100 : 1510 + (teams.length - 11) * 92;
  if (teamOnly) {
    const rows=teams.map((team,i)=>{const y=350+Math.floor(i/2)*100;const x=130+(i%2)*425;const logo=fs.readFileSync(path.join(__dirname, '..', 'assets', 'team-logos', LOGOS[team.name]+'.png')).toString('base64');const color='#'+Number(team.color).toString(16).padStart(6,'0');return `<rect x="${x}" y="${y}" width="410" height="88" rx="14" fill="#212227" stroke="#ffffff" stroke-opacity=".09"/><rect x="${x}" y="${y+15}" width="5" height="58" rx="2.5" fill="${color}"/><image x="${x+18}" y="${y+9}" width="66" height="70" href="data:image/png;base64,${logo}"/><text x="${x+100}" y="${y+56}" fill="#f5f5f7" font-family="DejaVu Sans" font-size="24" font-weight="700">${esc(team.name==='Mclaren'?'McLaren':team.name)}</text>`;}).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${height}" height="${height}" viewBox="0 0 ${height} ${height}"><defs><radialGradient id="bg" cx="50%" cy="0%" r="85%"><stop stop-color="#252127"/><stop offset=".65" stop-color="#0e0f12"/><stop offset="1" stop-color="#0b0c0f"/></radialGradient><radialGradient id="card" cx="50%" cy="0%" r="80%"><stop stop-color="#292023"/><stop offset=".72" stop-color="#18191d"/><stop offset="1" stop-color="#18191d"/></radialGradient><clipPath id="clip"><rect width="${height}" height="${height}" rx="26"/></clipPath></defs><g clip-path="url(#clip)"><rect width="${height}" height="${height}" fill="url(#bg)"/><rect x="80" y="55" width="940" height="${height - 110}" rx="24" fill="url(#card)" stroke="#ffffff" stroke-opacity=".12"/>
<text x="130" y="151" fill="#fff" font-family="Archivo" font-size="55" font-weight="700">2026 Grid</text><text x="132" y="200" fill="#e4e5e9" font-family="DejaVu Sans" font-size="23" font-weight="700">Choose your team.</text><text x="132" y="235" fill="#a9abaf" font-family="DejaVu Sans" font-size="16" font-weight="700">Select one using the buttons below.</text>
<rect x="130" y="263" width="187" height="38" rx="19" fill="#ef4444" fill-opacity=".12" stroke="#ef4444" stroke-opacity=".35"/><circle cx="151" cy="282" r="5" fill="#f05252"/><text x="166" y="288" fill="#fca5a5" font-family="DejaVu Sans" font-size="14" font-weight="700">Team roles</text><path d="M130 327H970" stroke="#fff" stroke-opacity=".09"/>${rows}
<path d="M130 ${height - 126}H970" stroke="#fff" stroke-opacity=".08"/><rect x="130" y="${height - 108}" width="28" height="28" rx="8" fill="#d70600"/><svg x="136" y="${height - 102}" width="16" height="16" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg><text x="170" y="${height - 88}" fill="#dddfe4" font-family="Archivo" font-size="19" font-weight="700">FreeF1</text><text x="970" y="${height - 89}" text-anchor="end" fill="#85898f" font-family="DejaVu Sans" font-size="15" font-weight="700">Tap again to remove your role  ·  freef1-live.vercel.app</text></g></svg>`;
  }
  const rows=teams.map((team,i)=>{const y=350+i*92;const logo=fs.readFileSync(path.join(__dirname, '..', 'assets', 'team-logos', LOGOS[team.name]+'.png')).toString('base64');const color='#'+Number(team.color).toString(16).padStart(6,'0');const drivers=team.drivers.map(([num,code],j)=>`<text x="${415+j*278}" y="${y+49}" font-family="DejaVu Sans" font-size="17" font-weight="700"><tspan fill="#aeb4bf">${esc(num)} | </tspan><tspan fill="#f1f2f5">${esc(NAMES[code]||code)}</tspan></text>`).join('');return `<rect x="130" y="${y}" width="840" height="82" rx="14" fill="#212227" stroke="#ffffff" stroke-opacity=".09"/><rect x="130" y="${y+14}" width="5" height="54" rx="2.5" fill="${color}"/><image x="147" y="${y+7}" width="61" height="68" href="data:image/png;base64,${logo}"/><text x="218" y="${y+49}" fill="#fff" font-family="DejaVu Sans" font-size="19" font-weight="700">${esc(team.name==='Mclaren'?'McLaren':team.name)}</text>${drivers}`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${height}" viewBox="0 0 1100 ${height}"><defs><radialGradient id="bg" cx="50%" cy="0%" r="85%"><stop stop-color="#252127"/><stop offset=".65" stop-color="#0e0f12"/><stop offset="1" stop-color="#0b0c0f"/></radialGradient><radialGradient id="card" cx="50%" cy="0%" r="80%"><stop stop-color="#292023"/><stop offset=".72" stop-color="#18191d"/><stop offset="1" stop-color="#18191d"/></radialGradient><clipPath id="clip"><rect width="1100" height="${height}" rx="26"/></clipPath></defs><g clip-path="url(#clip)"><rect width="1100" height="${height}" fill="url(#bg)"/><rect x="80" y="55" width="940" height="${height - 110}" rx="24" fill="url(#card)" stroke="#ffffff" stroke-opacity=".12"/>
<text x="130" y="151" fill="#fff" font-family="Archivo" font-size="55" font-weight="700">2026 Grid</text><text x="132" y="200" fill="#e4e5e9" font-family="DejaVu Sans" font-size="23" font-weight="700">Choose your driver.</text><text x="132" y="235" fill="#a9abaf" font-family="DejaVu Sans" font-size="16" font-weight="700">Pick a driver using the buttons below.</text>
<rect x="130" y="263" width="187" height="38" rx="19" fill="#ef4444" fill-opacity=".12" stroke="#ef4444" stroke-opacity=".35"/><circle cx="151" cy="282" r="5" fill="#f05252"/><text x="166" y="288" fill="#fca5a5" font-family="DejaVu Sans" font-size="14" font-weight="700">Driver roles</text><path d="M130 327H970" stroke="#fff" stroke-opacity=".09"/>${rows}
<path d="M130 ${height - 126}H970" stroke="#fff" stroke-opacity=".08"/><rect x="130" y="${height - 108}" width="28" height="28" rx="8" fill="#d70600"/><svg x="136" y="${height - 102}" width="16" height="16" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg><text x="170" y="${height - 88}" fill="#dddfe4" font-family="Archivo" font-size="19" font-weight="700">FreeF1</text><text x="970" y="${height - 89}" text-anchor="end" fill="#85898f" font-family="DejaVu Sans" font-size="15" font-weight="700">Tap again to remove your role  ·  freef1-live.vercel.app</text></g></svg>`;
}

let cached;
function renderGridImage(teams, teamOnly = false) {
  const signature = JSON.stringify([teams, teamOnly]);
  if (cached?.signature === signature) return cached.image;
  const svg = gridSvg(teams, teamOnly);
  const source = new Resvg(svg, { font: { fontFiles: [FONT, BRAND_FONT], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
  const image = PNG.sync.write(PNG.sync.read(source), { filterType: -1, deflateLevel: 9, deflateStrategy: constants.Z_DEFAULT_STRATEGY });
  cached = { signature, image };
  return image;
}
function gridDescription(teams) {
  return `2026 driver grid. ${teams.map(team => `${team.name}: ${team.drivers.map(([number, code]) => `${number} | ${NAMES[code] || code}`).join(' and ')}`).join('; ')}. Choose a driver with the buttons below.`;
}
module.exports = { gridSvg, renderGridImage, gridDescription, NAMES, LOGOS };
