// Can the boolean library carry joins and holes? Touching faces, flush holes, flat bottoms,
// speed on deck-sized work. Every result goes through our own closed-solid check.
// node tests/manifold_spike.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'manifold-3d';
import { report, describe, weld, bounds } from '../src/core/meshcheck.js';
import { box, extrude, rect, circle, sphere } from './shapes.mjs';
import { run as shape } from '../src/tools/edgeshaper/compute.js';
import { run as hollow } from '../src/tools/hollower/compute.js';
import { repair } from '../src/core/meshcheck.js';

const wasmBinary = readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm'));
const wasm = await Module({ wasmBinary });
wasm.setup();
const { Manifold, Mesh } = wasm;

const toM = tris => {
  const { pos, idx } = weld(tris);
  const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(idx) });
  mesh.merge();
  return Manifold.ofMesh(mesh);
};
const toTris = m => {
  const mesh = m.getMesh();
  const out = new Float32Array(mesh.triVerts.length * 3);
  for (let i = 0; i < mesh.triVerts.length; i++) {
    const v = mesh.triVerts[i] * mesh.numProp;
    out[i * 3] = mesh.vertProperties[v]; out[i * 3 + 1] = mesh.vertProperties[v + 1]; out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
};
let fail = 0;
const check = (name, tris, ms, expectVol = null, extra = '') => {
  const r = report(tris);
  let ok = r.watertight;
  let v = '';
  if (expectVol != null) { const e = (r.volume - expectVol) / expectVol; v = ` vol ${r.volume.toFixed(1)} vs ${expectVol.toFixed(1)} (${(e * 100).toFixed(3)} %)`; if (Math.abs(e) > 0.002) ok = false; }
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${String(r.triangles).padStart(8)} tris ${ms.toFixed(0).padStart(6)} ms  ${describe(r)}${v}${extra}`);
};
const time = f => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };
const cyl = (cx, cy, r, z0, z1, n = 64) => extrude(circle(cx, cy, r, n), [], z0, z1);

// 1. two boxes sharing a face exactly
{
  const [m, ms] = time(() => Manifold.union(toM(box(0, 0, 0, 10, 10, 10)), toM(box(10, 0, 0, 20, 10, 10))));
  check('touching faces, union', toTris(m), ms, 2000);
}
// 2. boxes overlapping with coplanar top and bottom
{
  const [m, ms] = time(() => Manifold.union(toM(box(0, 0, 0, 10, 10, 10)), toM(box(5, 5, 0, 15, 15, 10))));
  check('coplanar overlap, union', toTris(m), ms, 1750);
}
// 3. hole exactly flush with top and bottom (the usual hole)
{
  const plate = box(0, 0, 0, 40, 40, 5);
  const hole = cyl(20, 20, 5, 0, 5);
  const holeVol = report(hole).volume;
  const [m, ms] = time(() => Manifold.difference(toM(plate), toM(hole)));
  check('flush hole, difference', toTris(m), ms, 8000 - holeVol);
}
// 4. flat bottom: parts on the plate at z=0 joined; every bottom point must stay exactly 0
{
  const parts = [box(0, 0, 0, 30, 20, 4), cyl(10, 10, 6, 0, 12), box(20, 5, 0, 26, 15, 8), sphere(5, 32, 16)];
  parts[3] = parts[3].map((v, i) => (i % 3 === 0 ? v + 15 : i % 3 === 1 ? v + 10 : v + 9));
  const [m, ms] = time(() => Manifold.union(parts.map(toM)));
  const t = toTris(m);
  let worst = 0;
  for (let i = 2; i < t.length; i += 3) if (t[i] < 0.5) worst = Math.max(worst, Math.abs(t[i]));
  check('flat bottom after join', t, ms, null, `  worst bottom z ${worst.toExponential(1)}`);
  if (worst !== 0) { fail++; console.log('FAIL bottom not exactly flat'); }
}
// 5. deck-sized: 200x120x6 plate, 60 holes, 40 bosses, joined in one go
{
  const holes = [], bosses = [];
  for (let i = 0; i < 60; i++) holes.push(cyl(10 + (i % 12) * 15, 10 + Math.floor(i / 12) * 22, 1.6, -1, 7, 32));
  for (let i = 0; i < 40; i++) bosses.push(cyl(17 + (i % 10) * 18, 20 + Math.floor(i / 10) * 25, 3, 6, 14, 48));
  const [m, ms] = time(() => Manifold.difference(Manifold.union([toM(box(0, 0, 0, 200, 120, 6)), ...bosses.map(toM)]), Manifold.union(holes.map(toM))));
  check('deck plate: 60 holes + 40 bosses', toTris(m), ms);
}
// 6. dense meshes from our own tools: filleted plate joined with a hollowed box
{
  const plate = (await shape(repair(extrude(rect(0, 0, 60, 30), [circle(15, 15, 6)], 0, 5)).tris, { kind: 'fillet', face: 'top', width: 2, height: 2, start: null }, { progress() {} })).tris;
  const shell = (await hollow(repair(box(20, 5, 5, 50, 25, 25)).tris, { wall: 2, voxel: 0.5, open: false }, { selection: [], progress() {} })).tris;
  const [m, ms] = time(() => Manifold.union(toM(plate), toM(shell)));
  check('fillet plate + hollow box (dense)', toTris(m), ms);
}
// 7. big: 400k-triangle sphere minus a 100-hole grid
{
  const s = sphere(60, 640, 320);
  const holes = [];
  for (let i = 0; i < 100; i++) holes.push(cyl(-45 + (i % 10) * 10, -45 + Math.floor(i / 10) * 10, 2, -70, 70, 32));
  const [m, ms] = time(() => Manifold.difference(toM(s), Manifold.union(holes.map(toM))));
  check(`sphere ${(s.length / 9 / 1000).toFixed(0)}k tris - 100 holes`, toTris(m), ms);
}
console.log(fail ? `${fail} FAILED` : 'all passed');
