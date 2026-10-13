// The project folder: every step written through to disk as it happens.
//
//   project.json     the state at the last compaction (parts, history, counters) + `base`
//   journal.ndjson   one line per step since then: {seq, type: cmd|undo|redo, ...}
//   meshes/<id>.f32  stored meshes (imports, tool results), raw float32, written once
//
// Chromium writes each file to a swap copy and swaps it in on close, so a crash mid-write
// leaves the last good version. A crash loses at most the step being written.
// Opening replays journal lines with seq > base, so a crash between writing project.json
// and clearing the journal does not apply a step twice.

import { zipStore, unzip } from './meshio.js';

const COMPACT_EVERY = 200;

// ---- one file -------------------------------------------------------------------------------
// A .wt3d file is the project in one zip: project.json (parts as recipes, history) and
// meshes/<id>.f32 (each stored mesh, raw float32, exactly as held). Nothing is re-tessellated
// or rounded, so a part saved and opened again is the same part.
export const PROJECT_EXT = '.wt3d';

export function packProject(doc) {
  const enc = new TextEncoder();
  const entries = [['project.json', enc.encode(JSON.stringify({ ...doc.snapshot(), app: 'Workingtitle3D' }))]];
  for (const [id, tris] of doc.blobs) entries.push([`meshes/${id}.f32`, new Uint8Array(tris.buffer, tris.byteOffset, tris.byteLength)]);
  return zipStore(entries);
}

export async function unpackProject(buf, name = 'The project file') {
  const files = await unzip(buf, true, name);
  const json = files.find(([n]) => n === 'project.json');
  if (!json) throw new Error(`${name} holds no project.`);
  const snap = JSON.parse(new TextDecoder().decode(json[1]));
  const blobs = new Map();
  for (const [n, data] of files) {
    const m = /^meshes\/(.+)\.f32$/.exec(n);
    if (m) blobs.set(m[1], new Float32Array(data.slice().buffer));
  }
  for (const id of snap.blobs || []) if (!blobs.has(id)) throw new Error(`${name} is missing a mesh (${id}).`);
  return { snap, blobs };
}

async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
async function appendLine(dir, name, line) {
  const fh = await dir.getFileHandle(name, { create: true });
  const size = (await fh.getFile()).size;
  const w = await fh.createWritable({ keepExistingData: true });
  await w.seek(size);
  await w.write(line + '\n');
  await w.close();
}

export class Project {
  constructor(dir, doc) {
    this.dir = dir;
    this.doc = doc;
    this.seq = 0;          // last journal line written
    this.base = 0;         // seq folded into project.json
    this.queue = Promise.resolve();
    this.pending = 0;
    this.error = null;
    this.onstate = null;   // (pending, error) for the status line
  }

  get name() { return this.dir.name; }

  /** Is there a project here already? */
  static async exists(dir) { return (await readText(dir, 'project.json')) != null; }

  /** Start a project in an empty folder from the doc as it stands. */
  static async create(dir, doc) {
    const p = new Project(dir, doc);
    p.meshes = await dir.getDirectoryHandle('meshes', { create: true });
    for (const [id, tris] of doc.blobs) await writeFile(p.meshes, id + '.f32', tris);
    await p.compact();
    p.attach();
    return p;
  }

  /** Open a project folder: state, then replay the journal. */
  static async open(dir, doc) {
    const text = await readText(dir, 'project.json');
    if (!text) throw new Error('That folder holds no project.');
    const snap = JSON.parse(text);
    const p = new Project(dir, doc);
    p.meshes = await dir.getDirectoryHandle('meshes', { create: true });
    const blobs = new Map();
    for await (const [name, h] of p.meshes.entries()) {
      if (!name.endsWith('.f32')) continue;
      blobs.set(name.slice(0, -4), new Float32Array(await (await h.getFile()).arrayBuffer()));
    }
    doc.load(snap, blobs);
    p.base = p.seq = snap.base || 0;
    const journal = (await readText(dir, 'journal.ndjson')) || '';
    let replayed = 0, torn = 0;
    for (const line of journal.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { torn++; continue; }   // a line cut short by a crash
      if (ev.seq <= p.base) continue;
      doc.replay(ev);
      p.seq = ev.seq;
      replayed++;
    }
    p.attach();
    return { project: p, replayed, torn };
  }

  attach() {
    this.detach?.();
    this.detach = this.doc.on(ev => this.write(ev));
  }

  write(ev) {
    let job;
    if (ev.type === 'blob') job = () => writeFile(this.meshes, ev.id + '.f32', ev.tris);
    else {
      const line = JSON.stringify({ seq: ++this.seq, type: ev.type, cmd: ev.type === 'cmd' ? ev.cmd : undefined, names: ev.names });
      const due = this.seq - this.base >= COMPACT_EVERY;
      job = async () => { await appendLine(this.dir, 'journal.ndjson', line); if (due) await this.compact(); };
    }
    this.pending++;
    this.onstate?.(this.pending, this.error);
    this.queue = this.queue.then(job).then(() => { this.error = null; }, err => { this.error = err; })
      .finally(() => { this.pending--; this.onstate?.(this.pending, this.error); });
    return this.queue;
  }

  /** Fold the journal into project.json, then empty the journal. */
  async compact() {
    const snap = { ...this.doc.snapshot(), base: this.seq };
    await writeFile(this.dir, 'project.json', JSON.stringify(snap));
    this.base = this.seq;
    await writeFile(this.dir, 'journal.ndjson', '');
  }

  /** Wait for every queued write. */
  flush() { return this.queue; }

  /** Carry on in another (empty) folder: copy everything there between writes, then switch.
   *  The old folder is left as it was; the caller removes it. */
  moveTo(dir) {
    const job = this.queue.then(async () => {
      await copyDir(this.dir, dir);
      this.meshes = await dir.getDirectoryHandle('meshes', { create: true });
      this.dir = dir;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

async function copyDir(from, to) {
  for await (const [name, h] of from.entries()) {
    if (h.kind === 'directory') await copyDir(h, await to.getDirectoryHandle(name, { create: true }));
    else await writeFile(to, name, await h.getFile());
  }
}
