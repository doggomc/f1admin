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
  const width = 960, y0 = 305, step = 62, height = y0 + result.rows.length * step + 92;
  const rowSvg = result.rows.map((r, i) => {
    const y = y0 + i * step, slug = logoFor(r.team), file = slug && path.join(__dirname, '..', 'assets/team-logos', `${slug}.png`);
    const logo = file && fs.existsSync(file) ? `<image x="525" y="${y+6}" width="43" height="43" href="data:image/png;base64,${fs.readFileSync(file).toString('base64')}"/>` : '';
    const color = /^#[\da-f]{6}$/i.test(r.color || '') ? r.color : '#8c929e';
    return `<rect x="40" y="${y}" width="880" height="55" rx="9" fill="${i%2 ? '#171a20' : '#1b1e24'}"/><rect x="40" y="${y+7}" width="4" height="41" rx="2" fill="${color}"/><text x="67" y="${y+35}" fill="${i<3?'#fff':'#abb2bd'}" font-family="DejaVu Sans" font-size="21" font-weight="700">${esc(r.position)}</text><text x="133" y="${y+35}" fill="#f2f3f5" font-family="DejaVu Sans" font-size="21" font-weight="700">${esc(r.name)}</text>${logo}<text x="582" y="${y+34}" fill="#b0b6c0" font-family="DejaVu Sans" font-size="16" font-weight="700">${esc(r.team)}</text><text x="900" y="${y+35}" text-anchor="end" fill="#d0d4dd" font-family="DejaVu Sans" font-size="19" font-weight="700">${esc(r.time)}</text>`;
  }).join('');
  const subtitle = `${result.event}  ·  ${result.session}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#0e1014"/><rect width="${width}" height="6" fill="#e10600"/><rect x="40" y="35" width="52" height="52" rx="14" fill="#e10600"/><svg x="50" y="45" width="32" height="32" viewBox="0 0 24 24"><path d="M2 17.5L7.5 6.5h5.2l-2 4h4.6l-1.6 3.2H8.9l-1.7 3.8H2z" fill="#fff"/><path d="M14.5 6.5H22l-1.7 3.4h-7.5l1.7-3.4z" fill="#fff" opacity=".72"/></svg><text x="108" y="75" fill="#f5f6f8" font-family="Archivo" font-size="34" font-weight="700">FreeF1</text><text x="925" y="58" text-anchor="end" fill="#939ba7" font-family="DejaVu Sans" font-size="14" font-weight="700">RACE CONTROL</text><rect x="40" y="114" width="175" height="30" rx="15" fill="#223830"/><text x="58" y="134" fill="#8de0ac" font-family="DejaVu Sans" font-size="13" font-weight="700">SESSION RESULTS</text><text x="40" y="196" fill="#fafbfc" font-family="DejaVu Sans" font-size="40" font-weight="700">${esc(result.session.toUpperCase())} RESULTS</text><text x="41" y="234" fill="#a4aab5" font-family="DejaVu Sans" font-size="17" font-weight="700">${esc(subtitle.toUpperCase())}</text><path d="M40 257H920" stroke="#30343b"/><g fill="#848b97" font-family="DejaVu Sans" font-size="13" font-weight="700"><text x="60" y="284">POS</text><text x="133" y="284">DRIVER</text><text x="525" y="284">TEAM</text><text x="900" y="284" text-anchor="end">${result.kind === 'race' ? 'TIME / GAP' : 'BEST TIME'}</text></g>${rowSvg}<path d="M40 ${height-65}H920" stroke="#30343b"/><text x="41" y="${height-35}" fill="#929aa6" font-family="DejaVu Sans" font-size="13" font-weight="700">RESULTS MAY BE SUBJECT TO CHANGE</text><text x="920" y="${height-35}" text-anchor="end" fill="#929aa6" font-family="DejaVu Sans" font-size="13" font-weight="700">freef1-live.vercel.app</text></svg>`;
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
