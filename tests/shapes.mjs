// Test solids as triangle soups (Float32Array, 9 per triangle, normals out).
import { triangulate, ringArea } from '../src/core/tri2d.js';

/** Outline pushed straight up from z0 to z1. outer CCW-or-not, holes any order. */
export function extrude(outer, holes = [], z0 = 0, z1 = 5) {
  const fix = (r, ccw) => ((ringArea(r) > 0) === ccw ? r : r.slice().reverse());
  const rings = [fix(outer, true), ...holes.map(h => fix(h, false))];
  const all = rings.flat();
  const { tris } = triangulate(rings);
  const out = [];
  const P = (i, z) => [all[i][0], all[i][1], z];
  for (let i = 0; i < tris.length; i += 3) {
    out.push(...P(tris[i], z1), ...P(tris[i + 1], z1), ...P(tris[i + 2], z1));
    out.push(...P(tris[i], z0), ...P(tris[i + 2], z0), ...P(tris[i + 1], z0));
  }
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      out.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1);
      out.push(a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
    }
  }
  return Float32Array.from(out);
}

export const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
export const circle = (cx, cy, r, n = 48) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);

export function box(x0, y0, z0, x1, y1, z1) {
  return extrude(rect(x0, y0, x1, y1), [], z0, z1);
}

/** UV sphere, closed. */
export function sphere(r = 20, seg = 32, rings = 16) {
  const out = [];
  const p = (i, j) => {
    const th = (Math.PI * i) / rings, ph = (2 * Math.PI * j) / seg;
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
    if (i > 0) out.push(...a, ...b, ...d);
    if (i < rings - 1) out.push(...b, ...c, ...d);
  }
  return Float32Array.from(out);
}
