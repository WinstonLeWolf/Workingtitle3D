// Mesh files in and out: STL (binary and ASCII), OBJ, 3MF. No DOM, runs in the worker.
// 3MF is a zip: read with our own directory parser plus DecompressionStream,
// written store-only with a CRC32, so no zip library is bundled.
import { weld, ToolError } from './meshcheck.js';

export const OPEN_EXT = ['.stl', '.obj', '.3mf'];
export const SAVE_FMT = ['stl', '3mf', 'obj'];

export async function readMesh(name, buf) {
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  let tris;
  if (ext === '.stl') tris = readSTL(buf);
  else if (ext === '.obj') tris = readOBJ(new TextDecoder().decode(buf));
  else if (ext === '.3mf') tris = await read3MF(buf);
  else throw new ToolError(`Cannot open ${ext || 'that kind of'} files. Open one of: ${OPEN_EXT.join(', ')}`);
  if (!tris.length) throw new ToolError('The file holds no triangles.');
  for (let i = 0; i < tris.length; i++) if (!Number.isFinite(tris[i])) throw new ToolError('The file holds coordinates that are not numbers.');
  return tris;
}

// ---- STL ----------------------------------------------------------------------
export function readSTL(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const n = u8.length >= 84 ? dv.getUint32(80, true) : 0;
  const binary = u8.length >= 84 && 84 + n * 50 === u8.length;
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 1000))).trimStart().toLowerCase();
  if (!binary && head.startsWith('solid') && head.includes('facet')) {
    const text = new TextDecoder().decode(u8);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const v = [];
    let m;
    while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
    return Float32Array.from(v.slice(0, v.length - (v.length % 9)));
  }
  if (u8.length < 84 + n * 50) throw new ToolError('The STL file is cut short.');
  const out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return out;
}

export function writeSTL(tris) {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const head = 'Workingtitle3D';
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < head.length ? head.charCodeAt(i) : 32);
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const i = t * 9, o = 84 + t * 50;
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tris[i + k], true);
  }
  return new Uint8Array(buf);
}

// ---- OBJ ----------------------------------------------------------------------
export function readOBJ(text) {
  const v = [], out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const p = line.trim().split(/\s+/);
      v.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map(tok => {
        const i = parseInt(tok.split('/')[0], 10);
        return i > 0 ? i - 1 : v.length + i;
      });
      for (let k = 1; k < idx.length - 1; k++) {
        for (const j of [idx[0], idx[k], idx[k + 1]]) {
          const p = v[j];
          if (!p) throw new ToolError('The OBJ file points at a vertex it does not have.');
          out.push(p[0], p[1], p[2]);
        }
      }
    }
  }
  return Float32Array.from(out);
}

export function writeOBJ(tris) {
  const { pos, idx, nv } = weld(tris, 1e-6);
  const lines = ['# Workingtitle3D'];
  for (let i = 0; i < nv; i++) lines.push(`v ${num(pos[i * 3])} ${num(pos[i * 3 + 1])} ${num(pos[i * 3 + 2])}`);
  for (let t = 0; t < idx.length; t += 3) lines.push(`f ${idx[t] + 1} ${idx[t + 1] + 1} ${idx[t + 2] + 1}`);
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// shortest text that reads back as the same float32
function num(x) {
  const f = Math.fround(x);
  for (let p = 6; p < 10; p++) {
    const s = f.toPrecision(p);
    if (Math.fround(+s) === f) return String(+s);
  }
  return String(f);
}

// ---- 3MF ----------------------------------------------------------------------
const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

async function read3MF(buf) {
  const files = await unzip(buf);
  const out = [];
  for (const [name, data] of files) {
    if (!name.toLowerCase().endsWith('.model')) continue;
    out.push(parseModel(new TextDecoder().decode(data)));
  }
  const total = out.reduce((s, a) => s + a.length, 0);
  const tris = new Float32Array(total);
  let o = 0;
  for (const a of out) { tris.set(a, o); o += a.length; }
  return tris;
}

const attrs = s => {
  const a = {};
  for (const m of s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) a[m[1]] = m[2];
  return a;
};
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseT = s => { const m = (s || '').trim().split(/\s+/).map(Number); return m.length === 12 && m.every(Number.isFinite) ? m : IDENT; };
// 3MF matrices are row-vector: p' = p * M
const mul = (a, b) => {
  const r = new Array(12);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
  }
  return r;
};

