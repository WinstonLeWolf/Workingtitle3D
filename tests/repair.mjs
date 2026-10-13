// Repair closes holes, T-junctions and mixed winding.
import { repair } from '../src/core/meshcheck.js';
const cube = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
const mk = fs => Float32Array.from(fs.flatMap(f => f.flatMap(i => cube[i])));
const check = (name, r) => { console.log(name, r.fixes.after.watertight ? 'ok' : 'FAIL ' + JSON.stringify(r.fixes.after)); if (!r.fixes.after.watertight) process.exitCode = 1; };
check('hole', repair(mk(F.slice(2))));
check('flip', repair(mk(F.map((f, i) => i === 5 ? [f[0], f[2], f[1]] : f))));
cube.push([0.5, 0, 0]);
check('tjunction', repair(mk(F.filter((_, i) => i !== 4 && i !== 5).concat([[0, 8, 5], [8, 1, 5], [0, 5, 4]]))));
check('two holes', repair(mk(F.filter((_, i) => i !== 0 && i !== 3 && i !== 6))));

// Pieces that touch or overlap: split into shells, close each, union (the import path in worker.js).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { shells, report } from '../src/core/meshcheck.js';
import { initKernel, unionShells } from '../src/core/kernel.js';
await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const C = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const cubeAt = (x, y, z, flip = -1) => Float32Array.from(F.flatMap((f, i) => (i === flip ? [f[0], f[2], f[1]] : f).flatMap(k => [C[k][0] + x, C[k][1] + y, C[k][2] + z])));
const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const viaShells = t => { const r = repair(t); if (r.fixes.after.watertight) return r.fixes.after; const u = unionShells(shells(r.tris).map(s => repair(s).tris)); return u ? report(u.tris) : { watertight: false }; };
for (const [name, t] of [['edge touch', cat(cubeAt(0, 0, 0), cubeAt(1, 1, 0))], ['overlap', cat(cubeAt(0, 0, 0), cubeAt(0.5, 0.5, 0.5))],
  ['overlap + flipped face', cat(cubeAt(0, 0, 0, 3), cubeAt(0.5, 0.5, 0.5))], ['face touch', cat(cubeAt(0, 0, 0), cubeAt(1, 0, 0))]]) {
  const rep = viaShells(t);
  console.log(name, rep.watertight ? 'ok vol ' + rep.volume.toFixed(3) : 'FAIL ' + JSON.stringify(rep).slice(0, 200));
  if (!rep.watertight) process.exitCode = 1;
}

// A mesh that stays open still displays as it is.
import { partMesh } from '../src/core/kernel.js';
const sheet = Float32Array.from([0,0,0, 1,0,0, 0,1,0]);
const pm = await partMesh({ id: 'x', kind: 'mesh', blob: 'b', xform: { pos: [0,0,0], rot: [0,0,0], scale: [1,1,1] } }, { blobs: new Map([['b', sheet]]), tools: {} });
console.log('open mesh displays', pm.open && pm.tris.length === 9 ? 'ok' : 'FAIL');
if (!pm.open) process.exitCode = 1;

// Export: an open mesh is written as it is, beside the joined solids.
import { flatten } from '../src/core/kernel.js';
const xf = { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
const fopts = {};
const flat = await flatten([{ id: 'b', kind: 'box', params: { x: 10, y: 10, z: 10 }, xform: xf }, { id: 'm', kind: 'mesh', blob: 'b', xform: { ...xf, pos: [30, 0, 0] } }],
  { blobs: new Map([['b', sheet]]), tools: {}, progress() {} }, fopts);
const okFlat = fopts.open === 1 && flat.length === 9 * 13;
console.log('export keeps the open mesh', okFlat ? 'ok' : `FAIL open ${fopts.open} tris ${flat.length / 9}`);
if (!okFlat) process.exitCode = 1;
