import { ToolError } from '../../core/meshcheck.js';

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

function ensureWinding(pts, ccw = true) {
  const isCCW = signedArea(pts) > 0;
  return isCCW === ccw ? pts : pts.slice().reverse();
}

export async function run(tris, p, ctx) {
  if (!p.polygons || !p.polygons.length) {
    return { tris: new Float32Array(), notes: ['No SVG loaded.'] };
  }

  const { M, toTris } = ctx.kernel;
  const { Manifold, CrossSection } = M;
  const height = p.height || 10;

  const sections = [];
  for (const poly of p.polygons) {
    const loops = poly.map((loop, i) => ensureWinding(loop, i === 0));
    const cs = new CrossSection(loops);
    if (!cs.isEmpty()) sections.push(cs);
    else cs.delete();
  }

  if (!sections.length) {
    return { tris: new Float32Array(), notes: ['Empty SVG.'] };
  }

  let combined = sections.length === 1 ? sections[0] : CrossSection.union(sections);
  for (const cs of sections) if (cs !== combined) cs.delete();

  const solid = Manifold.extrude(combined, height);
  combined.delete();

  const out = toTris(solid);
  solid.delete();

  return { tris: out, notes: [`Extruded ${p.polygons.length} shape${p.polygons.length === 1 ? '' : 's'} to ${height} mm.`] };
}
