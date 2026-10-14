// Edge profiles on flat parts, in the worker. Port of an earlier Python prototype.
// No booleans: the outline is offset inward in rings (clipper, integer coords), each
// ring lifted to the profile height for its distance from the edge, rings joined into
// bands, then walls and the opposite face added, all on shared vertices. Closed by
// construction; on narrow strips the rings run out and the slopes meet in a ridge.
import ClipperLib from 'clipper-lib';
import { triangulate } from '../../core/tri2d.js';
import { ToolError } from '../../core/meshcheck.js';
import { levels, problem, RING_STEP } from './profile.js';

const S = 1e4;              // clipper units per mm (0.1 um), so shared ring vertices match exactly
const ARC_TOL = 0.01;       // mm, rounded inner corners
const CLEAN = 1.415;        // clipper units: drop points closer than this to their neighbours' line

export async function run(tris, p, ctx) {
  if (p.edges && p.edges !== 'all') return picked(tris, p, ctx);
  ctx?.progress?.(0.05, 'outline');
  const part = flatPart(tris);
  const t = part.z1 - part.z0;
  const bad = problem(p, t);
  if (bad) throw new ToolError(bad);
  ctx.progress(0.1, 'outline');
  const base = part.region;
  const lv = levels(p, t);
  const m = new Builder();

  let top0 = t, bot0 = 0;
  if (p.face === 'top' || p.face === 'both') {
    surface(m, base, lv, t, true, f => ctx.progress(0.15 + 0.4 * f, 'top rings'));
    top0 = lv[0][1];
  } else fillFlat(m, base, t, true);
  if (p.face === 'bottom' || p.face === 'both') {
    surface(m, base, lv.map(([d, z]) => [d, t - z]), 0, false, f => ctx.progress(0.55 + 0.4 * f, 'bottom rings'));
    bot0 = t - lv[0][1];
  } else fillFlat(m, base, 0, false);
  for (const P of base) for (const r of [P.outer, ...P.holes]) wall(m, r, bot0, top0);
  return { tris: m.array(part.z0), notes: [`Rings: ${lv.length}. Part ${t.toFixed(2)} mm thick.`] };
}

// ---- some edges only ----------------------------------------------------------------------
// The rings above measure each point's distance to the whole outline. For some edges only, the
// same profile is measured to those edges alone: each chosen edge gets the cut-away part of the
// section swept along it, and turned round its ends, and all of that is taken out of the part
// at once. A cut beside an edge left alone runs straight out through that wall. With every
// edge chosen this matches the ring result.
const LIFT = 1;   // mm the cutters reach past the treated face

