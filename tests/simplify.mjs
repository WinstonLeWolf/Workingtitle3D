// Simplify with Preserve surface stays within its limit, measured both ways round.
// node tests/simplify.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initKernel, partMesh } from '../src/core/kernel.js';
import { decimate } from '../src/core/decimate.js';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
await initKernel(readFileSync(createRequire(import.meta.url).resolve('manifold-3d/manifold.wasm')));
const xf = { pos: [0,0,0], rot: [0,0,0], scale: [1,1,1] };
const sph = (await partMesh({ id: 's', kind: 'sphere', params: { d: 40, sides: 96 }, xform: xf }, { blobs: new Map(), tools: {} })).tris;
// true deviation: sample new surface points -> distance to original, and original verts -> new
const dev = (a, b) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(b, 3)); const bvh = new MeshBVH(g); let m = 0; const v = new THREE.Vector3(), hit = {};
  for (let i = 0; i < a.length; i += 9) for (const w of [[1,0,0],[0,1,0],[0,0,1],[1/3,1/3,1/3]]) { v.set(a[i]*w[0]+a[i+3]*w[1]+a[i+6]*w[2], a[i+1]*w[0]+a[i+4]*w[1]+a[i+7]*w[2], a[i+2]*w[0]+a[i+5]*w[1]+a[i+8]*w[2]); m = Math.max(m, bvh.closestPointToPoint(v, hit).distance); } return m; };
let fail = 0;
for (const tol of [0.05, 0.1, 0.2, 0.5]) {
  const r = decimate(sph, { target: 0, tol });
  const a = dev(r.tris, sph), b = dev(sph, r.tris), ok = a <= tol && b <= tol && r.after < r.before;
  console.log(`${ok ? "ok  " : "FAIL"} limit ${tol}: ${r.before} -> ${r.after}, out ${a.toFixed(3)}, in ${b.toFixed(3)}`);
  if (!ok) fail++;
}
console.log(fail ? `${fail} FAILED` : "all passed");
if (fail) process.exitCode = 1;
