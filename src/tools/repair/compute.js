// Repair: close an imported mesh. Gets the triangles as read from the file (raw).
import { repair, report, describe, shells, WELD } from '../../core/meshcheck.js';
import { unionShells } from '../../core/kernel.js';
import { solidify } from '../../core/solidify.js';
import { decimate, stlBytes, sizeText } from '../../core/decimate.js';

export const raw = true;      // as an imported mesh's first step it gets the file as read
export const openOk = true;   // and anywhere else it takes the part as it is, closed or not

export async function run(tris, p, ctx) {
  const progress = ctx.progress || (() => {});
  progress(0.02, 'welding');
  const r = repair(tris, WELD, { gap: p.gap ?? 0.01, maxHole: p.solid ? 0 : p.maxHole ?? 0 });
  const f = r.fixes;
  let out = r.tris, rep = f.after;
  const notes = [];
  const did = [f.tjunctions && `${f.tjunctions} edges sewn`, f.holes && `${f.holes} holes filled`,
    f.reoriented && `${f.reoriented} faces turned`, f.duplicates && `${f.duplicates} duplicates dropped`].filter(Boolean);

  if (!p.solid) {
    if (!rep.watertight) {
      progress(0.4, 'joining pieces');
      const parts = shells(out).map(t => repair(t, WELD, { gap: p.gap ?? 0.01, maxHole: p.maxHole ?? 0 }).tris);
      const u = unionShells(parts);
      if (u) {
        const ur = report(u.tris);
        if (ur.watertight && !u.dropped) {
          out = u.tris; rep = ur;
          did.push(`${parts.length} pieces joined`);
          if (u.bridged) did.push(`${u.bridged} touching edges bridged`);
        }
      }
    }
    if (!rep.watertight) {
      // keep the best it managed; the part still works, and cutting closes it per step
      notes.push(`${did.length ? did.join(', ') + '. ' : ''}Still not closed: ${describe(rep).replace(/^not closed: /, '')}${f.holesLeft ? `; ${f.holesLeft} holes are bigger than the limit` : ''}. Raise Gap close or Largest hole, or tick Make solid.`);
    } else notes.push(did.length ? `Closed: ${did.join(', ')}.` : 'Already closed.');
  } else {
    progress(0.1, 'making solid');
    let s;
    try { s = solidify(out, p.voxel, (fr, t) => progress(0.1 + fr * (p.tidy ? 0.6 : 0.85), t)); }
    catch (err) {
      // nothing inside to rebuild (one open sheet): keep the mesh as it is
      notes.push(`${err.message} Kept as it is.`, `${(out.length / 9).toLocaleString('en-US')} triangles, STL about ${sizeText(stlBytes(out.length / 9))}.`);
      return { tris: out, notes };
    }
    out = s.tris;
    const grid = out.length / 9;
    if (p.tidy) {
      progress(0.75, 'tidying');
      out = decimate(out, { target: 0, tol: 0.01, progress: (fr) => progress(0.75 + fr * 0.2, 'tidying') }).tris;
    }
    notes.push(`Rebuilt on a ${p.voxel} mm grid${s.specks ? `, ${s.specks} specks dropped` : ''}: ${grid.toLocaleString('en-US')} triangles${p.tidy ? `, ${(out.length / 9).toLocaleString('en-US')} after tidying` : ''}.`);
  }
  notes.push(`${(out.length / 9).toLocaleString('en-US')} triangles, STL about ${sizeText(stlBytes(out.length / 9))}.`);
  return { tris: out, notes };
}