async function picked(tris, p, ctx) {
  const K = ctx.kernel;
  if (!K) throw new ToolError('Picked edges need the solid kernel.');
  ctx?.progress?.(0.05, 'outline');
  const part = flatPart(tris);
  const t = part.z1 - part.z0;
  const bad = problem(p, t);
  if (bad) throw new ToolError(bad);
  const segs = ctx.selection?.segs || [];
  if (!segs.length) throw new ToolError(p.edges === 'only' ? 'Pick the side walls whose edges to shape.' : 'Pick the side walls to leave alone.');
  ctx.progress(0.1, 'edges');
  // the outline's edges, in mm, and which of them were picked (a picked wall lies along it)
  const edges = [];
  for (const P of part.region) for (const r of [P.outer, ...P.holes]) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      edges.push([a.X / S, a.Y / S, b.X / S, b.Y / S]);
    }
  }
  const onPick = e => {
    const mx = (e[0] + e[2]) / 2, my = (e[1] + e[3]) / 2, ex = e[2] - e[0], ey = e[3] - e[1], el = Math.hypot(ex, ey) || 1;
    return segs.some(([x1, y1, x2, y2]) => {
      const sx = x2 - x1, sy = y2 - y1, sl = Math.hypot(sx, sy) || 1;
      if (Math.abs(ex * sy - ey * sx) / (el * sl) > 1e-3) return false;   // not parallel
      const u = Math.max(0, Math.min(1, ((mx - x1) * sx + (my - y1) * sy) / (sl * sl)));
      return Math.hypot(mx - x1 - u * sx, my - y1 - u * sy) < 0.01;
    });
  };
  const hits = edges.map(onPick);
  if (!hits.some(Boolean)) throw new ToolError('None of the picked walls is a side wall of this part as it is now. Pick them again.');
  const chosen = edges.filter((e, i) => (p.edges === 'only') === hits[i]);
  if (!chosen.length) throw new ToolError('Every edge is picked to be left alone, so nothing would change.');

  const { M } = K;
  const lv = levels(p, t);
  const w = lv[lv.length - 1][0];
  const faces = [];
  if (p.face === 'top' || p.face === 'both') faces.push({ prof: lv, past: t + LIFT });
  if (p.face === 'bottom' || p.face === 'both') faces.push({ prof: lv.map(([d, z]) => [d, t - z]), past: -LIFT });
  const area = poly => poly.reduce((s, q, i) => { const r = poly[(i + 1) % poly.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0);
  const ccw = poly => (area(poly) < 0 ? poly.slice().reverse() : poly);
  const cutters = [];
  const segsRound = Math.min(128, Math.max(16, Math.ceil((2 * Math.PI * w) / RING_STEP)));
  for (const { prof, past } of faces) {
    // section of what is cut away, (across the edge, height): one side for turning round an
    // end, both sides (mirrored) for sweeping along an edge
    const right = ccw([...prof, [w, past], [0, past]]);
    const whole = ccw([[w, past], ...prof.slice().reverse(), ...prof.slice(1).map(([d, z]) => [-d, z]), [-w, past]]);
    const across = new M.CrossSection([whole]);
    const round = new M.CrossSection([right]);
    const ends = new Set();
    for (const [x1, y1, x2, y2] of chosen) {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const ux = dx / L, uy = dy / L;
      // columns: section x -> across the edge, section y -> up, extrude -> along the edge
      const m = [-uy, ux, 0, 0, 0, 0, 1, 0, ux, uy, 0, 0, x1, y1, part.z0, 1];
      const bar = across.extrude(L);
      cutters.push(bar.transform(m));
      bar.delete();
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        const k = `${x.toFixed(5)},${y.toFixed(5)}`;
        if (ends.has(k)) continue;
        ends.add(k);
        const r = M.Manifold.revolve(round, segsRound);
        cutters.push(r.translate([x, y, part.z0]));
        r.delete();
      }
    }
    across.delete(); round.delete();
  }
  ctx.progress(0.5, 'cutting');
  const solid = K.toManifold(tris);
  const cut = M.Manifold.union(cutters);
  const out = solid.subtract(cut);
  const res = K.toTris(out);
  for (const m of [...cutters, cut, out, solid]) m.delete();
  const n = chosen.length;
  return { tris: res, notes: [`${n} edge${n === 1 ? '' : 's'} shaped. Part ${t.toFixed(2)} mm thick.`] };
}

