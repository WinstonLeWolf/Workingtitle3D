// Document, history, per-part rollback and the project folder (on an in-memory stand-in for
// the browser's folder handles). node tests/doc.mjs
import { Doc } from '../src/core/doc.js';
import { Project } from '../src/core/project.js';
import { SHAPES } from '../src/core/kernel.js';

// minimal in-memory FileSystemDirectoryHandle: enough for Project
class FakeFile {
  constructor() { this.data = new Uint8Array(0); }
  async getFile() { const d = this.data; return { size: d.length, text: async () => new TextDecoder().decode(d), arrayBuffer: async () => d.slice().buffer }; }
  async createWritable(opt = {}) {
    let buf = opt.keepExistingData ? Array.from(this.data) : [], pos = 0;
    const self = this;
    return {
      async seek(p) { pos = p; },
      async write(x) {
        const b = typeof x === 'string' ? new TextEncoder().encode(x) : new Uint8Array(x.buffer ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : x);
        for (let i = 0; i < b.length; i++) buf[pos + i] = b[i];
        pos += b.length;
      },
      async close() { self.data = Uint8Array.from(buf); },   // swap in on close, like Chromium
    };
  }
}
class FakeDir {
  constructor(name = 'proj') { this.name = name; this.files = new Map(); this.dirs = new Map(); }
  async getFileHandle(n, o = {}) { if (!this.files.has(n)) { if (!o.create) throw new Error('NotFound'); this.files.set(n, new FakeFile()); } return this.files.get(n); }
  async getDirectoryHandle(n, o = {}) { if (!this.dirs.has(n)) { if (!o.create) throw new Error('NotFound'); this.dirs.set(n, new FakeDir(n)); } return this.dirs.get(n); }
  async *entries() { for (const e of this.files) yield e; }
}

let fail = 0;
const ok = (name, c, info = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${name.padEnd(44)} ${info}`); };
const shape = kind => ({ kind, params: { ...SHAPES[kind] } });

const d = new Doc();
const a = d.add(shape('box'));
const b = d.add(shape('cylinder'));
d.update([a], 'Move', p => { p.xform.pos = [10, 0, 0]; });
d.update([a], 'Resize', p => { p.params.x = 40; });
d.update([b], 'Hole', p => { p.hole = true; });
ok('5 steps recorded', d.history.length === 5 && d.at === 5);
const bytes = JSON.stringify(d.history).length;
ok('history is small', bytes < 4000, `${bytes} bytes for 5 steps`);

d.undo();
ok('undo the hole', d.top(b).hole === false);
d.redo();
ok('redo the hole', d.top(b).hole === true);

// roll back only part a to before its move; b keeps its hole
const hist = d.partHistory(a);
ok('part a has 3 states', hist.length === 3, hist.map(h => h.cmd.label).join(' < '));
d.rollbackPart(a, hist.find(h => h.cmd.label === 'Move').cmd);
ok('rollback a: position and size back', d.top(a).xform.pos[0] === 0 && d.top(a).params.x === 20);
ok('rollback a: b untouched', d.top(b).hole === true);

// groups
const g = d.group([a, b]);
ok('group of 2', d.parts.length === 1 && d.top(g).children.length === 2);

d.update([g], 'Move group', p => { p.xform.pos = [5, 5, 0]; p.xform.rot = [0, 0, 90]; });
const kids = d.ungroup(g);
const ka = d.top(kids[0]);
ok('ungroup keeps world placement', Math.abs(ka.xform.pos[0] - 5) < 1e-9 && Math.abs(ka.xform.pos[1] - 5) < 1e-9 && Math.abs(ka.xform.rot[2] - 90) < 1e-9, JSON.stringify(ka.xform));
const dup = d.duplicate([kids[0]], [30, 0, 0]);
ok('duplicate', d.parts.length === 3 && d.top(dup[0]).xform.pos[0] - ka.xform.pos[0] === 30 && dup[0] !== kids[0]);

// svg part
const svgId = d.add({ kind: 'svg', params: { height: 10, polygons: [[[[-10, -10], [10, -10], [10, 10], [-10, 10]]]] } }, 'Add SVG');
d.update([svgId], 'Change SVG height', q => { q.params.height = 15; });
ok('svg part in doc with height update', d.top(svgId).params.height === 15);
d.undo();
ok('undo svg height', d.top(svgId).params.height === 10);
d.undo();
ok('undo svg add', !d.parts.some(q => q.id === svgId));



// project folder: write through, reopen, replay
const dir = new FakeDir();
const d2 = new Doc();
const p = await Project.create(dir, d2);
const ids = [];
for (let i = 0; i < 12; i++) ids.push(d2.add(shape(['box', 'sphere', 'torus'][i % 3])));
d2.update([ids[0]], 'Move', q => { q.xform.pos = [1, 2, 3]; });
const tris = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const blob = d2.addBlob(tris);
d2.add({ kind: 'mesh', blob });
d2.undo(); d2.undo(); d2.redo();
await p.flush();
const lines = new TextDecoder().decode(dir.files.get('journal.ndjson').data).trim().split('\n').length;
ok('every step journaled', lines === 17, `${lines} lines`);
ok('mesh written once', dir.dirs.get('meshes').files.has(blob + '.f32'));

const d3 = new Doc();
const { replayed } = await Project.open(dir, d3);
ok('reopen replays the journal', replayed === 17 && JSON.stringify(d3.parts) === JSON.stringify(d2.parts), `${replayed} replayed, ${d3.parts.length} parts`);
ok('reopen: undo still works', d3.at === d2.at && d3.history.length === d2.history.length);
ok('reopen: mesh back', d3.blobs.get(blob)?.length === 9);
const nextId = d3.add(shape('box'));
ok('reopen: new ids do not collide', !d2.parts.some(q => q.id === nextId), nextId);

// a crash mid-line: the torn last line is skipped, everything before it survives
const jf = dir.files.get('journal.ndjson');
jf.data = Uint8Array.from([...jf.data, ...new TextEncoder().encode('{"seq":99,"type":"cm')]);
const d4 = new Doc();
const r4 = await Project.open(dir, d4);
ok('torn last line skipped', r4.torn === 1 && d4.parts.length === d3.parts.length - 1);

// compaction: 250 steps, then reopen
const dir2 = new FakeDir();
const d5 = new Doc();
const p5 = await Project.create(dir2, d5);
const id5 = d5.add(shape('box'));
for (let i = 0; i < 250; i++) d5.update([id5], 'Nudge', q => { q.xform.pos[0] += 1; });
await p5.flush();
const d6 = new Doc();
await Project.open(dir2, d6);
ok('compaction + reopen', d6.top(id5).xform.pos[0] === 250 && d6.at === 251, `x ${d6.top(id5)?.xform.pos[0]}, ${d6.at} steps`);

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
