// SVG parser and 2D cross-section extractor for Workingtitle3D.
// Uses Three.js SVGLoader on the main thread (DOMParser) to turn SVG vector curves
// into closed 2D polygon loops (outer boundaries and holes) with clean winding.
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';

/** Signed area of a 2D polygon loop. Positive = Counter-Clockwise (CCW), Negative = Clockwise (CW). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

/** Ensure loop has desired winding: ccw=true (positive area), ccw=false (negative area). */
export function ensureWinding(pts, ccw = true) {
  const isCCW = signedArea(pts) > 0;
  return isCCW === ccw ? pts : pts.slice().reverse();
}

/** Remove consecutive duplicate points from a loop. */
function cleanLoop(pts, eps = 1e-5) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!out.length) { out.push(p); continue; }
    const prev = out[out.length - 1];
    if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) > eps) {
      out.push(p);
    }
  }
  // Check closing point vs first point
  if (out.length > 2) {
    const first = out[0], last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= eps) {
      out.pop();
    }
  }
  return out;
}

function sqDist(p1, p2) {
  const dx = p1[0] - p2[0], dy = p1[1] - p2[1];
  return dx * dx + dy * dy;
}

function sqDistToSeg(p, p1, p2) {
  const l2 = sqDist(p1, p2);
  if (l2 === 0) return sqDist(p, p1);
  let t = ((p[0] - p1[0]) * (p2[0] - p1[0]) + (p[1] - p1[1]) * (p2[1] - p1[1])) / l2;
  t = Math.max(0, Math.min(1, t));
  return sqDist(p, [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])]);
}

function rdp(pts, eps) {
  if (pts.length <= 2) return pts;
  const eps2 = eps * eps;
  function rec(pList) {
    if (pList.length <= 2) return pList;
    let dmax2 = 0, idx = 0;
    const first = pList[0], last = pList[pList.length - 1];
    for (let i = 1; i < pList.length - 1; i++) {
      const d2 = sqDistToSeg(pList[i], first, last);
      if (d2 > dmax2) { dmax2 = d2; idx = i; }
    }
    if (dmax2 > eps2) {
      const left = rec(pList.slice(0, idx + 1));
      const right = rec(pList.slice(idx));
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }
  return rec(pts);
}

export function simplifyLoop(pts, tol = 0.04) {
  if (!pts || pts.length <= 4) return pts;
  let maxD2 = 0, mid = Math.floor(pts.length / 2);
  const p0 = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const d2 = sqDist(p0, pts[i]);
    if (d2 > maxD2) { maxD2 = d2; mid = i; }
  }
  const chain1 = rdp(pts.slice(0, mid + 1), tol);
  const chain2 = rdp(pts.slice(mid).concat([pts[0]]), tol);
  const combined = chain1.slice(0, -1).concat(chain2.slice(0, -1));
  return combined.length >= 3 ? combined : pts;
}

/**
 * Parse SVG text into centered, sanitized polygon arrays suitable for Manifold CrossSection.
 * Each entry in polygons is an array of loops: [outerLoop, ...holeLoops], where each loop is [[x, y], ...].
 */
export function parseSvgPolygons(svgText, opts = {}) {
  const loader = new SVGLoader();
  const svgData = loader.parse(svgText);
  if (!svgData.paths || !svgData.paths.length) {
    throw new Error('The SVG file contains no vector paths.');
  }

  const rawShapes = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (const path of svgData.paths) {
    const shapes = path.toShapes(true);
    for (const shape of shapes) {
      const outerPts = shape.getPoints();
      if (!outerPts || outerPts.length < 3) continue;

      // SVG coordinate space: (0,0) top-left, Y points downwards.
      // 3D coordinate space: X right, Y depth/up on plane, Z vertical height.
      // Invert Y so the SVG is right-side up.
      const rawOuter = cleanLoop(outerPts.map(pt => [pt.x, -pt.y]));
      if (rawOuter.length < 3 || Math.abs(signedArea(rawOuter)) < 1e-4) continue;

      const rawHoles = [];
      if (shape.holes && shape.holes.length) {
        for (const hole of shape.holes) {
          const hPts = hole.getPoints();
          if (!hPts || hPts.length < 3) continue;
          const cleanH = cleanLoop(hPts.map(pt => [pt.x, -pt.y]));
          if (cleanH.length >= 3 && Math.abs(signedArea(cleanH)) >= 1e-4) {
            rawHoles.push(cleanH);
          }
        }
      }

      for (const [x, y] of rawOuter) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      for (const h of rawHoles) {
        for (const [x, y] of h) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      rawShapes.push({ outer: rawOuter, holes: rawHoles });
    }
  }

  if (!rawShapes.length) {
    throw new Error('No closed 2D shapes found in the SVG.');
  }

  const rawWidth = maxX - minX;
  const rawDepth = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // If the SVG has huge pixel dimensions (e.g. viewBox 800x600), scale it down
  // to a sensible default (max dimension ~100 mm) so it lands comfortably on the build plate.
  let scale = 1;
  const maxDim = Math.max(rawWidth, rawDepth);
  if (maxDim > (opts.maxDim || 200)) {
    scale = (opts.targetDim || 100) / maxDim;
  }

  const polygons = [];
  const tol = opts.tol || 0.04;
  for (const s of rawShapes) {
    const outer = s.outer.map(([x, y]) => [
      +((x - cx) * scale).toFixed(5),
      +((y - cy) * scale).toFixed(5)
    ]);
    const holes = s.holes.map(h => h.map(([x, y]) => [
      +((x - cx) * scale).toFixed(5),
      +((y - cy) * scale).toFixed(5)
    ]));

    const simpOuter = simplifyLoop(outer, tol);
    const simpHoles = holes.map(h => simplifyLoop(h, tol));

    polygons.push([
      ensureWinding(simpOuter, true),
      ...simpHoles.map(h => ensureWinding(h, false))
    ]);
  }

  return {
    polygons,
    width: +(rawWidth * scale).toFixed(2),
    depth: +(rawDepth * scale).toFixed(2),
    rawWidth: +rawWidth.toFixed(2),
    rawDepth: +rawDepth.toFixed(2),
    scale: +scale.toFixed(6)
  };
}
