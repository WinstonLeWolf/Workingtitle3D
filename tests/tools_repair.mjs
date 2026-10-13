// Repair and Simplify through the kernel, as the app runs them.
// node tests/tools_repair.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, partMesh } from '../src/core/kernel.js';
import { report } from '../src/core/meshcheck.js';
import * as repair from '../src/tools/repair/compute.js';
import * as simplify from '../src/tools/simplify/compute.js';
await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const tools = { repair, simplify };
const xf = { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
const mesh = async (part, blobs = new Map()) => { const notes = []; const r = await partMesh(part, { blobs, tools, notes }); return { ...r, notes }; };
const sph = (await mesh({ id: 's', kind: 'sphere', params: { d: 40, sides: 96 }, xform: xf })).tris;
const box = (await mesh({ id: 'b', kind: 'box', params: { x: 20, y: 20, z: 20 }, xform: xf })).tris;
const cut = (t, keep) => { const o = []; for (let i = 0; i < t.length; i += 9) if (keep(t, i)) o.push(...t.subarray(i, i + 9)); return Float32Array.from(o); };
const shift = (t, d) => t.map((v, i) => v + d[i % 3]);
const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
let fail = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${info}`); if (!ok) fail++; };
const holed = cut(sph, (t, i) => !(t[i + 2] > 36 && t[i + 5] > 36 && t[i + 8] > 36));
const blobs = new Map([['holed', holed], ['bigmess', cat(cut(box, (t, i) => i > 18), shift(box, [10, 10, 10]), Float32Array.from([50, 0, 0, 60, 0, 0, 55, 9, 0]))]]);
const part = (blob, params) => ({ id: blob, kind: 'mesh', blob, xform: xf, ops: params ? [{ tool: 'repair', params: { gap: 0.01, maxHole: 0, solid: false, voxel: 0.5, tidy: true, ...params } }] : [] });

let r = await mesh(part('holed'), blobs);
check('open mesh shows as open', r.open, `${r.tris.length / 9} tris`);
r = await mesh(part('holed', {}), blobs);
check('repair fills a 10 mm hole', !r.open && report(r.tris).watertight && Math.abs(r.volume - 33463) / 33463 < 0.03, `vol ${r.volume.toFixed(0)}; ${r.notes.join(' ')}`);
r = await mesh(part('holed', { maxHole: 5 }), blobs);
check('hole above the limit stays open, with a note', r.open && r.notes.some(t => /bigger than the limit/.test(t)), r.notes.join(' '));
// an open mesh still groups, cuts and simplifies
const holedPart = { ...part('holed'), name: 'Holed' };
r = await mesh({ id: 'g1', kind: 'group', xform: xf, children: [holedPart, { id: 'bx', kind: 'box', params: { x: 10, y: 10, z: 10 }, xform: { ...xf, pos: [40, 0, 0] } }] }, blobs);
check('group with an open mesh keeps it as it is', r.open && r.tris.length / 9 === holed.length / 9 + 12, `${r.tris.length / 9} tris`);
r = await mesh({ id: 'g2', kind: 'group', xform: xf, children: [holedPart, { id: 'cy', kind: 'cylinder', hole: true, params: { d: 10, h: 60, sides: 32 }, xform: { ...xf, pos: [0, 0, -10] } }] }, blobs);
check('hole cut through an open mesh', !r.open && report(r.tris).watertight && r.volume < 32000, `vol ${r.volume.toFixed(0)}; ${r.notes.join(' ')}`);
r = await mesh({ ...part('holed'), id: 'h3', ops: [{ tool: 'simplify', params: { percent: 30, preserve: true, tol: 0.1 } }] }, blobs);
check('simplify an open mesh', r.open && r.tris.length < holed.length, `${r.tris.length / 9} tris; ${r.notes.join(' ')}`);
r = await mesh(part('bigmess', { solid: true }), blobs);
check('make solid closes a mess', report(r.tris).watertight, `vol ${r.volume.toFixed(0)}; ${r.notes.join(' ')}`);
r = await mesh({ ...part('holed', {}), id: 'h2', ops: [...part('holed', {}).ops, { tool: 'simplify', params: { percent: 20, preserve: true, tol: 0.05 } }] }, blobs);
check('simplify after repair', report(r.tris).watertight, `${r.tris.length / 9} tris; ${r.notes.join(' ')}`);
r = await mesh({ id: 's2', kind: 'sphere', params: { d: 40, sides: 96 }, xform: xf, ops: [{ tool: 'simplify', params: { percent: 10, preserve: false, tol: 0.05 } }] });
check('simplify a sphere to 10%', report(r.tris).watertight && r.tris.length / 9 <= sph.length / 9 * 0.11, `${r.tris.length / 9} tris; ${r.notes.join(' ')}`);
console.log(fail ? `${fail} FAILED` : 'all passed');
if (fail) process.exitCode = 1;
