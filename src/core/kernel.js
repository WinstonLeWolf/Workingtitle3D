// The modelling core, in the worker. A part is a recipe; its mesh is rebuilt from it.
//
//   part = { id, name, kind, params, xform: {pos, rot, scale}, hole, ops: [{tool, params, sel}],
//            children: [part] (groups), blob: id (imported meshes) }
//
// kind: box | cylinder | cone | sphere | torus | wedge | tube | mesh | group.
// Shapes are built in the part's own frame, sitting on z = 0 and centred in x and y;
// xform places them. A group joins its solid children and cuts its hole children.
// Results are cached by recipe key, so moving one part never rebuilds another.
import Module from 'manifold-3d';
import { Matrix4, Euler, Quaternion, Vector3 } from 'three';
import { weld, ToolError } from './meshcheck.js';

let M = null;
export async function initKernel(wasmBinary) {
  if (M) return;
  M = await Module({ wasmBinary });
  M.setup();
}

// ---- recipe keys -------------------------------------------------------------------------
import { shapeKey } from './doc.js';
export { shapeKey };

const cache = new Map();   // key -> Manifold, oldest first
const CACHE_MAX = 400;
function remember(key, man) {
  cache.set(key, man);
  while (cache.size > CACHE_MAX) {
    const [k, m] = cache.entries().next().value;
    cache.delete(k);
    m.delete();
  }
}

// ---- transforms -----------------------------------------------------------------------------
export function matrix(x) {
  const m = new Matrix4();
  const r = (x?.rot || [0, 0, 0]).map(d => (d * Math.PI) / 180);
  m.compose(new Vector3(...(x?.pos || [0, 0, 0])), new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ')),
    new Vector3(...(x?.scale || [1, 1, 1])));
  return m;
}
const isIdentity = x => !x || ((!x.pos || x.pos.every(v => v === 0)) && (!x.rot || x.rot.every(v => v === 0)) && (!x.scale || x.scale.every(v => v === 1)));
function place(man, xform) {
  if (isIdentity(xform)) return man;
  const e = matrix(xform).elements;
  return man.transform(Array.from(e));
}

// ---- shapes --------------------------------------------------------------------------------
export const SHAPES = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { d: 20, h: 20, sides: 64 },
  cone: { d1: 20, d2: 0, h: 20, sides: 64 },
  sphere: { d: 20, sides: 64 },
  torus: { d: 20, tube: 4, sides: 64, tubeSides: 24 },
  wedge: { x: 20, y: 20, z: 20 },
  tube: { d: 20, wall: 2, h: 20, sides: 64 },
  fillet: { r: 5, length: 20, sides: 64 },
};

