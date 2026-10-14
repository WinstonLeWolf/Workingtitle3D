// The edge profile itself: shared by the panel (section drawing, checks) and the compute.

export const RING_STEP = 0.25;   // mm, widest gap between offset rings
export const RING_MIN = 0.02;    // mm, closest two rings may sit
export const LAND = 0.02;        // mm of side wall always kept below a profile

/** Where the cut meets the side wall, mm above the opposite face. null start = flush. */
export function startFor(p, thickness) {
  const zs = p.start == null ? thickness - p.height : p.start;
  return zs > -1e-6 && zs < 0 ? 0 : zs;   // float round-off, not a setting
}

/** (d, dz) from the side wall (0, 0) to (w, h). Fillet convex, cove concave, chamfer straight. */
export function profilePoints(kind, w, h, n = 90) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI / 2, t = i / n;
    if (kind === 'fillet') out.push([w * (1 - Math.cos(a)), h * Math.sin(a)]);
    else if (kind === 'cove') out.push([w * Math.sin(a), h * (1 - Math.cos(a))]);
    else out.push([w * t, h * t]);
  }
  return out;
}

/** [distance in, absolute height above the opposite face] for each ring. */
export function levels(p, thickness) {
  const { width: w, height: h } = p;
  const zs = startFor(p, thickness);
  if (p.kind === 'chamfer') {
    // A chamfer is a straight bevel: at most steps of 0.5mm across the width, not 90 concentric rings
    const k = Math.max(1, Math.ceil(w / 0.5));
    const out = [];
    for (let j = 0; j <= k; j++) {
      const d = (w * j) / k;
      out.push([d, zs + (h * j) / k]);
    }
    const snap = z => { z = Math.min(Math.max(z, LAND), thickness); return thickness - z < 1e-9 ? thickness : z; };
    return out.map(([d, z]) => [d, snap(z)]);
  }
  const pts = profilePoints(p.kind, w, h);
  // no gap wider than RING_STEP in plan, so ridges on narrow strips come out true
  const fine = [pts[0]];
  for (const q of pts.slice(1)) {
    const r = fine[fine.length - 1];
    const k = Math.max(1, Math.ceil((q[0] - r[0]) / RING_STEP));
    for (let j = 1; j <= k; j++) fine.push([r[0] + ((q[0] - r[0]) * j) / k, r[1] + ((q[1] - r[1]) * j) / k]);
  }
  const out = [[0, zs]];
  for (const [d, dz] of fine.slice(1, -1)) {
    if (d - out[out.length - 1][0] >= RING_MIN && w - d >= RING_MIN) out.push([d, zs + dz]);
  }
  out.push([w, zs + h]);   // the last ring sits exactly at w
  // never touch the opposite face: corner triangles would lie on it with zero thickness
  const snap = z => { z = Math.min(Math.max(z, LAND), thickness); return thickness - z < 1e-9 ? thickness : z; };
  return out.map(([d, z]) => [d, snap(z)]);
}

/** Finished cross-section at a straight edge, [d, z] from the outside in (d=0 is the wall). */
export function section(p, t) {
  const lv = levels(p, t);
  const run = Math.max(p.width * 1.5, p.width + 4, 6);
  const top = lv.slice();
  if (lv[lv.length - 1][1] < t) top.push([p.width, t]);   // rabbet: step up to the face
  if (p.face === 'top') return [[0, 0], ...top, [run, t], [run, 0]];
  const bottom = top.map(([d, z]) => [d, t - z]);
  if (p.face === 'bottom') return [[0, t], ...bottom, [run, 0], [run, t]];
  return [...bottom.reverse(), ...top, [run, t], [run, 0]];
}

/** What is wrong with these settings for a part this thick, or null. */
export function problem(p, t) {
  if (!(p.width > 0) || !(p.height > 0)) return 'Width and height must both be above zero.';
  const zs = startFor(p, t);
  if (zs < 0) return p.start == null
    ? `The height is more than the part is thick (${t.toFixed(2)} mm). Lower it, or set a start height.`
    : 'The start height is below the part. Raise it to 0 or more.';
  if (zs >= t) return 'The start height is at or above the treated face, so nothing would be cut. Lower it, or leave it on auto.';
  if (p.face === 'both' && 2 * Math.max(zs, LAND) - t < LAND) {
    return `With both faces the two cuts would meet on the side wall. Keep each cut under half the thickness (${(t / 2).toFixed(2)} mm).`;
  }
  return null;
}
