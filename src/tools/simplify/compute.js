// Simplify: quadric edge collapse to a share of the triangles, optionally held within a
// distance of the original surface.
import { decimate, stlBytes, sizeText } from '../../core/decimate.js';
import { report, ToolError } from '../../core/meshcheck.js';

export const openOk = true;   // works on a surface that is not closed, and keeps its rims

export async function run(tris, p, ctx) {
  const closed = report(tris).watertight;
  const n = tris.length / 9;
  const target = Math.max(4, Math.round(n * p.percent / 100));
  const r = decimate(tris, { target, tol: p.preserve ? p.tol : 0, progress: ctx.progress });
  const notes = [];
  if (closed && !report(r.tris).watertight) notes.push('This setting opened the part; it still works, and cutting closes it per step. Keep more, or tick Preserve surface, to keep it closed.');
  notes.push(`${n.toLocaleString('en-US')} to ${r.after.toLocaleString('en-US')} triangles, STL ${sizeText(stlBytes(n))} to about ${sizeText(stlBytes(r.after))}.`);
  if (r.after > target * 1.02) notes.push(`Stopped above the target: going further would move the surface more than ${p.tol} mm.`);
  return { tris: r.tris, notes };
}