function primitive(kind, p) {
  const { Manifold, CrossSection } = M;
  const pos = v => { if (!(v > 0)) throw new ToolError(`${kind}: every size must be above zero.`); return v; };
  const sides = s => Math.max(3, Math.round(s || 64));
  switch (kind) {
    case 'box': return Manifold.cube([pos(p.x), pos(p.y), pos(p.z)], true).translate([0, 0, p.z / 2]);
    case 'cylinder': return Manifold.cylinder(pos(p.h), pos(p.d) / 2, p.d / 2, sides(p.sides));
    case 'cone': {
      if (!(p.d1 >= 0 && p.d2 >= 0) || p.d1 + p.d2 <= 0) throw new ToolError('cone: a diameter must be above zero.');
      // the library wants the wide end down; flip if the top is the wide end
      if (p.d1 >= p.d2) return Manifold.cylinder(pos(p.h), p.d1 / 2, p.d2 / 2, sides(p.sides));
      return Manifold.cylinder(pos(p.h), p.d2 / 2, p.d1 / 2, sides(p.sides)).mirror([0, 0, 1]).translate([0, 0, p.h]);
    }
    case 'sphere': return Manifold.sphere(pos(p.d) / 2, sides(p.sides)).translate([0, 0, p.d / 2]);
    case 'torus': {
      const R = (pos(p.d) - pos(p.tube)) / 2;
      if (R <= p.tube / 2) throw new ToolError('torus: the tube is too thick for that diameter.');
      return Manifold.revolve(CrossSection.circle(p.tube / 2, sides(p.tubeSides)).translate([R, 0]), sides(p.sides)).translate([0, 0, p.tube / 2]);
    }
    case 'wedge': {
      const x = pos(p.x) / 2, y = pos(p.y) / 2, z = pos(p.z);
      return Manifold.hull([[-x, -y, 0], [x, -y, 0], [-x, y, 0], [x, y, 0], [-x, -y, z], [-x, y, z]]);
    }
    case 'fillet': {
      // fills an inside corner: an r x r square with a quarter circle scooped from it,
      // curve facing +X/+Z, run along Y; centred in X and Y like every other shape
      const r = pos(p.r), L = pos(p.length);
      const sq = CrossSection.square([r, r]);
      const disk = CrossSection.circle(r, sides(p.sides)).translate([r, r]);
      const prof = sq.subtract(disk);
      sq.delete(); disk.delete();
      const solid = Manifold.extrude(prof, L).rotate([90, 0, 0]).translate([-r / 2, L / 2, 0]);
      prof.delete();
      return solid;
    }
    case 'tube': {
      if (!(p.wall > 0) || p.wall * 2 >= p.d) throw new ToolError('tube: the wall must be above zero and under half the diameter.');
      const outer = Manifold.cylinder(pos(p.h), p.d / 2, p.d / 2, sides(p.sides));
      const inner = Manifold.cylinder(p.h + 2, p.d / 2 - p.wall, p.d / 2 - p.wall, sides(p.sides)).translate([0, 0, -1]);
      const r = outer.subtract(inner);
      outer.delete(); inner.delete();
      return r;
    }
  }
  throw new ToolError(`No shape called ${kind}.`);
}

// ---- mesh conversion -------------------------------------------------------------------------
// Where surfaces cross, a boolean can leave points a hair apart. Every file reader and our
// own check weld points closer than WELD, which would fold those slivers into bad edges,
// so collapse them in the library first, where the result stays a valid solid.
const TIDY = 2e-4;   // mm, above the 1e-4 weld
function tidy(man) {
  return man.simplify(TIDY);
}

export function toManifold(tris) {
  const { pos, idx } = weld(tris);
  const mesh = new M.Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(idx) });
  mesh.merge();
  try {
    return M.Manifold.ofMesh(mesh);
  } catch {
    throw new ToolError('That mesh is not a closed solid, so it cannot be joined or cut.');
  }
}

export function toTris(man) {
  const mesh = man.getMesh();
  const t = mesh.triVerts, v = mesh.vertProperties, n = mesh.numProp;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const k = t[i] * n;
    out[i * 3] = v[k]; out[i * 3 + 1] = v[k + 1]; out[i * 3 + 2] = v[k + 2];
  }
  return out;
}

// ---- building ----------------------------------------------------------------------------------
/**
 * The part's shape in its own frame, as a Manifold owned by the cache (do not delete it).
 * ctx: { blobs: Map(id -> Float32Array), tools: {id: {run}}, progress }
 */
