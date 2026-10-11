// Mesh welding, repair and the closed-solid check. No DOM, runs in the worker.
// A model is a triangle soup: Float32Array, 9 numbers per triangle, normals out.

export const WELD = 1e-4; // mm

/** Weld coincident vertices on a WELD grid. Returns positions and a 3-per-triangle index. */
export function weld(tris, tol = WELD) {
  const n = tris.length / 9;
  const map = new Map();
  const idx = new Int32Array(n * 3);
  const pos = [];
  for (let i = 0; i < n * 3; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const k = Math.round(x / tol) + ',' + Math.round(y / tol) + ',' + Math.round(z / tol);
    let v = map.get(k);
    if (v === undefined) {
      v = pos.length / 3;
      map.set(k, v);
      pos.push(x, y, z);
    }
    idx[i] = v;
  }
  return { pos: Float64Array.from(pos), idx, nv: pos.length / 3 };
}

export function volume(tris) {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function bounds(tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return { lo, hi };
}

/** Is this a closed solid? After welding every edge is used by exactly two
 *  triangles, in opposite directions, and the volume is positive. */
export function report(tris, tol = WELD) {
  const n = tris.length / 9;
  if (!n) return { triangles: 0, openEdges: 0, oversharedEdges: 0, flippedEdges: 0, volume: 0, watertight: false };
  const { pos, idx, nv } = weld(tris, tol);
  const und = new Map(), dir = new Map();
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const u = p < q ? p * nv + q : q * nv + p;
      und.set(u, (und.get(u) || 0) + 1);
      const d = p * nv + q;
      dir.set(d, (dir.get(d) || 0) + 1);
    }
  }
  let open = 0, over = 0, flip = 0;
  const overEdges = [];   // [x1, y1, z1, x2, y2, z2] of each over-shared edge: where pieces only touch
  for (const [u, c] of und) {
    if (c === 1) open++;
    else if (c > 2) {
      over++;
      const p = Math.floor(u / nv), q = u % nv;
      if (overEdges.length < 20000) overEdges.push([pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2], pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]]);
    }
  }
  for (const c of dir.values()) if (c > 1) flip++;
  const vol = volume(tris);
  return { triangles: n, openEdges: open, oversharedEdges: over, flippedEdges: flip, volume: vol,
    watertight: open === 0 && over === 0 && flip === 0 && vol > 0, overEdges };
}

/** The middle of the over-shared edges, rounded for a message. */
function overAt(rep) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const e of rep.overEdges) for (let i = 0; i < 6; i++) { lo[i % 3] = Math.min(lo[i % 3], e[i]); hi[i % 3] = Math.max(hi[i % 3], e[i]); }
  return lo.map((v, i) => +((v + hi[i]) / 2).toFixed(1));
}

/** Over-shared edges and no open ones: two pieces meet along an edge or face with nothing between them. */
export function thinWall(rep) {
  if (rep.watertight || !rep.oversharedEdges || rep.openEdges) return null;   // such an edge also counts as flipped
  const [x, y, z] = overAt(rep);
  return `Two parts touch with nothing between them, a wall of zero thickness, near X ${x}, Y ${y}, Z ${z} mm.`;
}

/** The clean-up every mesh tool owes its user: weld, drop zero-area and duplicate
 *  triangles, turn an inside-out mesh right way out. Says what it did. */
export function repair(tris, tol = WELD) {
  const before = report(tris, tol);
  const n = tris.length / 9;
  const { pos, idx, nv } = weld(tris, tol);
  const seen = new Set();
  const keep = [];
  let degenerate = 0, duplicates = 0;
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz <= 1e-24) { degenerate++; continue; }
    const s = [a, b, c].sort((p, q) => p - q);
    const k = s[0] + ',' + s[1] + ',' + s[2];
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    keep.push(a, b, c);
  }
  let out = new Float32Array(keep.length * 3);
  for (let i = 0; i < keep.length; i++) {
    const v = keep[i];
    out[i * 3] = pos[v * 3]; out[i * 3 + 1] = pos[v * 3 + 1]; out[i * 3 + 2] = pos[v * 3 + 2];
  }
  let flipped = false;
  if (out.length && volume(out) < 0) { flipAll(out); flipped = true; }
  return { tris: out, fixes: { welded: n * 3 - nv, degenerate, duplicates, flipped, before, after: report(out, tol) } };
}

export function flipAll(tris) {
  for (let i = 0; i < tris.length; i += 9) {
    for (let a = 0; a < 3; a++) {
      const t = tris[i + 3 + a]; tris[i + 3 + a] = tris[i + 6 + a]; tris[i + 6 + a] = t;
    }
  }
  return tris;
}

/** Neighbour triangle across each edge (ab, bc, ca); -1 where the edge is open
 *  or shared by more than two. Used for picking a connected face. */
export function adjacency(tris, tol = WELD) {
  const n = tris.length / 9;
  const { idx, nv } = weld(tris, tol);
  const first = new Map(), count = new Map();
  const adj = new Int32Array(n * 3).fill(-1);
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const p = idx[t * 3 + e], q = idx[t * 3 + (e + 1) % 3];
      const u = p < q ? p * nv + q : q * nv + p;
      count.set(u, (count.get(u) || 0) + 1);
      if (!first.has(u)) first.set(u, t * 3 + e);
    }
  }
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const p = idx[t * 3 + e], q = idx[t * 3 + (e + 1) % 3];
      const u = p < q ? p * nv + q : q * nv + p;
      if (count.get(u) !== 2) continue;
      const f = first.get(u);
      if (f !== t * 3 + e) { adj[t * 3 + e] = (f / 3) | 0; adj[f] = t; }
    }
  }
  return adj;
}

/** One line a person can read: what is wrong with a mesh that is not closed. */
export function describe(rep) {
  if (rep.watertight) return 'closed solid';
  const bits = [];
  if (rep.openEdges) bits.push(`${rep.openEdges} open`);
  if (rep.oversharedEdges) bits.push(`${rep.oversharedEdges} over-shared`);
  if (rep.flippedEdges) bits.push(`${rep.flippedEdges} flipped`);
  let s = bits.length ? `not closed: ${bits.join(', ')} edges` : 'not closed';
  if (rep.volume <= 0) s += bits.length ? ', no volume' : ': no volume';
  return s;
}

export class ToolError extends Error {}
