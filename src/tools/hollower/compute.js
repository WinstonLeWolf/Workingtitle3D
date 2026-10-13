// Hollow a closed solid to a set wall, optionally opening it through one flat face.
//
// The outer surface is kept exactly. The cavity is the surface g = 0 of
//   g = inside ? d - t : -t        (d = distance to the mesh, t = wall)
// g is 1-Lipschitz, so a cell whose centre has |g| > half its diagonal cannot hold the
// surface; cells are refined from 8 voxels down to 1 only where it can. The surface is
// cut by marching tetrahedra (no ambiguous cases, always closed). Cavity vertices are
// shared by grid edge, so the cavity is closed by construction.
//
// Open face F: distances ignore F, so the cavity runs up to it; beyond F's plane g is
// taken from the plane (extruded), so the cavity leaves through F as a straight prism.
// F is removed, the cavity is cut at F's plane, and the rim between F's edge and the
// cavity's section is filled flat.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, ToolError } from '../../core/meshcheck.js';
import { triangulate, nest } from '../../core/tri2d.js';
import { problem } from './limits.js';

const TOP = 3;                 // top cells are 2^3 = 8 voxels a side
const NUDGE = 0.01;            // |g| kept at least this many voxels from zero

// tets of a cube, corners numbered x + 2y + 4z; all share the 0-7 diagonal, so
// neighbouring cubes split their shared faces the same way
const TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];

