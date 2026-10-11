// Planar polygon fill that uses EVERY vertex it is given.
// earcut silently drops collinear and doubled points; a point one face keeps and
// its neighbour drops is a gap in the mesh. So: strip them first (with earcut's own
// test, so nothing is left for it to strip), triangulate, then split each triangle
// whose edge stood for a run of stripped points so those points are back on it.
import earcut from 'earcut';

const area = (p, q, r) => (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);

/**
 * rings: [outer, hole, hole...], each an array of [x, y] (open, no repeat of the first).
 * Returns { tris: [i, j, k, ...] counter-clockwise, extra: [[x, y, a, b, c], ...] }.
 * Indices count through the rings in order; extra points (rare centroids of the
 * triangle a, b, c, so a caller can give them a height) follow them.
 */
export function triangulate(rings) {
  const flat = [], holes = [], keptId = [];
  const between = new Map();     // "a,b" kept neighbours -> stripped ids from a to b
  const total = rings.reduce((s, r) => s + r.length, 0);
  let base = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const n = ring.length;
    // walk the ring dropping doubles and collinear points until stable
    let ids = [];
    for (let i = 0; i < n; i++) ids.push(i);
    const dropped = new Map(); // kept index -> [stripped indices after it, in order]
    let changed = true;
    while (changed && ids.length >= 3) {
      changed = false;
      const next = [];
      for (let k = 0; k < ids.length; k++) {
        const prev = next.length ? next[next.length - 1] : ids[ids.length - 1];
        const cur = ids[k], nx = ids[(k + 1) % ids.length];
        const p = ring[prev], q = ring[cur], s = ring[nx];
        const same = q[0] === s[0] && q[1] === s[1];
        if (same || area(p, q, s) === 0) {
          const host = prev;
          const list = dropped.get(host) || [];
          list.push(cur, ...(dropped.get(cur) || []));
          dropped.delete(cur);
          dropped.set(host, list);
          changed = true;
          continue;
        }
        next.push(cur);
      }
      ids = next;
    }
    if (ids.length < 3) { base += n; continue; }
    if (r > 0) holes.push(flat.length / 2);
    for (const i of ids) { flat.push(ring[i][0], ring[i][1]); keptId.push(base + i); }
    for (let k = 0; k < ids.length; k++) {
      const a = ids[k], b = ids[(k + 1) % ids.length];
      const list = dropped.get(a);
      if (list && list.length) between.set((base + a) + ',' + (base + b), list.map(i => base + i));
    }
    base += n;
  }
  const out = [], extra = [];
  if (flat.length < 6) return { tris: out, extra };
  const idx = earcut(flat, holes.length ? holes : null, 2);
  const all = [];
  for (const ring of rings) for (const p of ring) all.push(p);
  const P = i => (i < total ? all[i] : extra[i - total]);
  for (let t = 0; t < idx.length; t += 3) {
    let a = keptId[idx[t]], b = keptId[idx[t + 1]], c = keptId[idx[t + 2]];
    if (area(P(a), P(b), P(c)) > 0) [b, c] = [c, b];   // earcut's area sign is flipped: >0 here = clockwise
    const ins = (p, q) => between.get(p + ',' + q) || (between.get(q + ',' + p) || []).slice().reverse();
    const ab = ins(a, b), bc = ins(b, c), ca = ins(c, a);
    const busy = (ab.length > 0) + (bc.length > 0) + (ca.length > 0);
    if (!busy) { out.push(a, b, c); continue; }
    const poly = [a, ...ab, b, ...bc, c, ...ca];
    if (busy === 1) {
      // fan from the corner opposite the split edge
      const apex = ab.length ? c : bc.length ? a : b;
      const s = poly.indexOf(apex);
      const ring = poly.slice(s).concat(poly.slice(0, s));
      for (let k = 1; k < ring.length - 1; k++) out.push(apex, ring[k], ring[k + 1]);
    } else {
      const pa = P(a), pb = P(b), pc = P(c);
      extra.push([(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, a, b, c]);
      const m = total + extra.length - 1;
      for (let k = 0; k < poly.length; k++) out.push(m, poly[k], poly[(k + 1) % poly.length]);
    }
  }
  closeSlivers(out, rings, P);
  return { tris: out, extra };
}

