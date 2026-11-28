'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Resvg } = require('@resvg/resvg-js');
const { PNG } = require('pngjs');
const Crc = require('pngjs/lib/crc');
const FONT = path.join(__dirname, '..', 'assets/fonts/DejaVuSans-Bold.ttf');
const BRAND = path.join(__dirname, '..', 'assets/fonts/Archivo-Bold.ttf');
const { LOGOS } = require('./grid-image');
const aliases = { 'McLaren':'Mclaren', 'Red Bull Racing':'Red Bull', 'Aston Martin Aramco':'Aston Martin', 'Haas F1 Team':'Haas', 'Audi F1 Team':'Audi', 'Alpine F1 Team':'Alpine', 'Racing Bulls F1 Team':'Racing Bulls', 'RB F1 Team':'Racing Bulls', 'Cadillac F1 Team':'Cadillac' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function logoFor(name) { return LOGOS[aliases[name] || name]; }
function svgForResults(result) {
  const rowH = 74, y0 = 338, height = y0 + rowH * result.rows.length + 139;
  const heading = esc(`${result.session} Results`);
  const event = esc(result.event);
  const session = esc(result.session);
  const rows = result.rows.map((r, i) => {
    const y = y0 + i * rowH, slug = logoFor(r.team);
    const file = slug && path.join(__dirname, '..', 'assets/team-logos', `${slug}.png`);
    const logo = file && fs.existsSync(file) ? `<image x="525" y="${y+8}" width="50" height="50" href="data:image/png;base64,${fs.readFileSync(file).toString('base64')}"/>` : '';
    const color = /^#[\da-f]{6}$/i.test(r.color || '') ? r.color : '#8c929e';
    return `<rect x="130" y="${y}" width="840" height="66" rx="11" fill="#212227" stroke="#fff" stroke-opacity=".07"/><rect x="130" y="${y+9}" width="5" height="48" rx="2.5" fill="${color}"/><text x="151" y="${y+42}" font-family="DejaVu Sans" font-size="21" font-weight="700" fill="${i<3?'#fff':'#aeb4bf'}">${esc(r.position)}</text><text x="210" y="${y+42}" font-family="DejaVu Sans" font-size="21" font-weight="700" fill="#f5f5f7">${esc(r.name)}</text>${logo}<text x="587" y="${y+41}" font-family="DejaVu Sans" font-size="17" font-weight="700" fill="#bbc0c9">${esc(r.team)}</text><text x="945" y="${y+42}" text-anchor="end" font-family="DejaVu Sans" font-size="19" font-weight="700" fill="#e4e5e9">${esc(r.time)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${height}" viewBox="0 0 1100 ${height}"><defs><radialGradient id="bg" cx="50%" cy="0%" r="85%"><stop stop-color="#1b1e24"/><stop offset=".65" stop-color="#0e0f12"/><stop offset="1" stop-color="#0b0c0f"/></radialGradient><radialGradient id="card" cx="50%" cy="0%" r="80%"><stop stop-color="#212329"/><stop offset=".72" stop-color="#18191d"/><stop offset="1" stop-color="#18191d"/></radialGradient><clipPath id="clip"><rect width="1100" height="${height}" rx="26"/></clipPath></defs><g clip-path="url(#clip)"><rect width="1100" height="${height}" fill="url(#bg)"/><rect x="80" y="55" width="940" height="${height-110}" rx="24" fill="url(#card)" stroke="#fff" stroke-opacity=".12"/>
<text x="130" y="149" fill="#fff" font-family="Archivo" font-size="55" font-weight="700">${heading}</text><text x="132" y="197" fill="#e4e5e9" font-family="DejaVu Sans" font-size="23" font-weight="700">${event}</text><text x="132" y="230" fill="#a9abaf" font-family="DejaVu Sans" font-size="16" font-weight="700">${session}</text><rect x="130" y="253" width="220" height="38" rx="19" fill="#22c55e" fill-opacity=".12" stroke="#22c55e" stroke-opacity=".35"/><circle cx="151" cy="272" r="5" fill="#4ade80"/><text x="166" y="278" fill="#86efac" font-family="DejaVu Sans" font-size="14" font-weight="700">Session results</text>
<path d="M130 305H970" stroke="#fff" stroke-opacity=".09"/><g fill="#9ca3af" font-family="DejaVu Sans" font-size="13" font-weight="700"><text x="151" y="326">POS</text><text x="210" y="326">DRIVER</text><text x="525" y="326">TEAM</text><text x="945" y="326" text-anchor="end">${result.kind === 'race' ? 'TIME / GAP' : 'BEST TIME'}</text></g>${rows}
<path d="M130 ${height-120}H970" stroke="#fff" stroke-opacity=".08"/><rect x="130" y="${height-101}" width="28" height="28" rx="8" fill="#d70600"/><svg x="136" y="${height-95}" width="16" height="16" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg><text x="170" y="${height-81}" fill="#dddfe4" font-family="Archivo" font-size="19" font-weight="700">FreeF1</text><text x="970" y="${height-82}" text-anchor="end" fill="#a9abaf" font-family="DejaVu Sans" font-size="13" font-weight="700">Results may be subject to change  ·  freef1-live.vercel.app</text></g></svg>`;
}

function chunk(type, data) { const tag=Buffer.from(type); const out=Buffer.alloc(12+data.length); out.writeUInt32BE(data.length,0); tag.copy(out,4); data.copy(out,8); out.writeInt32BE(Crc.crc32(Buffer.concat([tag,data])),8+data.length); return out; }
function indexedPng(png) {
  const { width, height, data } = PNG.sync.read(png);
  // Quantize RGB into a compact 5-bit histogram; unlike point-per-pixel
  // quantizers this keeps peak memory bounded on small Render instances.
  const counts = new Uint32Array(32768);
  const sumsR = new Float64Array(32768), sumsG = new Float64Array(32768), sumsB = new Float64Array(32768);
  const keyFor = (r,g,b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  for (let p=0;p<data.length;p+=4) { const k=keyFor(data[p],data[p+1],data[p+2]); counts[k]++; sumsR[k]+=data[p]; sumsG[k]+=data[p+1]; sumsB[k]+=data[p+2]; }
  const keys=[]; for(let i=0;i<counts.length;i++) if(counts[i]) keys.push(i);
  const component=(k,axis)=>axis===0 ? (k>>10)&31 : axis===1 ? (k>>5)&31 : k&31;
  const describe=items=>{ let lo=[31,31,31],hi=[0,0,0],weight=0;for(const k of items){weight+=counts[k];for(let a=0;a<3;a++){let c=component(k,a);lo[a]=Math.min(lo[a],c);hi[a]=Math.max(hi[a],c)}} const range=hi.map((v,a)=>v-lo[a]);let axis=range.indexOf(Math.max(...range));return {items,weight,axis,score:range[axis]*Math.sqrt(weight)}; };
  const boxes=[describe(keys)];
  while(boxes.length<256) {
    let best=-1; for(let i=0;i<boxes.length;i++) if(boxes[i].items.length>1 && (best<0 || boxes[i].score>boxes[best].score)) best=i;
    if(best<0) break;
    const box=boxes.splice(best,1)[0], items=box.items.sort((a,b)=>component(a,box.axis)-component(b,box.axis));
    let total=0, split=1; for(let i=0;i<items.length-1;i++){total+=counts[items[i]];if(total>=box.weight/2){split=i+1;break;}}
    boxes.push(describe(items.slice(0,split)),describe(items.slice(split)));
  }
  const table=Buffer.alloc(boxes.length*3), mapping=new Uint8Array(32768);
  boxes.forEach((box,i)=>{let r=0,g=0,b=0,n=0;for(const k of box.items){r+=sumsR[k];g+=sumsG[k];b+=sumsB[k];n+=counts[k];mapping[k]=i;}table[i*3]=Math.round(r/n);table[i*3+1]=Math.round(g/n);table[i*3+2]=Math.round(b/n);});
  const raw=Buffer.alloc((width+1)*height);
  for(let y=0;y<height;y++){const line=y*(width+1);for(let x=0;x<width;x++){const p=(y*width+x)*4;raw[line+1+x]=mapping[keyFor(data[p],data[p+1],data[p+2])];}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=3;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('PLTE',table),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

function renderResultsImage(result) {
  const raw = new Resvg(svgForResults(result), {font:{fontFiles:[FONT,BRAND],loadSystemFonts:false,defaultFontFamily:'DejaVu Sans'}}).render().asPng();
  const compact = indexedPng(raw);
  return compact.length < raw.length ? compact : raw;
}
module.exports = { renderResultsImage, svgForResults, indexedPng, logoFor };