export async function run(tris, p, ctx) {
  const bad = problem(p);
  if (bad) throw new ToolError(bad);
  const t = p.wall, h = p.voxel;
  const sel = p.open ? ctx.selection : [];
  if (p.open && !sel.length) throw new ToolError('Pick the face to open in the view, or untick "Open through a face".');

  // outer mesh, indexed
  const W = weld(tris);
  const nT = tris.length / 9;
  const inF = new Uint8Array(nT);
  for (const f of sel) inF[f] = 1;

  // the open face's plane, and the check that F is on the outside
  let n = null, dPlane = 0;
  if (sel.length) {
    const nn = [0, 0, 0];
    for (const f of sel) {
      const i = f * 9;
      const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
      const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
      nn[0] += uy * vz - uz * vy; nn[1] += uz * vx - ux * vz; nn[2] += ux * vy - uy * vx;
    }
    const l = Math.hypot(...nn);
    n = nn.map(v => v / l);
    const f0 = sel[0] * 9;
    dPlane = n[0] * tris[f0] + n[1] * tris[f0 + 1] + n[2] * tris[f0 + 2];
    let beyond = 0;
    for (let v = 0; v < W.nv; v++) beyond = Math.max(beyond, n[0] * W.pos[v * 3] + n[1] * W.pos[v * 3 + 1] + n[2] * W.pos[v * 3 + 2] - dPlane);
    if (beyond > 1e-3) {
      throw new ToolError(`The picked face is not on the outside: the part reaches ${beyond.toFixed(2)} mm past its plane. Pick a face nothing sticks out beyond.`);
    }
  }

  ctx.progress(0.02, 'indexing');
  const geo = (skipF) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(W.pos), 3));
    const idx = [];
    for (let f = 0; f < nT; f++) if (!(skipF && inF[f])) idx.push(W.idx[f * 3], W.idx[f * 3 + 1], W.idx[f * 3 + 2]);
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
    return g;
  };
  const bvhAll = new MeshBVH(geo(false));
  const bvhDist = sel.length ? new MeshBVH(geo(true)) : bvhAll;

  // grid
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < W.nv; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], W.pos[v * 3 + a]); hi[a] = Math.max(hi[a], W.pos[v * 3 + a]); }
  const B = 1 << TOP;
  const jit = [0.000731, 0.000419, 0.000277];   // keep grid columns off round coordinates
  const org = lo.map((v, a) => v - 2 * h + jit[a] * h);
  const nc = lo.map((v, a) => Math.ceil((hi[a] - v + 4 * h) / h / B) * B);
  const NX = nc[0] + 1, NY = nc[1] + 1;
  const L = (i, j, k) => i + NX * (j + NY * k);
  const RTOP = (B * h * Math.sqrt(3)) / 2;
  const cap = t + RTOP + h;

  // inside test by +z columns: winding from the facing of each crossing
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  const cols = new Map();
  const column = (i, j) => {
    const key = i + NX * j;
    let c = cols.get(key);
    if (c) return c;
    ray.origin.set(org[0] + i * h, org[1] + j * h, org[2] - h);
    ray.direction.set(0, 0, 1);
    c = crossings(bvhAll.raycast(ray, THREE.DoubleSide), ray.direction, ray.origin, 2);
    cols.set(key, c);
    return c;
  };
  const insideCol = (i, j, z) => {
    const c = column(i, j);
    let w = 0;
    for (let q = 0; q < c.z.length && c.z[q] < z; q++) w += c.s[q];
    return w > 0;
  };
  const oddDir = new THREE.Vector3(0.0123, 0.0371, 1).normalize();
  const insideRay = q => {
    ray.origin.set(q[0], q[1], q[2]);
    ray.direction.copy(oddDir);
    const c = crossings(bvhAll.raycast(ray, THREE.DoubleSide), ray.direction, null, -1);
    let w = 0;
    for (let k = 0; k < c.s.length; k++) w -= c.s[k];   // leaving counts +1
    return w > 0;
  };

  const vq = new THREE.Vector3(), hit = {};
  const dist = (x, y, z) => {
    vq.set(x, y, z);
    const r = bvhDist.closestPointToPoint(vq, hit, 0, cap);
    return r ? r.distance : cap;
  };
  const delta = Math.min(0.01, 0.05 * h);
  const G = new Map();
  let evals = 0;
  const g = (i, j, k) => {
    const key = L(i, j, k);
    let v = G.get(key);
    if (v !== undefined) return v;
    evals++;
    let x = org[0] + i * h, y = org[1] + j * h, z = org[2] + k * h;
    let inside;
    const s = n ? n[0] * x + n[1] * y + n[2] * z - dPlane : -1;
    if (s > -delta) {
      // at or beyond the open face: take the value from just inside the plane
      const m = s + delta;
      x -= n[0] * m; y -= n[1] * m; z -= n[2] * m;
      inside = insideRay([x, y, z]);
    } else inside = insideCol(i, j, z);
    v = inside ? Math.min(dist(x, y, z), cap) - t : -t;
    if (Math.abs(v) < NUDGE * h) v = v >= 0 ? NUDGE * h : -NUDGE * h;
    G.set(key, v);
    return v;
  };

  // refine from top cells down to voxels, keeping cells that can hold g = 0
  let cells = [];
  for (let k = 0; k < nc[2]; k += B) for (let j = 0; j < nc[1]; j += B) for (let i = 0; i < nc[0]; i += B) cells.push(i, j, k);
  for (let m = TOP; m >= 1; m--) {
    const size = 1 << m, half = size >> 1;
    const R = (size * h * Math.sqrt(3)) / 2;
    const next = [];
    const count = cells.length / 3;
    for (let c = 0; c < cells.length; c += 3) {
      const i = cells[c], j = cells[c + 1], k = cells[c + 2];
      if (Math.abs(g(i + half, j + half, k + half)) > R + 1e-9) continue;
      for (let dz = 0; dz < size; dz += half) for (let dy = 0; dy < size; dy += half) for (let dx = 0; dx < size; dx += half) next.push(i + dx, j + dy, k + dz);
      if ((c / 3) % 2000 === 0) ctx.progress(0.05 + 0.55 * ((TOP - m) + c / 3 / count) / TOP, `refining (${m === TOP ? 'coarse' : m === 1 ? 'fine' : 'medium'})`);
    }
    cells = next;
  }

  // march
  const cv = [];                 // cavity vertices, xyz
  const ce = new Map();          // grid edge -> cavity vertex
  const ct = [];                 // cavity triangles
  const P = (c) => [org[0] + (c % NX) * h, org[1] + (Math.floor(c / NX) % NY) * h, org[2] + Math.floor(c / (NX * NY)) * h];
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
  for (let c = 0; c < cells.length; c += 3) {
    const i = cells[c], j = cells[c + 1], k = cells[c + 2];
    let pos = 0;
    for (let q = 0; q < 8; q++) {
      const ii = i + (q & 1), jj = j + ((q >> 1) & 1), kk = k + ((q >> 2) & 1);
      corner[q] = L(ii, jj, kk);
      val[q] = g(ii, jj, kk);
      if (val[q] > 0) pos++;
    }
    if (pos === 0 || pos === 8) continue;
    for (const tet of TETS) {
      const pIn = [], pOut = [];
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
      // face the cavity (towards g > 0), away from the material
      const dir = [0, 0, 0];
      for (const q of pIn) { const p = P(corner[q]); dir[0] += p[0] / pIn.length; dir[1] += p[1] / pIn.length; dir[2] += p[2] / pIn.length; }
      for (const q of pOut) { const p = P(corner[q]); dir[0] -= p[0] / pOut.length; dir[1] -= p[1] / pOut.length; dir[2] -= p[2] / pOut.length; }
      for (const f of faces) {
        const nrm = triNormal(cv, f);
        ct.push(...(nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2] >= 0 ? f : [f[0], f[2], f[1]]));
      }
    }
    if ((c / 3) % 5000 === 0) ctx.progress(0.6 + 0.3 * (c / 3 / total), 'cutting the cavity');
  }
  if (!ct.length) throw new ToolError(`Nothing to hollow: the part is thinner than twice the wall (${(2 * t).toFixed(2)} mm) everywhere.`);

  // assemble: outer (minus F), cavity (cut at F's plane), rim
  const V = Array.from(W.pos);
  const out = [];
  for (let f = 0; f < nT; f++) if (!inF[f]) out.push(W.idx[f * 3], W.idx[f * 3 + 1], W.idx[f * 3 + 2]);
  const base = V.length / 3;
  for (const x of cv) V.push(x);
  // measured on a box (tests/hollow_accuracy.mjs): flat walls within ~0.01 mm, sharp inside edges cut by h/2
  const notes = [`Wall ${t.toFixed(2)} mm. Inside edges and corners are cut off by up to ${(h / 2).toFixed(2)} mm; a finer resolution sharpens them.`];

  if (!sel.length) {
    for (const v of ct) out.push(base + v);
    notes.push('Closed hollow: no opening. Add one by picking a face.');
  } else {
    ctx.progress(0.92, 'opening the face');
    const side = v => n[0] * V[v * 3] + n[1] * V[v * 3 + 1] + n[2] * V[v * 3 + 2] - dPlane;
    const cut = new Map();
    const segs = [];
    const cross = (a, b) => {
      const sa = side(a), sb = side(b);
      if (Math.abs(sb) < 1e-9) return b;
      if (Math.abs(sa) < 1e-9) return a;
      const key = a < b ? a + ',' + b : b + ',' + a;
      let id = cut.get(key);
      if (id !== undefined) return id;
      const u = sa / (sa - sb);
      id = V.length / 3;
      for (let q = 0; q < 3; q++) V.push(V[a * 3 + q] + (V[b * 3 + q] - V[a * 3 + q]) * u);
      cut.set(key, id);
      return id;
    };
    for (let q = 0; q < ct.length; q += 3) {
      const tri = [base + ct[q], base + ct[q + 1], base + ct[q + 2]];
      const s = tri.map(side);
      const inn = s.map(x => x < 0);
      if (inn[0] && inn[1] && inn[2]) { out.push(...tri); continue; }
      if (!inn[0] && !inn[1] && !inn[2]) continue;
      // keep the part below the plane, in order
      const poly = [], onPlane = [];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        if (inn[e]) poly.push(a);
        if (inn[e] !== inn[(e + 1) % 3]) { const x = inn[e] ? cross(a, b) : cross(b, a); poly.push(x); onPlane.push(poly.length - 1); }
      }
      for (let e = 1; e < poly.length - 1; e++) {
        if (poly[0] !== poly[e] && poly[e] !== poly[e + 1] && poly[0] !== poly[e + 1]) out.push(poly[0], poly[e], poly[e + 1]);
      }
      if (onPlane.length === 2) {
        const a = poly[onPlane[0]], b = poly[onPlane[1]];
        // the section runs between the two cut points, in the polygon's order
        const first = (onPlane[1] === onPlane[0] + 1) ? [a, b] : [b, a];
        if (first[0] !== first[1]) segs.push(first);
      }
    }
    // F's boundary, directed as F's triangles run (counter-clockwise seen from outside)
    const fe = new Map();
    for (const f of sel) for (let e = 0; e < 3; e++) {
      const a = W.idx[f * 3 + e], b = W.idx[f * 3 + (e + 1) % 3];
      fe.set(a + ',' + b, [a, b]);
    }
    const fEdges = [...fe.values()].filter(([a, b]) => !fe.has(b + ',' + a));
    const fLoops = chain(fEdges), sLoops = chain(segs);
    const loops = [...fLoops, ...sLoops];
    // project onto F's plane: (u, v, n) right-handed, so counter-clockwise faces +n
    const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(crossV(ax, n)), w = crossV(n, u);
    const uv = id => [u[0] * V[id * 3] + u[1] * V[id * 3 + 1] + u[2] * V[id * 3 + 2], w[0] * V[id * 3] + w[1] * V[id * 3 + 1] + w[2] * V[id * 3 + 2]];
    const loops2 = loops.map(l => l.map(uv));
    const opened = nest(loops2.slice(fLoops.length)).length;
    for (const grp of nest(loops2)) {
      const ids = [grp.outer, ...grp.holes];
      const rings = ids.map(i => loops2[i]);
      const flatIds = ids.flatMap(i => loops[i]);
      const { tris: rt, extra } = triangulate(rings);
      for (const [x, y] of extra) {
        flatIds.push(V.length / 3);
        for (let q = 0; q < 3; q++) V.push(u[q] * x + w[q] * y + n[q] * dPlane);
      }
      for (let q = 0; q < rt.length; q++) out.push(flatIds[rt[q]]);
    }
    notes.push(opened ? `Opened through the picked face: ${opened} opening${opened > 1 ? 's' : ''}.`
      : 'The picked face is too small for an opening at this wall: it stays closed.');
  }
  ctx.progress(0.97, 'assembling');
  const res = new Float32Array(out.length * 3);
  for (let q = 0; q < out.length; q++) {
    const v = out[q] * 3;
    res[q * 3] = V[v]; res[q * 3 + 1] = V[v + 1]; res[q * 3 + 2] = V[v + 2];
  }
  return { tris: res, notes };
}

/** Ray crossings, sorted, with doubles from shared edges merged. s: +1 entering, -1 leaving. */
function crossings(hits, dir, origin, axis) {
  const list = hits.map(hh => ({ d: axis === 2 ? hh.point.z : hh.distance, s: hh.face.normal.dot(dir) < 0 ? 1 : -1 }))
    .sort((a, b) => a.d - b.d);
  const z = [], s = [];
  for (const c of list) {
    const k = z.length - 1;
    if (k >= 0 && Math.abs(c.d - z[k]) < 1e-6 && s[k] === c.s) continue;
    z.push(c.d); s.push(c.s);
  }
  return { z, s };
}

/** Directed edges -> closed loops of vertex ids. */
function chain(edges) {
  const next = new Map();
  for (const [a, b] of edges) (next.get(a) || next.set(a, []).get(a)).push(b);
  const loops = [];
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop = [start];
      let v = next.get(start).pop();
      while (v !== start && next.get(v)?.length) { loop.push(v); v = next.get(v).pop(); }
      if (v === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

function triNormal(V, f) {
  const a = f[0] * 3, b = f[1] * 3, c = f[2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