// ---- outline from a flat mesh ------------------------------------------------------------
function flatPart(tris) {
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 2; i < tris.length; i += 3) { z0 = Math.min(z0, tris[i]); z1 = Math.max(z1, tris[i]); }
  const span = z1 - z0;
  if (span < 1e-6) throw new ToolError('The part has no thickness.');
  const tol = Math.max(1e-3, span * 1e-4);
  let worst = 0;
  for (let i = 2; i < tris.length; i += 3) worst = Math.max(worst, Math.min(Math.abs(tris[i] - z0), Math.abs(tris[i] - z1)));
  if (worst > tol) {
    throw new ToolError(`Not a flat part: it has corners between the top and bottom faces (worst ${worst.toFixed(2)} mm off). `
      + 'This tool shapes outlines pushed straight up, like a plate or a cut-out.');
  }
  // the plan is the union of the bottom face; the top face must match it
  const face = level => {
    const edgeMap = new Map();
    for (let i = 0; i < tris.length; i += 9) {
      if (Math.abs(tris[i + 2] - level) > tol || Math.abs(tris[i + 5] - level) > tol || Math.abs(tris[i + 8] - level) > tol) continue;
      const pts = [0, 3, 6].map(k => ({ X: Math.round(tris[i + k] * S), Y: Math.round(tris[i + k + 1] * S) }));
      for (let e = 0; e < 3; e++) {
        const p1 = pts[e], p2 = pts[(e + 1) % 3];
        if (p1.X === p2.X && p1.Y === p2.Y) continue;
        const k1 = p1.X + ',' + p1.Y, k2 = p2.X + ',' + p2.Y;
        const undirected = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        edgeMap.set(undirected, (edgeMap.get(undirected) || 0) + 1);
      }
    }
    const boundaryEdges = [];
    for (let i = 0; i < tris.length; i += 9) {
      if (Math.abs(tris[i + 2] - level) > tol || Math.abs(tris[i + 5] - level) > tol || Math.abs(tris[i + 8] - level) > tol) continue;
      const pts = [0, 3, 6].map(k => ({ X: Math.round(tris[i + k] * S), Y: Math.round(tris[i + k + 1] * S) }));
      for (let e = 0; e < 3; e++) {
        const p1 = pts[e], p2 = pts[(e + 1) % 3];
        if (p1.X === p2.X && p1.Y === p2.Y) continue;
        const k1 = p1.X + ',' + p1.Y, k2 = p2.X + ',' + p2.Y;
        const undirected = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        if (edgeMap.get(undirected) === 1) boundaryEdges.push([p1, p2]);
      }
    }
    let paths = [];
    if (boundaryEdges.length) {
      const nextMap = new Map();
      for (const [p1, p2] of boundaryEdges) {
        const k1 = p1.X + ',' + p1.Y;
        if (!nextMap.has(k1)) nextMap.set(k1, []);
        nextMap.get(k1).push(p2);
      }
      const visited = new Set();
      for (const [p1, p2] of boundaryEdges) {
        const startKey = p1.X + ',' + p1.Y;
        const edgeKey = startKey + '->' + p2.X + ',' + p2.Y;
        if (visited.has(edgeKey)) continue;
        visited.add(edgeKey);
        const loop = [p1];
        let curr = p2;
        while (curr) {
          const ck = curr.X + ',' + curr.Y;
          if (ck === startKey) break;
          loop.push(curr);
          const nxtList = nextMap.get(ck) || [];
          let found = null;
          for (const nxt of nxtList) {
            const ek = ck + '->' + nxt.X + ',' + nxt.Y;
            if (!visited.has(ek)) { visited.add(ek); found = nxt; break; }
          }
          curr = found;
        }
        if (loop.length >= 3) paths.push(loop);
      }
    }
    if (!paths.length) {
      for (let i = 0; i < tris.length; i += 9) {
        if (Math.abs(tris[i + 2] - level) > tol || Math.abs(tris[i + 5] - level) > tol || Math.abs(tris[i + 8] - level) > tol) continue;
        paths.push([0, 3, 6].map(k => ({ X: Math.round(tris[i + k] * S), Y: Math.round(tris[i + k + 1] * S) })));
      }
    }
    const c = new ClipperLib.Clipper();
    c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    const out = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return out;
  };
  const bottom = face(z0), top = face(z1);
  const area = ps => ps.reduce((s, q) => s + ClipperLib.Clipper.Area(q), 0) / (S * S);
  const a = Math.abs(area(bottom));
  if (a < 1e-6) throw new ToolError('Could not find the bottom face of the part.');
  const x = new ClipperLib.Clipper();
  x.AddPaths(bottom, ClipperLib.PolyType.ptSubject, true);
  x.AddPaths(top, ClipperLib.PolyType.ptClip, true);
  const diff = new ClipperLib.Paths();
  x.Execute(ClipperLib.ClipType.ctXor, diff, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const d = Math.abs(area(diff));
  if (d > Math.max(0.01 * a, 0.5)) {
    throw new ToolError(`Not a flat part: the top and bottom outlines differ by ${d.toFixed(2)} mm2, so the side walls are not straight up.`);
  }
  const region = toPolys(bottom, ClipperLib.PolyFillType.pftNonZero);
  if (!region.length) throw new ToolError('The outline is empty.');
  return { z0, z1, region };
}

/** Paths -> [{outer, holes}] with outer counter-clockwise and holes clockwise, cleaned. */
function toPolys(paths, fill = ClipperLib.PolyFillType.pftEvenOdd) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, fill, fill);
  return fromTree(tree);
}

function fromTree(tree) {
  const out = [];
  for (const ex of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
    const outer = orient(ClipperLib.Clipper.CleanPolygon(ex.outer, CLEAN), true);
    if (!outer) continue;
    const holes = (ex.holes || []).map(hh => orient(ClipperLib.Clipper.CleanPolygon(hh, CLEAN), false)).filter(Boolean);
    out.push({ outer, holes });
  }
  return out;
}

function orient(path, ccw) {
  if (!path || path.length < 3) return null;
  const a = ClipperLib.Clipper.Area(path);
  if (Math.abs(a) < 1) return null;
  return (a > 0) === ccw ? path : path.slice().reverse();
}

function offset(polys, dmm) {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOL * S);
  for (const P of polys) co.AddPaths([P.outer, ...P.holes], ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, -dmm * S);
  return fromTree(tree);
}

const pip = (pt, path) => ClipperLib.Clipper.PointInPolygon(pt, path);   // 1 in, 0 out, -1 on

