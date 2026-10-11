// All heavy work: reading, repairing, checking, writing, and every tool's compute.
// Tool computes are collected from src/tools/*/compute.js by the build.
import tools from 'virtual:tools-compute';
import { readMesh, writeMesh } from './meshio.js';
import { repair, report, adjacency, describe, thinWall, ToolError } from './meshcheck.js';
import { initKernel, partMesh, flatten } from './kernel.js';
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
      const { tris, fixes } = repair(raw);
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
      if (!rep.watertight) throw new ToolError(thinWall(rep) || `The model is ${describe(rep)}, so it was not saved.`);
      const bytes = writeMesh(m.tris, m.fmt);
      const back = report(await readMesh('check.' + m.fmt, bytes.slice().buffer));
      if (!back.watertight) throw new ToolError(`The ${m.fmt.toUpperCase()} data did not read back as a closed solid (${describe(back)}), so it was not saved.`);
      done({ bytes }, [bytes.buffer]);
    } else if (m.type === 'check') {
      const rep = report(await readMesh(m.name, m.buf));
      done({ report: rep, text: describe(rep) });
    } else if (m.type === 'blob') {
      blobs.set(m.blobId, m.tris);
      done({});
    } else if (m.type === 'mesh') {
      await initKernel(wasmBinary);
      const r = await partMesh(m.part, { blobs, tools, progress });
      done({ key: r.key, tris: r.tris, volume: r.volume }, [r.tris.buffer]);
    } else if (m.type === 'flatten') {
      await initKernel(wasmBinary);
      progress(0.3, 'joining parts');
      const opts = { bridge: !!m.bridge };
      const tris = await flatten(m.parts, { blobs, tools, progress }, opts);
      done({ tris, thin: m.bridge ? null : thinWall(report(tris)), bridged: opts.bridged || 0 }, [tris.buffer]);
    } else if (m.type === 'adj') {
      const adj = adjacency(m.tris);
      done({ adj }, [adj.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', user: err instanceof ToolError, message: err instanceof ToolError ? err.message : `Internal error: ${err.message}` });
  }
};