// earcut can still drop a point that only became collinear part way through (points
// from two rings lined up in plan). That leaves a zero-area gap: a loop of edges used
// once that is not on any ring. Split the triangle on the gap's long edge so it runs
// through the dropped points. In 3D the rings sit at different heights, so the gap is
// a real hole there and this closes it.
function closeSlivers(out, rings, P) {
  const ringEdge = new Set();
  let base = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = base + i, b = base + ((i + 1) % r.length);
      ringEdge.add(a < b ? a + ',' + b : b + ',' + a);
    }
    base += r.length;
  }
  for (let pass = 0; pass < 4; pass++) {
    // gap edges: boundary half-edges that are not ring edges, and ring edges no triangle uses
    const owner = new Map(), used = new Set();
    for (let t = 0; t < out.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = out[t + e], b = out[t + (e + 1) % 3];
      owner.set(a + ',' + b, t);
      used.add(a < b ? a + ',' + b : b + ',' + a);
    }
    const nb = new Map();
    const link = (a, b) => { (nb.get(a) || nb.set(a, []).get(a)).push(b); (nb.get(b) || nb.set(b, []).get(b)).push(a); };
    for (const k of owner.keys()) {
      const [a, b] = k.split(',').map(Number);
      if (!owner.has(b + ',' + a) && !ringEdge.has(a < b ? k : b + ',' + a)) link(a, b);
    }
    for (const k of ringEdge) if (!used.has(k)) { const [a, b] = k.split(',').map(Number); link(a, b); }
    if (!nb.size) return;
    const done = new Set();
    const removed = new Set(), added = [];
    for (const start of nb.keys()) {
      if (done.has(start) || nb.get(start).length !== 2) continue;
      // walk the cycle
      const loop = [start];
      done.add(start);
      let prev = start, v = nb.get(start)[0], ok = true;
      while (v !== start) {
        if (done.has(v) || nb.get(v).length !== 2) { ok = false; break; }
        done.add(v); loop.push(v);
        const n2 = nb.get(v);
        const nx = n2[0] === prev ? n2[1] : n2[0];
        prev = v; v = nx;
      }
      if (!ok || loop.length < 3) continue;
      // the long edge is the triangle edge that runs past the dropped points
      const n = loop.length;
      const len = i => { const p = P(loop[i]), q = P(loop[(i + 1) % n]); return Math.hypot(q[0] - p[0], q[1] - p[1]); };
      let li = 0;
      for (let i = 1; i < n; i++) if (len(i) > len(li)) li = i;
      const A = loop[li], B = loop[(li + 1) % n];
      const between = [];
      for (let i = 2; i < n; i++) between.push(loop[(li + i) % n]);   // the cycle from B back round to A
      // fan the owning triangle along its edge, keeping its direction
      let chain, t = owner.get(A + ',' + B);
      if (t !== undefined) chain = [A, ...between.reverse(), B];
      else { t = owner.get(B + ',' + A); chain = [B, ...between, A]; }
      if (t === undefined || removed.has(t)) continue;
      const a = chain[0], b = chain[chain.length - 1];
      const c = [out[t], out[t + 1], out[t + 2]].find(x => x !== a && x !== b);
      removed.add(t);
      for (let i = 0; i < chain.length - 1; i++) added.push(c, chain[i], chain[i + 1]);
    }
    if (!removed.size) return;
    const kept = [];
    for (let t = 0; t < out.length; t += 3) if (!removed.has(t)) kept.push(out[t], out[t + 1], out[t + 2]);
    out.length = 0;
    out.push(...kept, ...added);
  }
}

/** Signed area of a ring of [x, y]; positive = counter-clockwise. */
export function ringArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** Point in ring, even-odd. */
export function inRing(pt, r) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Group loops by even-odd nesting: [{outer: loopIndex, holes: [loopIndex...]}]. */
export function nest(loops) {
  const depth = loops.map((l, i) => loops.reduce((d, m, j) => d + (j !== i && inRing(l[0], m) ? 1 : 0), 0));
  const groups = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = [];
    loops.forEach((m, j) => { if (depth[j] === depth[i] + 1 && inRing(m[0], l)) holes.push(j); });
    groups.push({ outer: i, holes });
  });
  return groups;
}