// ---- building the shaped mesh -------------------------------------------------------------
class Builder {
  constructor() { this.ix = new Map(); this.v = []; this.f = []; }
  vid(X, Y, z) {
    const k = X + ',' + Y + ',' + z;
    let i = this.ix.get(k);
    if (i === undefined) { i = this.v.length / 3; this.ix.set(k, i); this.v.push(X / S, Y / S, z); }
    return i;
  }
  tri(a, b, c) { if (a !== b && b !== c && a !== c) this.f.push(a, b, c); }
  array(z0) {
    const out = new Float32Array(this.f.length * 3);
    for (let i = 0; i < this.f.length; i++) {
      const v = this.f[i] * 3;
      out[i * 3] = this.v[v]; out[i * 3 + 1] = this.v[v + 1]; out[i * 3 + 2] = this.v[v + 2] + z0;
    }
    return out;
  }
}

/** Fill plan regions. pieces: [{rings: [path...], zs: [z...]}], rings[0] outer. up: faces +Z. */
function fill(m, pieces, up) {
  for (const { rings, zs } of pieces) {
    const pts = rings.map(r => r.map(q => [q.X, q.Y]));
    const ids = [], zz = [];
    rings.forEach((r, k) => r.forEach(q => { ids.push(m.vid(q.X, q.Y, zs[k])); zz.push(zs[k]); }));
    const { tris, extra } = triangulate(pts);
    for (const [x, y, a, b, c] of extra) {
      const z = (zz[a] + zz[b] + zz[c]) / 3;
      ids.push(m.vid(Math.round(x), Math.round(y), z));
    }
    for (let i = 0; i < tris.length; i += 3) {
      const a = ids[tris[i]], b = ids[tris[i + 1]], c = ids[tris[i + 2]];
      if (up) m.tri(a, b, c); else m.tri(a, c, b);
    }
  }
}

function fillFlat(m, polys, z, up) {
  fill(m, polys.map(P => ({ rings: [P.outer, ...P.holes], zs: [z, ...P.holes.map(() => z)] })), up);
}

/** Vertical band along a ring. Outer rings run counter-clockwise and holes clockwise,
 *  so the right-hand side is always outside. */
function wall(m, ring, lo, hi) {
  if (hi - lo <= 1e-9) return;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const a0 = m.vid(a.X, a.Y, lo), b0 = m.vid(b.X, b.Y, lo);
    const a1 = m.vid(a.X, a.Y, hi), b1 = m.vid(b.X, b.Y, hi);
    m.tri(a0, b0, b1);
    m.tri(a0, b1, a1);
  }
}

/** The profiled face: bands between offset rings, then the flat middle. lv: [[d, z]], z absolute. */
function surface(m, base, lv, topValue, up, progress) {
  const rings = [base];
  for (let k = 1; k < lv.length; k++) {
    const g = offset(base, lv[k][0]);
    if (!g.length) break;
    rings.push(g);
    progress((k / lv.length) * 0.7);
  }
  const zs = lv.slice(0, rings.length).map(([, z]) => z);
  const ranOut = rings.length < lv.length;   // narrow part: the rings vanished early
  const last = rings.length - 1;
  for (let k = 0; k < rings.length; k++) {
    const zk = zs[k], zn = k < last ? zs[k + 1] : null;
    const inner = k < last ? rings[k + 1] : [];
    const pieces = [];
    for (const C of rings[k]) {
      if (k === last) {
        // the flat middle. A rabbet (profile ends below the face) steps up first;
        // if the rings ran out, this is the ridge cap at the last ring's height.
        let cap = zk;
        if (!ranOut && Math.abs(zk - topValue) > 1e-9) {
          const [lo, hi] = zk < topValue ? [zk, topValue] : [topValue, zk];
          for (const r of [C.outer, ...C.holes]) wall(m, r, lo, hi);
          cap = topValue;
        }
        pieces.push({ rings: [C.outer, ...C.holes], zs: [cap, ...C.holes.map(() => cap)] });
        continue;
      }
      const inside = inner.filter(D => pip(D.outer[0], C.outer) === 1 && C.holes.every(H => pip(D.outer[0], H) === 0));
      // band: C minus the next ring's islands; C's own holes that sit in no island stay here
      const loose = C.holes.filter(I => inside.every(D => pip(I[0], D.outer) === 0));
      pieces.push({ rings: [C.outer, ...inside.map(D => D.outer), ...loose], zs: [zk, ...inside.map(() => zn), ...loose.map(() => zk)] });
      // round each hole of the next ring, down to this ring's holes inside it
      for (const D of inside) {
        for (const Hh of D.holes) {
          const mine = C.holes.filter(I => pip(I[0], Hh) !== 0);
          pieces.push({ rings: [Hh, ...mine], zs: [zn, ...mine.map(() => zk)] });
        }
      }
    }
    fill(m, pieces, up);
    progress(0.7 + (0.3 * (k + 1)) / rings.length);
  }
}
