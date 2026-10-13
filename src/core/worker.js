// All heavy work: reading, repairing, checking, writing, and every tool's compute.
// Tool computes are collected from src/tools/*/compute.js by the build.
import tools from 'virtual:tools-compute';
import { readMesh, writeMesh } from './meshio.js';
import { repair, report, adjacency, describe, thinWall, shells, bounds, ToolError } from './meshcheck.js';
import { initKernel, partMesh, flatten, unionShells, seed } from './kernel.js';
import wasmBinary from 'manifold-3d/manifold.wasm';

const blobs = new Map();   // stored meshes the parts refer to, sent once by the app

self.onmessage = async e => {
  const m = e.data;
  const id = m.id;
  const progress = (frac, text) => self.postMessage({ id, type: 'progress', frac, text });
  const done = (data, transfer = []) => self.postMessage({ id, type: 'done', ...data }, transfer);
  try {
    if (m.type === 'load') {
      progress(0.1, 'reading');
      const raw = await readMesh(m.name, m.buf);
      progress(0.4, 'repairing');
      let { tris, fixes } = repair(raw);
      if (!fixes.after.watertight) {
        // pieces that touch or overlap: close each shell on its own, then join them
        progress(0.6, 'joining shells');
        await initKernel(wasmBinary);
        const parts = shells(tris).map(t => repair(t).tris);
        const u = unionShells(parts);
        if (u) {
          const rep = report(u.tris);
          // a join that loses most of the model is worse than the error: the result must fill the same box
          const b0 = bounds(raw), b1 = bounds(u.tris);
          const kept = [0, 1, 2].every(i => b1.hi[i] - b1.lo[i] >= 0.9 * (b0.hi[i] - b0.lo[i]));
          fixes = { ...fixes, shells: parts.length, droppedShells: u.dropped, keptBox: kept };
          if (rep.watertight && kept) { tris = u.tris; fixes = { ...fixes, shells: parts.length, droppedShells: u.dropped, bridged: u.bridged, after: rep }; }
        }
      }
      progress(0.8, 'mapping faces');
      const adj = adjacency(tris);
      done({ tris, fixes, report: fixes.after, adj }, [tris.buffer, adj.buffer]);
    } else if (m.type === 'run') {
      const tool = tools[m.tool];
      if (!tool) throw new ToolError(`No tool called ${m.tool}.`);
      const out = await tool.run(m.tris, m.params, { progress, selection: m.selection || [] });
      const tris = out instanceof Float32Array ? out : out.tris;
      progress(0.98, 'checking');
      const rep = report(tris);
      if (!rep.watertight) {
        throw new ToolError(`Internal check failed: the result is ${describe(rep)}. Nothing was changed.`);
      }
      done({ tris, report: rep, notes: out.notes || [] }, [tris.buffer]);
    } else if (m.type === 'save') {
      const rep = report(m.tris);
      const bytes = writeMesh(m.tris, m.fmt);
      const back = report(await readMesh('check.' + m.fmt, bytes.slice().buffer));
      if (back.triangles !== rep.triangles) throw new ToolError(`The ${m.fmt.toUpperCase()} data read back with ${back.triangles} triangles, not ${rep.triangles}, so it was not saved.`);
      done({ bytes }, [bytes.buffer]);
    } else if (m.type === 'check') {
      const rep = report(await readMesh(m.name, m.buf));
      done({ report: rep, text: describe(rep) });
    } else if (m.type === 'seed') {
      await initKernel(wasmBinary);
      for (const it of m.items) seed(it.key, it.tris);
      done({});
    } else if (m.type === 'blob') {
      blobs.set(m.blobId, m.tris);
      done({});
    } else if (m.type === 'mesh') {
      await initKernel(wasmBinary);
      const notes = [];
      const r = await partMesh(m.part, { blobs, tools, progress, notes });
      done({ key: r.key, tris: r.tris, volume: r.volume, open: !!r.open, notes }, [r.tris.buffer]);
    } else if (m.type === 'flatten') {
      await initKernel(wasmBinary);
      progress(0.3, 'joining parts');
      const opts = { bridge: !!m.bridge };
      const tris = await flatten(m.parts, { blobs, tools, progress }, opts);
      done({ tris, thin: m.bridge || opts.open ? null : thinWall(report(tris)), bridged: opts.bridged || 0, open: opts.open }, [tris.buffer]);
    } else if (m.type === 'adj') {
      const adj = adjacency(m.tris);
      done({ adj }, [adj.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', user: err instanceof ToolError, message: err instanceof ToolError ? err.message : `Internal error: ${err.message}` });
  }
};
