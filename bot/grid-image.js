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
function gridSvg(teams) {
  const width = 1100, header = 220, rowH = 104, height = header + teams.length * rowH + 92;
  const rows = teams.map((team, i) => {
    const slug = LOGOS[team.name];
    if (!slug || team.drivers.some(([, code]) => !NAMES[code])) throw new Error(`Missing grid artwork or name for ${team.name}`);
    const data = fs.readFileSync(path.join(__dirname, '..', 'assets', 'team-logos', `${slug}.png`)).toString('base64');
    const y = header + i * rowH;
    const color = `#${Number(team.color).toString(16).padStart(6, '0')}`;
    const drivers = team.drivers.map(([number, code], index) => `<text x="${410 + index * 305}" y="${y + 62}" fill="#f4f5f8" font-family="DejaVu Sans" font-size="21" font-weight="700"><tspan fill="#aeb4bf">${esc(number)} | </tspan>${esc(NAMES[code])}</text>`).join('');
    return `<rect x="42" y="${y}" width="1016" height="92" rx="14" fill="${i % 2 ? '#171a20' : '#1c1f25'}"/><rect x="42" y="${y + 13}" width="5" height="66" rx="2" fill="${color}"/><image x="64" y="${y + 9}" width="74" height="74" href="data:image/png;base64,${data}"/><text x="158" y="${y + 59}" fill="#fff" font-family="DejaVu Sans" font-size="23" font-weight="700">${esc(team.name === 'Mclaren' ? 'McLaren' : team.name)}</text>${drivers}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" rx="22" fill="#101216"/><rect width="${width}" height="6" fill="#e10600"/>
    <rect x="44" y="36" width="58" height="58" rx="14" fill="#d00600"/><svg x="56" y="48" width="34" height="34" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg>
    <text x="118" y="77" fill="#fff" font-family="Archivo" font-size="36" font-weight="700">FreeF1</text><text x="1057" y="75" fill="#939aa5" font-family="DejaVu Sans" font-size="15" font-weight="700" text-anchor="end" letter-spacing="2">DRIVER ROLES</text>
    <text x="44" y="156" fill="#fff" font-family="DejaVu Sans" font-size="38" font-weight="700">2026 GRID</text><text x="45" y="190" fill="#aeb4bf" font-family="DejaVu Sans" font-size="18" font-weight="700">Choose your driver with the buttons below.</text>
    ${rows}<text x="44" y="${height - 35}" fill="#939aa5" font-family="DejaVu Sans" font-size="15" font-weight="700">TAP AGAIN TO REMOVE YOUR ROLE</text><text x="1056" y="${height - 35}" text-anchor="end" fill="#939aa5" font-family="DejaVu Sans" font-size="15" font-weight="700">freef1-live.vercel.app</text></svg>`;
}
let cached;
function renderGridImage(teams) {
  const signature = JSON.stringify(teams);
  if (cached?.signature === signature) return cached.image;
  const svg = gridSvg(teams);
  const source = new Resvg(svg, { font: { fontFiles: [FONT, BRAND_FONT], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
  const image = PNG.sync.write(PNG.sync.read(source), { filterType: -1, deflateLevel: 9, deflateStrategy: constants.Z_DEFAULT_STRATEGY });
  cached = { signature, image };
  return image;
}
function gridDescription(teams) {
  return `2026 driver grid. ${teams.map(team => `${team.name}: ${team.drivers.map(([number, code]) => `${number} | ${NAMES[code] || code}`).join(' and ')}`).join('; ')}. Choose a driver with the buttons below.`;
}
module.exports = { gridSvg, renderGridImage, gridDescription, NAMES, LOGOS };