export async function local(part, ctx) {
  const key = shapeKey(part);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  let man;
  if (part.kind === 'group') {
    const solids = [], holes = [], owned = [];
    for (const c of part.children) {
      const base = await local(c, ctx);
      const m = place(base, c.xform);
      if (m !== base) owned.push(m);   // a placed copy is ours to free; the cached base is not
      (c.hole ? holes : solids).push(m);
    }
    if (!solids.length) man = M.Manifold.union(holes);   // a group of holes is one hole
    else if (part.mode === 'intersect') {
      // keep only what every solid shares, then cut the holes
      const s = M.Manifold.intersection(solids);
      if (holes.length) { const h = M.Manifold.union(holes); man = s.subtract(h); s.delete(); h.delete(); } else man = s;
    } else {
      const s = M.Manifold.union(solids);
      if (holes.length) { const h = M.Manifold.union(holes); man = s.subtract(h); s.delete(); h.delete(); } else man = s;
    }
    for (const m of owned) m.delete();
    const t = tidy(man);
    if (t !== man) { man.delete(); man = t; }
  } else if (part.kind === 'mesh') {
    const tris = ctx.blobs.get(part.blob);
    if (!tris) throw new ToolError(`The mesh for ${part.name || 'a part'} is missing from the project.`);
    man = toManifold(tris);
  } else man = primitive(part.kind, part.params);
  for (const op of part.ops || []) {
    const tool = ctx.tools[op.tool];
    if (!tool) throw new ToolError(`No tool called ${op.tool}.`);
    const tris = toTris(man);
    const out = await tool.run(tris, op.params, { selection: resolveFace(tris, op.sel), progress: ctx.progress || (() => {}) });
    const next = toManifold(out.tris || out);
    man.delete();
    man = next;
  }
  remember(key, man);
  return man;
}

/** A stored face pick ({normal, d, point}) back to triangle indices on this mesh: the flat
 *  region round the triangle nearest the point. Survives size changes that keep the face. */
export function resolveFace(tris, sel) {
  if (!sel) return [];
  const { normal: n, d, point } = sel;
  const n3 = tris.length / 9;
  const on = new Uint8Array(n3);
  let seed = -1, best = Infinity;
  for (let f = 0; f < n3; f++) {
    const i = f * 9;
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz) || 1;
    cx /= l; cy /= l; cz /= l;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 1 - 1e-6) continue;
    let ok = true;
    for (let k = 0; k < 9; k += 3) if (Math.abs(tris[i + k] * n[0] + tris[i + k + 1] * n[1] + tris[i + k + 2] * n[2] - d) > 1e-3) ok = false;
    if (!ok) continue;
    on[f] = 1;
    const mx = (tris[i] + tris[i + 3] + tris[i + 6]) / 3 - point[0], my = (tris[i + 1] + tris[i + 4] + tris[i + 7]) / 3 - point[1], mz = (tris[i + 2] + tris[i + 5] + tris[i + 8]) / 3 - point[2];
    const dd = mx * mx + my * my + mz * mz;
    if (dd < best) { best = dd; seed = f; }
  }
  if (seed < 0) throw new ToolError('The face a step was picked on is gone. Edit that step and pick the face again.');
  // flood over shared vertices among the coplanar triangles
  const { idx } = weld(tris);
  const byVert = new Map();
  for (let f = 0; f < n3; f++) if (on[f]) for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; (byVert.get(v) || byVert.set(v, []).get(v)).push(f); }
  const seen = new Set([seed]), stack = [seed], out = [];
  while (stack.length) {
    const f = stack.pop();
    out.push(f);
    for (let k = 0; k < 3; k++) for (const g of byVert.get(idx[f * 3 + k]) || []) if (!seen.has(g)) { seen.add(g); stack.push(g); }
  }
  return out;
}

/** Display mesh for a part, in its own frame. */
export async function partMesh(part, ctx) {
  const man = await local(part, ctx);
  const tris = toTris(man);
  return { key: shapeKey(part), tris, volume: man.volume() };
}

/** Everything solid and visible at the top level, joined into one closed solid in world space.
 *  Loose holes (not in a group) cut nothing, as on the plate. */
export async function flatten(parts, ctx) {
  const placed = [], owned = [];
  for (const p of parts) {
    if (p.hole || p.hidden) continue;
    const base = await local(p, ctx);
    const m = place(base, p.xform);
    if (m !== base) owned.push(m);
    placed.push(m);
  }
  if (!placed.length) throw new ToolError('Nothing solid to save.');
  const joined = M.Manifold.union(placed);
  const all = tidy(joined);
  const tris = toTris(all);
  all.delete();
  if (joined !== all) joined.delete();
  for (const m of owned) m.delete();
  return tris;
}

export function clearCache() {
  for (const m of cache.values()) m.delete();
  cache.clear();
}