function parseModel(xml) {
  const unit = UNITS[(xml.match(/<model\b[^>]*\bunit="([^"]+)"/) || [])[1]] || 1;
  const objects = new Map();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attrs(m[1]).id;
    const body = m[2];
    const vs = [];
    for (const v of body.matchAll(/<vertex\b([^>]*?)\/?>/g)) { const a = attrs(v[1]); vs.push(+a.x, +a.y, +a.z); }
    const ts = [];
    for (const t of body.matchAll(/<triangle\b([^>]*?)\/?>/g)) { const a = attrs(t[1]); ts.push(+a.v1, +a.v2, +a.v3); }
    const comps = [];
    for (const c of body.matchAll(/<component\b([^>]*?)\/?>/g)) { const a = attrs(c[1]); comps.push({ id: a.objectid, t: parseT(a.transform) }); }
    objects.set(id, { vs, ts, comps });
  }
  const out = [];
  const emit = (id, T, depth) => {
    const o = objects.get(id);
    if (!o || depth > 16) return;
    for (let i = 0; i < o.ts.length; i++) {
      const v = o.ts[i] * 3;
      if (v < 0 || v + 2 >= o.vs.length) throw new ToolError('The 3MF file points at a vertex it does not have.');
      const x = o.vs[v], y = o.vs[v + 1], z = o.vs[v + 2];
      out.push((x * T[0] + y * T[3] + z * T[6] + T[9]) * unit,
        (x * T[1] + y * T[4] + z * T[7] + T[10]) * unit,
        (x * T[2] + y * T[5] + z * T[8] + T[11]) * unit);
    }
    for (const c of o.comps) emit(c.id, mul(c.t, T), depth + 1);
  };
  const items = [...xml.matchAll(/<item\b([^>]*?)\/?>/g)].map(m => attrs(m[1]));
  if (items.length) for (const it of items) emit(it.objectid, parseT(it.transform), 0);
  else for (const id of objects.keys()) emit(id, IDENT, 0);
  return Float32Array.from(out);
}

export function write3MF(tris) {
  const { pos, idx, nv } = weld(tris, 1e-6);
  const v = [], t = [];
  for (let i = 0; i < nv; i++) v.push(`<vertex x="${num(pos[i * 3])}" y="${num(pos[i * 3 + 1])}" z="${num(pos[i * 3 + 2])}"/>`);
  for (let i = 0; i < idx.length; i += 3) t.push(`<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`);
  const model = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + `<resources><object id="1" type="model"><mesh><vertices>${v.join('')}</vertices>`
    + `<triangles>${t.join('')}</triangles></mesh></object></resources>`
    + '<build><item objectid="1"/></build></model>';
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    + '</Relationships>';
  const enc = new TextEncoder();
  return zipStore([['[Content_Types].xml', enc.encode(types)], ['_rels/.rels', enc.encode(rels)], ['3D/3dmodel.model', enc.encode(model)]]);
}

export function writeMesh(tris, fmt) {
  if (fmt === 'stl') return writeSTL(tris);
  if (fmt === 'obj') return writeOBJ(tris);
  if (fmt === '3mf') return write3MF(tris);
  throw new ToolError('Save as one of: ' + SAVE_FMT.join(', '));
}

// ---- zip --------------------------------------------------------------------------
export async function unzip(buf, all = false, what = 'The 3MF file') {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new ToolError(`${what} is not a readable zip.`);
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new ToolError(`${what}: its zip directory is damaged.`);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (!all && !name.toLowerCase().endsWith('.model')) { files.push([name, raw]); continue; }
    if (method === 0) files.push([name, raw]);
    else if (method === 8) files.push([name, await inflate(raw)]);
    else throw new ToolError(`${what} uses zip method ${method}, which this cannot read.`);
  }
  return files;
}

async function inflate(raw) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let CRC = null;
function crc32(u8) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const nm = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true);
    c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + data.length;
  }
  const csize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}
