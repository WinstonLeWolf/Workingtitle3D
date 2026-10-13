// Make solid: rebuild any triangle soup (holes, overlaps, flipped or stray faces) as one
// closed surface. No DOM, runs in the worker.
//
// f(p) = +d outside, -d inside, d = distance to the nearest triangle. Inside is a vote of
// three rays, along X, Y and Z: a hole lets one ray through, rarely two. The surface f = 0
// is cut by marching tetrahedra on a grid of h, refined from 8-voxel cells down to voxels
// only where it can pass, so the work follows the area, not the volume. Grid vertices are
// shared by grid edge, so the result is closed by construction. Pieces smaller than a few
// voxels (specks from a confused vote) are dropped.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, ToolError } from './meshcheck.js';

const TOP = 3;
const NUDGE = 0.01;
const TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];

/** tris: soup. h: voxel size, mm. Returns a closed soup. */
export function solidify(tris, h, progress = () => {}) {
  const W = weld(tris);
  const nT = W.idx.length / 3;
  if (!nT) throw new ToolError('Nothing to make solid: the mesh has no triangles.');
  const g0 = new THREE.BufferGeometry();
  g0.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(W.pos), 3));
  g0.setIndex(new THREE.BufferAttribute(Uint32Array.from(W.idx), 1));
  const bvh = new MeshBVH(g0);

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < W.nv; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], W.pos[v * 3 + a]); hi[a] = Math.max(hi[a], W.pos[v * 3 + a]); }
  const B = 1 << TOP;
  const jit = [0.000731, 0.000419, 0.000277];
  const org = lo.map((v, a) => v - 2 * h + jit[a] * h);
  const nc = lo.map((v, a) => Math.ceil((hi[a] - v + 4 * h) / h / B) * B);
  const NX = nc[0] + 1, NY = nc[1] + 1;
  const L = (i, j, k) => i + NX * (j + NY * k);
  const R0 = (B * h * Math.sqrt(3)) / 2;
  const cap = R0 + 2 * h;

  // three families of axis rays, cached per column; a point is inside when two of three say so
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  const cache = [new Map(), new Map(), new Map()];
  const column = (axis, u, v) => {
    const key = u + 100003 * v;
    let c = cache[axis].get(key);
    if (c) return c;
    const o = [0, 0, 0], d = [0, 0, 0];
    const ua = (axis + 1) % 3, va = (axis + 2) % 3;
    o[axis] = org[axis] - h; o[ua] = org[ua] + u * h; o[va] = org[va] + v * h;
    d[axis] = 1;
    ray.origin.set(o[0], o[1], o[2]); ray.direction.set(d[0], d[1], d[2]);
    const hits = bvh.raycast(ray, THREE.DoubleSide)
      .map(x => ({ t: x.point.getComponent(axis), s: x.face.normal.getComponent(axis) < 0 ? 1 : -1 }))
      .sort((p, q) => p.t - q.t);
    const t = [], s = [];
    for (const x of hits) {
      const k = t.length - 1;
      if (k >= 0 && Math.abs(x.t - t[k]) < 1e-6 && s[k] === x.s) continue;
      t.push(x.t); s.push(x.s);
    }
    c = { t, s };
    cache[axis].set(key, c);
    return c;
  };
  const insideAxis = (axis, ijk, x) => {
    const ua = (axis + 1) % 3, va = (axis + 2) % 3;
    const c = column(axis, ijk[ua], ijk[va]);
    // winding from the facing of each crossing (overlapping pieces), or odd parity (faces
    // turned the wrong way)
    let w = 0, n = 0;
    for (let q = 0; q < c.t.length && c.t[q] < x; q++) { w += c.s[q]; n++; }
    return w > 0 || (n & 1) === 1;
  };
  const ijk = [0, 0, 0];
  const vq = new THREE.Vector3(), hit = {};
  const G = new Map();
  const f = (i, j, k) => {
    const key = L(i, j, k);
    let v = G.get(key);
    if (v !== undefined) return v;
    const x = org[0] + i * h, y = org[1] + j * h, z = org[2] + k * h;
    ijk[0] = i; ijk[1] = j; ijk[2] = k;
    const votes = (insideAxis(0, ijk, x) ? 1 : 0) + (insideAxis(1, ijk, y) ? 1 : 0) + (insideAxis(2, ijk, z) ? 1 : 0);
    vq.set(x, y, z);
    const r = bvh.closestPointToPoint(vq, hit, 0, cap);
    const d = r ? r.distance : cap;
    v = votes >= 2 ? -d : d;
    // the grid's outer layer is outside, whatever the vote says, so the surface never reaches it
    if (i === 0 || j === 0 || k === 0 || i === nc[0] || j === nc[1] || k === nc[2]) v = Math.max(Math.abs(v), h);
    if (Math.abs(v) < NUDGE * h) v = v >= 0 ? NUDGE * h : -NUDGE * h;
    G.set(key, v);
    return v;
  };

  // refine: keep a cell if the surface can pass through it, or if its corners disagree
  // (a vote flipping across a wide hole, far from any triangle)
  let cells = [];
  for (let k = 0; k < nc[2]; k += B) for (let j = 0; j < nc[1]; j += B) for (let i = 0; i < nc[0]; i += B) cells.push(i, j, k);
  for (let m = TOP; m >= 1; m--) {
    const size = 1 << m, half = size >> 1;
    const R = (size * h * Math.sqrt(3)) / 2;
    const next = [];
    const count = cells.length / 3;
    for (let c = 0; c < cells.length; c += 3) {
      const i = cells[c], j = cells[c + 1], k = cells[c + 2];
      const mid = f(i + half, j + half, k + half);
      let keep = Math.abs(mid) <= R + 1e-9;
      if (!keep) {
        for (let q = 0; q < 8 && !keep; q++) {
          const cv = f(i + (q & 1) * size, j + ((q >> 1) & 1) * size, k + ((q >> 2) & 1) * size);
          if ((cv > 0) !== (mid > 0)) keep = true;
        }
      }
      if (!keep) continue;
      for (let dz = 0; dz < size; dz += half) for (let dy = 0; dy < size; dy += half) for (let dx = 0; dx < size; dx += half) next.push(i + dx, j + dy, k + dz);
      if ((c / 3) % 4000 === 0) progress(0.05 + 0.6 * ((TOP - m) + c / 3 / count) / TOP, 'finding the surface');
    }
    cells = next;
  }

  // march
  const cv = [], ce = new Map(), ct = [];
  const P = c => [org[0] + (c % NX) * h, org[1] + (Math.floor(c / NX) % NY) * h, org[2] + Math.floor(c / (NX * NY)) * h];
  // a grid edge is its lower corner and the step to the other (each axis -1, 0 or +1)
  const edgeKey = (a, b) => {
    const dx = (b % NX) - (a % NX), dy = (Math.floor(b / NX) % NY) - (Math.floor(a / NX) % NY), dz = Math.floor(b / (NX * NY)) - Math.floor(a / (NX * NY));
    return a * 27 + (dx + 1) + 3 * (dy + 1) + 9 * (dz + 1);
  };
  const edgeVertex = (a, b, ga, gb) => {
    if (a > b) { [a, b] = [b, a]; [ga, gb] = [gb, ga]; }
    const key = edgeKey(a, b);
    let id = ce.get(key);
    if (id !== undefined) return id;
    const pa = P(a), pb = P(b), u = ga / (ga - gb);
    id = cv.length / 3;
    cv.push(pa[0] + (pb[0] - pa[0]) * u, pa[1] + (pb[1] - pa[1]) * u, pa[2] + (pb[2] - pa[2]) * u);
    ce.set(key, id);
    return id;
  };
  const corner = new Array(8), val = new Array(8);
  const total = cells.length / 3;
  // the refinement can miss a vote flipping far from any triangle; so march outwards from every
  // cell with a crossing into each neighbour whose shared face has mixed corners, until none is
  // left: then no crossing reaches the edge of the marched region, and the surface is closed
  const done = new Set();
  for (let c = 0; c < cells.length; c += 3) done.add(L(cells[c], cells[c + 1], cells[c + 2]));
  const FACES = [[0, -1, [0, 2, 4, 6]], [0, 1, [1, 3, 5, 7]], [1, -1, [0, 1, 4, 5]], [1, 1, [2, 3, 6, 7]], [2, -1, [0, 1, 2, 3]], [2, 1, [4, 5, 6, 7]]];
  for (let c = 0; c < cells.length; c += 3) {
    const i = cells[c], j = cells[c + 1], k = cells[c + 2];
    let pos = 0;
    for (let q = 0; q < 8; q++) {
      const ii = i + (q & 1), jj = j + ((q >> 1) & 1), kk = k + ((q >> 2) & 1);
      corner[q] = L(ii, jj, kk);
      val[q] = f(ii, jj, kk);
      if (val[q] > 0) pos++;
    }
    if (pos === 0 || pos === 8) continue;
    for (const [axis, dir, qs] of FACES) {
      let fp = 0;
      for (const q of qs) if (val[q] > 0) fp++;
      if (fp === 0 || fp === 4) continue;
      const nb = [i, j, k];
      nb[axis] += dir;
      if (nb[axis] < 0 || nb[axis] >= nc[axis]) continue;
      const key = L(nb[0], nb[1], nb[2]);
      if (done.has(key)) continue;
      done.add(key);
      cells.push(nb[0], nb[1], nb[2]);
    }
    for (const tet of TETS) {
      const pIn = [], pOut = [];   // pIn: outside (f > 0)
      for (const q of tet) (val[q] > 0 ? pIn : pOut).push(q);
      if (!pIn.length || !pOut.length) continue;
      const ev = (a, b) => edgeVertex(corner[a], corner[b], val[a], val[b]);
      let faces;
      if (pIn.length === 1) faces = [[ev(pIn[0], pOut[0]), ev(pIn[0], pOut[1]), ev(pIn[0], pOut[2])]];
      else if (pOut.length === 1) faces = [[ev(pOut[0], pIn[0]), ev(pOut[0], pIn[1]), ev(pOut[0], pIn[2])]];
      else {
        const [a, b] = pIn, [cc, d] = pOut;
        const q = [ev(a, cc), ev(a, d), ev(b, d), ev(b, cc)];
        faces = [[q[0], q[1], q[2]], [q[0], q[2], q[3]]];
      }
      const dir = [0, 0, 0];
      for (const q of pIn) { const p = P(corner[q]); for (let a = 0; a < 3; a++) dir[a] += p[a] / pIn.length; }
      for (const q of pOut) { const p = P(corner[q]); for (let a = 0; a < 3; a++) dir[a] -= p[a] / pOut.length; }
      for (const fc of faces) {
        if (fc[0] === fc[1] || fc[1] === fc[2] || fc[0] === fc[2]) continue;
        const nm = triNormal(cv, fc);
        ct.push(...(nm[0] * dir[0] + nm[1] * dir[1] + nm[2] * dir[2] >= 0 ? fc : [fc[0], fc[2], fc[1]]));
      }
    }
    if ((c / 3) % 5000 === 0) progress(0.65 + 0.25 * (c / 3 / total), 'building the surface');
  }
  if (!ct.length) throw new ToolError('Make solid found no inside: the mesh may be a single open sheet. Try a coarser grid.');

  // drop specks: pieces with fewer than 1% of the largest piece's triangles
  const nf = ct.length / 3;
  const parent = new Int32Array(cv.length / 3).map((_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let t = 0; t < nf; t++) {
    const a = find(ct[t * 3]), b = find(ct[t * 3 + 1]), c = find(ct[t * 3 + 2]);
    if (a !== b) parent[a] = b;
    const b2 = find(b);
    if (find(c) !== b2) parent[find(c)] = b2;
  }
  const count = new Map();
  for (let t = 0; t < nf; t++) { const r = find(ct[t * 3]); count.set(r, (count.get(r) || 0) + 1); }
  const biggest = Math.max(...count.values());
  const out = [];
  let specks = 0;
  for (let t = 0; t < nf; t++) {
    if (count.get(find(ct[t * 3])) < biggest * 0.01) { specks++; continue; }
    for (let q = 0; q < 3; q++) { const v = ct[t * 3 + q] * 3; out.push(cv[v], cv[v + 1], cv[v + 2]); }
  }
  return { tris: Float32Array.from(out), specks: specks ? new Set([...count.entries()].filter(([, n]) => n < biggest * 0.01).map(([r]) => r)).size : 0 };
}

function triNormal(V, fc) {
  const a = fc[0] * 3, b = fc[1] * 3, c = fc[2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
