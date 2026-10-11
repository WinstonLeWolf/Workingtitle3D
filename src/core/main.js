// The shell: shapes, parts, inspector, view, project folder, keys.
// Parts are recipes in the Doc; meshes come from the worker; tools are steps in a recipe.
import workerSrc from 'virtual:worker-src';
import tools from 'virtual:tools-ui';
import { Viewer } from './viewer.js';
import * as ui from './ui.js';
import { Vector3, Box3 } from 'three';
import { Doc, shapeKey, IDENT, matrix } from './doc.js';
import { Project } from './project.js';
import { describe, weld } from './meshcheck.js';

const { h, button, seg, card, kv, errorLine, ask, mm, count } = ui;
const SHAPES = {
  box: { x: 20, y: 20, z: 20 },
  cylinder: { d: 20, h: 20, sides: 64 },
  cone: { d1: 20, d2: 0, h: 20, sides: 64 },
  sphere: { d: 20, sides: 64 },
  torus: { d: 20, tube: 4, sides: 64, tubeSides: 24 },
  wedge: { x: 20, y: 20, z: 20 },
  tube: { d: 20, wall: 2, h: 20, sides: 64 },
  fillet: { r: 5, length: 20, sides: 64 },
};
const LABELS = { x: 'Width', y: 'Depth', z: 'Height', h: 'Height', d: 'Diameter', d1: 'Bottom diameter', d2: 'Top diameter',
  tube: 'Tube', wall: 'Wall', sides: 'Facets', tubeSides: 'Tube facets', r: 'Radius', length: 'Length' };
const GRID = 1;   // mm per arrow press and drag snap
// Part colours are the model's own content (filament colours), not interface colour. Every
// swatch carries its name and the chosen name is shown as text, so no choice rests on hue.
const COLOURS = [
  ['Default', ''], ['White', '#f2f2f2'], ['Light gray', '#c4c4c4'], ['Gray', '#8a8a8a'], ['Dark gray', '#4a4a4a'], ['Black', '#1e1e1e'],
  ['Red', '#d32f2f'], ['Orange', '#f57c00'], ['Yellow', '#fbc02d'], ['Gold', '#c9a227'], ['Lime', '#9ccc65'], ['Green', '#388e3c'],
  ['Olive', '#827717'], ['Teal', '#00897b'], ['Cyan', '#00acc1'], ['Blue', '#1e88e5'], ['Navy', '#283593'], ['Purple', '#7b1fa2'],
  ['Magenta', '#c2185b'], ['Pink', '#f48fb1'], ['Brown', '#6d4c41'], ['Tan', '#c8a27a'], ['Silver', '#a8b0b8'], ['Copper', '#b87333'],
];
let paletteOpen = false;   // stays open while picking, across inspector redraws
const colourName = hex => (COLOURS.find(c => c[1].toLowerCase() === (hex || '').toLowerCase()) || [hex ? hex.toUpperCase() : 'Default'])[0];

/** Colour row: swatch + name, opens a named palette with a hex field. */
function colourPicker(current, onpick) {
  const swatch = h('span', { class: 'swatch' + (current ? '' : ' none'), style: current ? `background:${current}` : '' });
  const label = h('span', { class: 'cname' }, colourName(current));
  const grid = h('div', { class: 'palette', style: paletteOpen ? '' : 'display:none' });
  for (const [name, hex] of COLOURS) {
    grid.append(h('button', { type: 'button', class: 'sw' + (hex === (current || '') ? ' on' : '') + (hex ? '' : ' none'), title: name,
      style: hex ? `background:${hex}` : '', onclick: () => onpick(hex) }));
  }
  const hexIn = h('input', { type: 'text', class: 'hex-in', value: current || '', placeholder: '#rrggbb', spellcheck: 'false' });
  hexIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') hexIn.blur(); });
  hexIn.addEventListener('change', () => { const v = hexIn.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) onpick((v[0] === '#' ? v : '#' + v).toLowerCase()); else hexIn.classList.add('bad'); });
  grid.append(h('div', { class: 'hexrow' }, 'Hex', hexIn));
  const toggle = button('Colour', () => { paletteOpen = !paletteOpen; grid.style.display = paletteOpen ? '' : 'none'; }, { small: true });
  return h('div', {}, h('div', { class: 'colourrow' }, swatch, label, toggle), grid);
}

// ---- workers ------------------------------------------------------------------------------
// "io" reads, writes and checks files; "kern" builds part meshes and keeps their cache.
class Pool {
  constructor() {
    this.url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    this.jobs = new Map();
    this.seq = 0;
    this.w = { io: this.spawn('io'), kern: this.spawn('kern') };
  }
  spawn(kind) {
    const w = new Worker(this.url);
    w.onmessage = e => this.msg(e.data);
    w.onerror = e => {
      e.preventDefault();
      this.failAll(kind, new Error(`Internal error in the worker: ${e.message || 'it stopped'}`));
      this.w[kind] = this.spawn(kind);
      if (kind === 'kern') sentBlobs.clear();
    };
    return w;
  }
  failAll(kind, err) { for (const [id, j] of this.jobs) if (j.kind === kind) { this.jobs.delete(id); j.rej(err); } }
  call(kind, msg, transfer = [], onProgress = null) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.jobs.set(id, { kind, res, rej, onProgress });
      this.w[kind].postMessage({ ...msg, id }, transfer);
    });
  }
  msg(d) {
    const j = this.jobs.get(d.id);
    if (!j) return;
    if (d.type === 'progress') { j.onProgress?.(d.frac, d.text); return; }
    this.jobs.delete(d.id);
    if (d.type === 'done') j.res(d); else j.rej(Object.assign(new Error(d.message), { user: d.user }));
  }
}
const pool = new Pool();
const sentBlobs = new Set();

// ---- state --------------------------------------------------------------------------------
let doc = new Doc();
let project = null;
let projectAsked = false;
const meshes = new Map();      // part id -> {key, tris, volume}
let sel = [];                  // selected top-level part ids
let step = null;               // a tool step being set up: {tool, params, partId, face, previewKey}
let clipboard = null;
let lastDup = null;
let fmt = 'stl';

// ---- layout -------------------------------------------------------------------------------
const app = document.getElementById('app');
const importInput = h('input', { type: 'file', accept: '.stl,.obj,.3mf', multiple: true, style: 'display:none' });
const projLabel = h('span', { class: 'file' });
const projBtn = button('Pick folder', () => pickProjectFolder(), { small: true });
const btnUndo = button('Undo', () => undo(), { title: 'Ctrl+Z' });
const btnRedo = button('Redo', () => redo(), { title: 'Ctrl+Y' });
const header = h('header', {},
  h('span', { class: 'name' }, 'Workingtitle3D'),
  button('New', () => newProject(), { title: 'Start an empty project' }),
  button('Open', () => openProject(), { title: 'Open a project folder' }),
  button('Import', () => importInput.click(), { title: 'Add an STL, 3MF or OBJ as a part (Ctrl+I is intersect)' }),
  seg([['stl', 'STL'], ['3mf', '3MF'], ['obj', 'OBJ']], fmt, v => { fmt = v; }),
  button('Export', () => exportModel(), { title: 'Save every solid part joined into one closed solid (Ctrl+E)' }),
  btnUndo, btnRedo,
  h('span', { class: 'spacer' }), projLabel, projBtn, importInput);

const shapeGrid = h('div', { class: 'shapes' }, ...Object.keys(SHAPES).map(k => {
  const b = button(k[0].toUpperCase() + k.slice(1), () => addShape(k), { title: `Add a ${k} on the plate` });
  return b;
}));
const partList = h('div', { class: 'parts' });
const stepCard = h('div');
const aside = h('aside', {}, card('Shapes', shapeGrid), card('Parts', partList), stepCard);

const view = h('div', { id: 'view' });
const inspector = h('div', { class: 'inspector', style: 'display:none' });
const dropHint = h('div', { class: 'drop' }, h('b', {}, 'Add a shape, or drop an STL, 3MF or OBJ here'), 'Right drag orbits, middle drag pans, wheel zooms. Nothing leaves this computer.');
const cutRange = h('input', { type: 'range', min: 0, max: 1000, value: 500, class: 'cut' });
let cutAxis = null;
const cutSeg = seg([['off', 'Off'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'off', v => { cutAxis = v === 'off' ? null : v; viewer.setClip(cutAxis, cutRange.value / 1000); });
cutRange.addEventListener('input', () => { if (cutAxis) viewer.setClip(cutAxis, cutRange.value / 1000); });
const views = h('div', { class: 'overlay tl' },
  ...[['iso', 'Fit (F)'], ['top', 'Top'], ['front', 'Front'], ['right', 'Right']].map(([k, l]) => button(l, () => viewer.view(k, k === 'iso' ? sel : []), { small: true })));
const cut = h('div', { class: 'overlay br' }, h('span', { class: 'lbl' }, 'Cut'), cutSeg, cutRange);
view.append(dropHint, views, cut, inspector);

const statusMsg = h('span', { class: 'msg' }, 'Ready.');
const statusRight = h('span', { class: 'mono' });
app.append(header, aside, view, h('footer', {}, statusMsg, statusRight));

const viewer = new Viewer(view);

function status(text, error = false) {
  statusMsg.textContent = text;
  statusMsg.className = 'msg' + (error ? ' err' : '');
}

// ---- document changes ----------------------------------------------------------------------
function bindDoc() {
  doc.on(ev => {
    if (ev.type === 'cmd' && !project && !projectAsked) { projectAsked = true; setTimeout(askForFolder, 0); }
    refresh();
  });
}
bindDoc();

let syncing = 0;
/** Bring meshes, view, lists and inspector up to date with the doc. */
async function refresh() {
  sel = sel.filter(id => doc.top(id));
  renderParts();
  renderInspector();
  updateHeader();
  dropHint.style.display = doc.parts.length ? 'none' : '';
  const my = ++syncing;
  const need = doc.parts.filter(p => meshes.get(p.id)?.key !== shapeKey(p));
  viewer.sync(doc.parts, meshes);   // moves, hides and holes show at once
  if (!need.length) return;
  await sendBlobs();
  for (const p of need) {
    try {
      const key = shapeKey(p);
      const r = await pool.call('kern', { type: 'mesh', part: p }, [], (f, t) => status(`${p.name}: ${t}...`));
      meshes.set(p.id, { key, tris: r.tris, volume: r.volume });
    } catch (err) {
      status(`${p.name}: ${err.message}`, true);
    }
  }
  for (const id of [...meshes.keys()]) if (!doc.find(id)) meshes.delete(id);
  void my;
  viewer.sync(doc.parts, meshes);
  renderParts();
  renderInspector();
}

async function sendBlobs() {
  for (const [id, tris] of doc.blobs) {
    if (sentBlobs.has(id)) continue;
    sentBlobs.add(id);
    await pool.call('kern', { type: 'blob', blobId: id, tris: tris.slice() });
  }
}

function setSel(ids) {
  sel = ids.filter(id => doc.top(id));
  viewer.select(sel);
  renderParts();
  renderInspector();
}

// ---- shapes and parts list -------------------------------------------------------------------
function addShape(kind) {
  const n = doc.parts.length;
  // drop new shapes in a loose spiral so they do not land inside each other
  const a = n * 2.4, r = n ? 12 + 6 * Math.sqrt(n) : 0;
  const id = doc.add({ kind, params: { ...SHAPES[kind] }, xform: { pos: [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a)), 0], rot: [0, 0, 0], scale: [1, 1, 1] } });
  setSel([id]);
  status(`Added ${doc.top(id).name}.`);
}

function renderParts() {
  partList.replaceChildren(...doc.parts.map(p => {
    const on = sel.includes(p.id);
    const tags = [p.hole ? 'hole' : 'solid', p.hidden ? 'hidden' : '', p.locked ? 'locked' : '', p.kind === 'group' ? `${p.children.length} parts` : ''].filter(Boolean).join(' · ');
    const row = h('button', { type: 'button', class: 'prow' + (on ? ' on' : '') + (p.hidden ? ' dim' : ''), onclick: e => {
      if (e.shiftKey || e.ctrlKey) setSel(on ? sel.filter(x => x !== p.id) : [...sel, p.id]); else setSel([p.id]);
    } }, h('span', { class: 'pn' }, p.name), h('span', { class: 'pt' }, tags));
    return row;
  }));
  if (!doc.parts.length) partList.append(h('p', {}, 'No parts yet.'));
}

// ---- inspector ----------------------------------------------------------------------------
let inspectorFor = null;
// never rebuild under a field being typed in; catch up when focus leaves
inspector.addEventListener('focusout', () => setTimeout(() => { if (document.activeElement?.tagName !== 'INPUT' || !inspector.contains(document.activeElement)) renderInspector(); }, 0));
function renderInspector() {
  if (!sel.length) { inspector.style.display = 'none'; inspectorFor = null; return; }
  const key = sel.join();
  if (inspectorFor === key && inspector.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  inspectorFor = key;
  inspector.style.display = '';
  if (sel.length > 1) {
    const first = doc.top(sel[0]);
    inspector.replaceChildren(card(`${sel.length} parts`,
      colourPicker(sel.every(id => doc.top(id)?.color === first?.color) ? first?.color : '', hex => {
        const ids = editable();
        if (ids.length) doc.update(ids, `Colour ${ids.length} parts: ${colourName(hex)}`, q => { if (hex) q.color = hex; else delete q.color; });
      }),
      h('div', { class: 'row' }, button('Group', () => groupSel(), { title: 'Ctrl+G' }), button('Intersect', () => groupSel('intersect'), { title: 'Ctrl+I' })),
      h('div', { class: 'row' }, button('Align', () => status('Align is not built yet.')), button('Delete', () => deleteSel(), { title: 'Delete' }))));
    return;
  }
  const p = doc.top(sel[0]);
  if (!p) return;
  const m = meshes.get(p.id);
  const lock = p.locked;
  const upd = (label, fn) => { if (lock) { status(`${p.name} is locked (Ctrl+L).`); return; } doc.update([p.id], label, fn); };
  const name = h('input', { type: 'text', class: 'name-in', value: p.name, spellcheck: 'false' });
  name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== p.name) doc.update([p.id], `Rename to ${v}`, q => { q.name = v; }); });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  const body = [
    h('div', { class: 'row' }, name),
    seg([['solid', 'Solid'], ['hole', 'Hole']], p.hole ? 'hole' : 'solid', v => upd(v === 'hole' ? `${p.name} to hole` : `${p.name} to solid`, q => { q.hole = v === 'hole'; })),
  ];
  if (!p.hole) body.push(colourPicker(p.color, hex => upd(`${p.name} colour: ${colourName(hex)}`, q => { if (hex) q.color = hex; else delete q.color; })));
  if (p.params) {
    for (const [k, v] of Object.entries(p.params)) {
      const facets = k === 'sides' || k === 'tubeSides';
      body.push(ui.numfield(LABELS[k] || k, v, facets ? '' : 'mm', nv => upd(`${p.name}: ${(LABELS[k] || k).toLowerCase()} ${nv}`, q => { q.params[k] = facets ? Math.round(nv) : nv; }),
        { min: facets ? 3 : k === 'd2' || k === 'd1' ? 0 : 0.01, max: facets ? 512 : 5000, step: facets ? 4 : 1, lazy: true, digits: facets ? 0 : 3 }));
    }
  }
  // where the part really is: its middle in X and Y, its lowest point in Z (0 = on the plate)
  const wb = worldBox(p);
  body.push(h('div', { class: 'sub' }, 'Position'));
  if (wb) {
    const at = [(wb.min.x + wb.max.x) / 2, (wb.min.y + wb.max.y) / 2, wb.min.z];
    [['Centre X', 0], ['Centre Y', 1], ['Bottom Z', 2]].forEach(([label, i]) => body.push(ui.numfield(label, +at[i].toFixed(4), 'mm',
      v => upd(`Move ${p.name}`, q => { q.xform.pos[i] = +(q.xform.pos[i] + v - at[i]).toFixed(6); }), { step: 1, lazy: true, digits: 3 })));
  }
  body.push(h('div', { class: 'sub' }, 'Rotation (about its middle)'));
  ['X', 'Y', 'Z'].forEach((a, i) => body.push(ui.numfield(a, p.xform.rot[i], 'deg',
    v => upd(`Rotate ${p.name}`, q => { const r = [...q.xform.rot]; r[i] = v; q.xform = rotated(q, r); }), { step: 15, lazy: true, digits: 3 })));
  if (!p.params) {
    body.push(h('div', { class: 'sub' }, 'Scale'));
    ['X', 'Y', 'Z'].forEach((a, i) => body.push(ui.numfield(a, p.xform.scale[i] * 100, '%', v => upd(`Scale ${p.name}`, q => { q.xform.scale[i] = v / 100; }), { min: 0.1, max: 100000, step: 10, lazy: true, digits: 3 })));
  }
  // steps
  body.push(h('div', { class: 'sub' }, 'Steps'));
  (p.ops || []).forEach((op, i) => {
    const t = tools.find(x => x.id === op.tool);
    body.push(h('div', { class: 'steprow' }, h('span', {}, `${i + 1}. ${t?.stepLabel?.(op.params) || t?.title || op.tool}`),
      button('Remove', () => upd(`Remove step ${i + 1} from ${p.name}`, q => { q.ops.splice(i, 1); }), { small: true })));
  });
  body.push(h('div', { class: 'row wrap' }, ...tools.map(t => button(t.title, () => startStep(t, p.id), { small: true, title: t.blurb }))));
  // history of this part
  const hist = doc.partHistory(p.id).slice(0, 6);
  if (hist.length > 1) {
    body.push(h('div', { class: 'sub' }, 'Roll back this part'));
    for (const e of hist.slice(0, -1)) {
      body.push(h('div', { class: 'steprow' }, h('span', { title: e.cmd.label }, 'before: ' + e.cmd.label), button('Roll back', () => { doc.rollbackPart(p.id, e.cmd); status(`${p.name} rolled back.`); }, { small: true })));
    }
  }
  if (m) {
    const b = wb;
    body.push(kv([['size', b ? `${mm(b.max.x - b.min.x)} x ${mm(b.max.y - b.min.y)} x ${mm(b.max.z - b.min.z)}` : '-'], ['volume', `${(m.volume / 1000).toFixed(2)} cm3`], ['triangles', count(m.tris.length / 9)]]));
  }
  if (lock) body.push(h('div', { class: 'note' }, 'Locked: Ctrl+L to unlock.'));
  inspector.replaceChildren(card(p.kind === 'group' ? `Group${p.mode === 'intersect' ? ' (intersect)' : ''}` : p.kind, ...body));
}

// ---- selection and editing ----------------------------------------------------------------------
viewer.onPick = (id, face, e) => {
  if (step && id === step.partId && step.tool.needsFace) { pickStepFace(face); return; }
  if (!id) { if (!e.shiftKey) setSel([]); return; }
  if (e.shiftKey) setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  else setSel([id]);
};
viewer.onBox = (ids, e) => setSel(e.shiftKey ? [...new Set([...sel, ...ids])] : ids);

let drag = null;
viewer.onDragStart = (id, e) => {
  if (step) return false;
  const p = doc.top(id);
  if (!p || p.locked) { if (p?.locked) status(`${p.name} is locked (Ctrl+L).`); return false; }
  if (!sel.includes(id)) setSel([id]);
  let ids = sel.filter(x => !doc.top(x)?.locked);
  if (e.altKey) { ids = doc.duplicate(ids); setSel(ids); }    // Alt: drag a copy
  drag = { ids, start: new Map(ids.map(x => [x, [...doc.top(x).xform.pos]])), d: [0, 0] };
  return true;
};
viewer.onDrag = (dx, dy, e) => {
  if (!drag) return;
  const snap = e.shiftKey ? 0.1 : GRID;
  drag.d = [Math.round(dx / snap) * snap, Math.round(dy / snap) * snap];
  for (const id of drag.ids) {
    const p = doc.top(id), s = drag.start.get(id);
    viewer.setXform(id, { ...p.xform, pos: [s[0] + drag.d[0], s[1] + drag.d[1], s[2]] });
  }
  status(`Move ${mm(drag.d[0])}, ${mm(drag.d[1])} mm${e.shiftKey ? '' : '  (Shift: 0.1 mm steps)'}`);
};
viewer.onDragEnd = () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.d[0] && !d.d[1]) { viewer.sync(doc.parts, meshes); return; }
  doc.update(d.ids, d.ids.length > 1 ? `Move ${d.ids.length} parts` : `Move ${doc.top(d.ids[0]).name}`, p => {
    const s = d.start.get(p.id);
    p.xform.pos = [+(s[0] + d.d[0]).toFixed(6), +(s[1] + d.d[1]).toFixed(6), s[2]];
  });
};

const editable = () => sel.filter(id => !doc.top(id)?.locked);
function nudge(dx, dy, dz) {
  const ids = editable();
  if (!ids.length) return;
  doc.update(ids, `Nudge ${ids.length > 1 ? ids.length + ' parts' : doc.top(ids[0]).name}`, p => {
    p.xform.pos = p.xform.pos.map((v, i) => +(v + [dx, dy, dz][i]).toFixed(6));
  });
}
function dropToPlate() {
  const ids = editable();
  for (const id of ids) {
    const b = worldBox(doc.top(id));
    if (b && Math.abs(b.min.z) > 1e-9) doc.update([id], `Drop ${doc.top(id).name} to the plate`, p => { p.xform.pos[2] = +(p.xform.pos[2] - b.min.z).toFixed(9); });
  }
}
function setHole(on) {
  const ids = editable();
  if (ids.length) doc.update(ids, on ? 'To hole' : 'To solid', p => { p.hole = on; });
}
function toggleLock() {
  if (!sel.length) return;
  const on = !doc.top(sel[0]).locked;
  doc.update(sel, on ? 'Lock' : 'Unlock', p => { p.locked = on; });
  status(on ? 'Locked.' : 'Unlocked.');
}
function hideSel() {
  if (!sel.length) return;
  doc.update(sel, 'Hide', p => { p.hidden = true; });
  setSel([]);
}
function showAll() {
  const ids = doc.parts.filter(p => p.hidden).map(p => p.id);
  if (ids.length) doc.update(ids, 'Show hidden', p => { p.hidden = false; });
}
function deleteSel() {
  const ids = editable();
  if (!ids.length) return;
  doc.remove(ids);
  setSel([]);
}
function groupSel(mode = '') {
  if (sel.length < 2) { status('Select two or more parts to group (Shift+click or drag a box).'); return; }
  const id = doc.group(editable(), mode);
  if (id) setSel([id]);
}
function ungroupSel() {
  const out = [];
  for (const id of editable()) if (doc.top(id)?.kind === 'group') out.push(...doc.ungroup(id));
  if (out.length) setSel(out);
}
function mirrorSel(axis) {
  const ids = editable();
  if (ids.length) doc.update(ids, `Mirror ${'XYZ'[axis]}`, p => { p.xform.scale[axis] *= -1; });
}
function duplicateSel() {
  if (!sel.length) return;
  // repeat duplicate: if the last copy was moved, the next copy moves by the same amount
  let offset = [0, 0, 0];
  if (lastDup && lastDup.copies.join() === sel.join()) {
    const a = doc.top(lastDup.src[0]), b = doc.top(lastDup.copies[0]);
    if (a && b) offset = b.xform.pos.map((v, i) => v - a.xform.pos[i]);
  }
  const src = [...sel];
  const copies = doc.duplicate(src, offset);
  lastDup = { src, copies };
  setSel(copies);
}
function copySel() { if (sel.length) { clipboard = sel.map(id => JSON.parse(JSON.stringify(doc.top(id)))); status(`Copied ${sel.length}.`); } }
function paste() {
  if (!clipboard) return;
  const ids = [];
  doc.commit(`Paste ${clipboard.length}`, parts => {
    const reid = p => ({ ...p, id: doc.newId(), children: p.children?.map(reid) });
    for (const c of clipboard) { const n = reid(JSON.parse(JSON.stringify(c))); n.xform.pos[0] += 10; n.xform.pos[1] += 10; parts.push(n); ids.push(n.id); }
  });
  setSel(ids);
}

// ---- tool steps -----------------------------------------------------------------------------
function startStep(t, partId) {
  cancelStep();
  const p = doc.top(partId);
  if (!p) return;
  if (p.locked) { status(`${p.name} is locked (Ctrl+L).`); return; }
  step = { tool: t, partId, params: structuredClone(t.defaults || {}), face: null, seq: 0 };
  const body = h('div'), statusEl = h('div'), prog = h('div', { class: 'prog', style: 'display:none' }, h('i'));
  const applyBtn = button('Apply', () => applyStep(), { go: true });
  const row = h('div', { class: 'row' }, button('Preview', () => previewStep()), applyBtn, button('Cancel', () => cancelStep()));
  stepCard.replaceChildren(card(`${t.title}: ${p.name}`, t.blurb ? h('p', {}, t.blurb) : null, body, statusEl, prog, row));
  const m = meshes.get(partId);
  const lb = m ? localBounds(m.tris) : null;
  const api = {
    params: step.params, ui,
    set(k, v) { step.params[k] = v; stepChanged(); },
    model: () => lb && { bounds: lb },
    selection: () => step?.face,
    clearSelection: () => { step.face = null; viewer.setFacePick(null); stepChanged(); },
  };
  step.ui = { body, statusEl, prog, applyBtn, hooks: t.panel(body, api) || {} };
  status(t.needsFace ? `${t.title}: click a face on ${p.name} if the step needs one.` : `${t.title}: set it up, then Preview or Apply.`);
  stepChanged();
}

function stepProblem() {
  if (!step) return null;
  const m = meshes.get(step.partId);
  return step.tool.validate?.(step.params, { model: m && { bounds: localBounds(m.tris) }, selection: step.face }) || null;
}
function stepChanged() {
  if (!step) return;
  viewer.preview(step.partId, null);
  step.previewed = false;
  step.ui.hooks.update?.();
  const p = stepProblem();
  step.ui.statusEl.replaceChildren(...(!p ? [] : p.wait ? [h('div', { class: 'note' }, p.wait)] : [errorLine(p)]));
  step.ui.applyBtn.disabled = !!p;
  if (step.tool.live && !p) { clearTimeout(step.timer); step.timer = setTimeout(previewStep, 200); }
}
function stepOp() {
  const op = { tool: step.tool.id, params: structuredClone(step.params) };
  if (step.face) op.sel = { normal: step.face.normal, d: step.face.d, point: step.face.point };
  return op;
}
async function previewStep() {
  if (!step || stepProblem()) return;
  const my = ++step.seq, s = step;
  const p = doc.top(s.partId);
  const part = { ...p, ops: [...(p.ops || []), stepOp()] };
  s.ui.prog.style.display = '';
  try {
    await sendBlobs();
    const r = await pool.call('kern', { type: 'mesh', part }, [], (f, t) => { if (step === s && my === s.seq) { s.ui.prog.firstChild.style.width = `${Math.round(f * 100)}%`; status(`${s.tool.title}: ${t}...`); } });
    if (step !== s || my !== s.seq) return;
    meshes.set('preview', { key: shapeKey(part), tris: r.tris, volume: r.volume });
    viewer.preview(s.partId, r.tris);
    s.previewed = true;
    status(`${s.tool.title}: preview ready. Apply keeps it.`);
  } catch (err) {
    if (step === s) { s.ui.statusEl.replaceChildren(errorLine(err.message)); status(err.message, true); }
  } finally { if (step === s) s.ui.prog.style.display = 'none'; }
}
async function applyStep() {
  if (!step || stepProblem()) return;
  const s = step;
  if (!s.previewed) await previewStep();
  if (step !== s || !s.previewed) return;
  const op = stepOp();
  const p = doc.top(s.partId);
  const pre = meshes.get('preview');
  cancelStep();
  // the preview already is the new mesh: hand it over so nothing is rebuilt
  if (pre) meshes.set(p.id, { ...pre, key: shapeKey({ ...p, ops: [...(p.ops || []), op] }) });
  doc.update([p.id], `${s.tool.title} on ${p.name}`, q => { q.ops = [...(q.ops || []), op]; });
  status(`${s.tool.title} added to ${p.name} as step ${doc.top(p.id).ops.length}.`);
}
function cancelStep() {
  if (!step) return;
  viewer.preview(step.partId, null);
  viewer.setFacePick(null);
  clearTimeout(step.timer);
  step = null;
  meshes.delete('preview');
  stepCard.replaceChildren();
}
function pickStepFace(face) {
  const m = meshes.get(step.partId);
  if (!m || face < 0) return;
  const region = faceRegion(m.tris, face);
  step.face = region;
  viewer.setFacePick(step.partId, region.tris);
  status(`Face picked: ${mm(region.area)} mm2.`);
  stepChanged();
}

/** The flat region round a triangle, in the part's own frame. */
function faceRegion(t, seed) {
  const nrm = f => {
    const i = f * 9;
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
    const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n) || 1;
    return { n: n.map(v => v / l), area: l / 2 };
  };
  const { n } = nrm(seed);
  const d = n[0] * t[seed * 9] + n[1] * t[seed * 9 + 1] + n[2] * t[seed * 9 + 2];
  const { idx } = weld(t);
  const flat = f => {
    if (nrm(f).n.reduce((s, v, k) => s + v * n[k], 0) < 1 - 1e-6) return false;
    for (let k = 0; k < 9; k += 3) if (Math.abs(n[0] * t[f * 9 + k] + n[1] * t[f * 9 + k + 1] + n[2] * t[f * 9 + k + 2] - d) > 1e-3) return false;
    return true;
  };
  const byVert = new Map();
  for (let f = 0; f < t.length / 9; f++) for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; (byVert.get(v) || byVert.set(v, []).get(v)).push(f); }
  const seen = new Set([seed]), stack = [seed], out = [];
  let area = 0;
  while (stack.length) {
    const f = stack.pop();
    out.push(f); area += nrm(f).area;
    for (let k = 0; k < 3; k++) for (const g of byVert.get(idx[f * 3 + k])) if (!seen.has(g)) { seen.add(g); if (flat(g)) stack.push(g); }
  }
  const i = seed * 9;
  const point = [(t[i] + t[i + 3] + t[i + 6]) / 3, (t[i + 1] + t[i + 4] + t[i + 7]) / 3, (t[i + 2] + t[i + 5] + t[i + 8]) / 3];
  return { tris: out, normal: n, d, point, area };
}

/** A part's world box from its real points; the quick box of a rotated mesh is too big. */
function worldBox(p, xform = p.xform) {
  const m = meshes.get(p.id);
  if (!m) return null;
  const t = m.tris, M = matrix(xform), e = M.elements, b = new Box3();
  const v = new Vector3();
  const n = t.length / 3, stride = n > 600000 ? Math.ceil(n / 600000) : 1;
  for (let i = 0; i < n; i += stride) {
    const x = t[i * 3], y = t[i * 3 + 1], z = t[i * 3 + 2];
    v.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    b.expandByPoint(v);
  }
  return b;
}

/** The part's xform with new rotations, turned about its own middle so it stays where it is. */
function rotated(p, rot) {
  const m = meshes.get(p.id);
  const nx = { ...p.xform, rot };
  if (!m) return nx;
  const lb = localBounds(m.tris);
  const c = new Vector3((lb.lo[0] + lb.hi[0]) / 2, (lb.lo[1] + lb.hi[1]) / 2, (lb.lo[2] + lb.hi[2]) / 2);
  const before = c.clone().applyMatrix4(matrix(p.xform));
  const after = c.clone().applyMatrix4(matrix({ ...nx, pos: [0, 0, 0] }));
  nx.pos = [before.x - after.x, before.y - after.y, before.z - after.z].map(v => +v.toFixed(6));
  return nx;
}

function localBounds(t) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], t[i + a]); hi[a] = Math.max(hi[a], t[i + a]); }
  return { lo, hi };
}

// ---- undo -----------------------------------------------------------------------------------
function undo() { cancelStep(); const c = doc.undo(); if (c) status(`Undone: ${c.label}.`); }
function redo() { cancelStep(); const c = doc.redo(); if (c) status(`Redone: ${c.label}.`); }

// ---- project folder ------------------------------------------------------------------------
function updateHeader() {
  btnUndo.disabled = !doc.at;
  btnRedo.disabled = doc.at >= doc.history.length;
  if (project) {
    projLabel.textContent = project.error ? '' : `${project.name}  ${project.pending ? 'saving...' : 'saved'}`;
    projBtn.style.display = 'none';
    if (project.error) { projLabel.textContent = ''; status(`Could not write to the project folder: ${project.error.message}`, true); }
  } else {
    projLabel.textContent = doc.history.length ? 'not saved to disk' : '';
    projBtn.style.display = doc.history.length ? '' : 'none';
  }
  const tris = [...meshes.entries()].filter(([k]) => k !== 'preview').reduce((s, [, m]) => s + (m ? m.tris.length / 9 : 0), 0);
  statusRight.textContent = doc.parts.length ? `${doc.parts.length} parts  ${count(tris)} tris` : '';
}

function watch(p) {
  project = p;
  p.onstate = () => updateHeader();
  updateHeader();
}

async function askForFolder() {
  const go = await ask('Pick a folder for this project. Every step is written there as you work, so a crash loses nothing.',
    [['Later', false], ['Pick folder', true, true]]);
  if (go) await pickProjectFolder();
  else status('Not saved to disk yet. Pick folder (top right) when ready.');
}

/** The browser's folder picker, or null. Some Chromium browsers ship with folder access off. */
async function chooseFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    status('This browser has folder access switched off, so projects cannot be saved. '
      + 'In Brave: open brave://flags/#file-system-access-api, set it to Enabled, restart Brave. Edge, Vivaldi and Chromium have it on.', true);
    await ask(h('div', {}, h('p', {}, 'This browser has folder access switched off, so the project cannot be saved to a folder.'),
      h('p', {}, 'In Brave: put brave://flags/#file-system-access-api in the address bar, set it to Enabled, and restart Brave.'),
      h('p', {}, 'Edge, Vivaldi and Chromium have it on already. Export still works meanwhile.')));
    return null;
  }
  try { return await window.showDirectoryPicker({ mode: 'readwrite', id: 'wt3d-project' }); } catch (err) { if (err.name !== 'AbortError') status(err.message, true); return null; }
}

async function pickProjectFolder() {
  const dir = await chooseFolder();
  if (!dir) return;
  if (await Project.exists(dir)) {
    const go = await ask(`${dir.name} already holds a project. Open it instead? Your current parts are dropped.`, [['Cancel', false], ['Open it', true, true]]);
    if (go) await openFolder(dir);
    return;
  }
  try { watch(await Project.create(dir, doc)); status(`Project folder: ${dir.name}. Every step is saved there.`); } catch (err) { status(`Could not start the project: ${err.message}`, true); }
}

function resetDoc() {
  cancelStep();
  project?.detach?.();
  project = null;
  doc = new Doc();
  bindDoc();
  meshes.clear();
  sel = [];
  lastDup = null;
  projectAsked = false;
}

async function newProject() {
  if (!project && doc.history.length && !(await ask('Drop the current parts? They are not saved to a folder.', [['Keep them', false], ['Drop them', true, true]]))) return;
  resetDoc();
  refresh();
  status('New project.');
}

async function openProject() {
  const dir = await chooseFolder();
  if (dir) await openFolder(dir);
}
async function openFolder(dir) {
  if (!(await Project.exists(dir))) { status(`${dir.name} holds no project.`, true); return; }
  resetDoc();
  projectAsked = true;
  try {
    const { project: p, replayed, torn } = await Project.open(dir, doc);
    watch(p);
    sentBlobs.clear();
    await refresh();
    viewer.view('iso');
    status(`Opened ${dir.name}: ${doc.parts.length} parts, ${doc.at} steps${replayed ? `, ${replayed} recovered from the log` : ''}${torn ? ', 1 unfinished step dropped' : ''}.`);
  } catch (err) { status(`Could not open ${dir.name}: ${err.message}`, true); }
}

// ---- import and export ----------------------------------------------------------------------
async function importFiles(files) {
  for (const file of files) {
    status(`Reading ${file.name}...`);
    try {
      const buf = await file.arrayBuffer();
      const r = await pool.call('io', { type: 'load', name: file.name, buf }, [buf]);
      if (!r.report.watertight) { status(`${file.name} is ${describe(r.report)}, so it cannot be joined or cut. Repair it first.`, true); continue; }
      const blob = doc.addBlob(r.tris);
      const b = localBounds(r.tris);
      const id = doc.add({ kind: 'mesh', blob, name: file.name.replace(/\.[^.]+$/, ''),
        xform: { pos: [-(b.lo[0] + b.hi[0]) / 2, -(b.lo[1] + b.hi[1]) / 2, -b.lo[2]], rot: [0, 0, 0], scale: [1, 1, 1] } }, `Import ${file.name}`);
      setSel([id]);
      const f = r.fixes;
      const fixed = [f.welded && `${count(f.welded)} points welded`, f.degenerate && `${f.degenerate} zero-area dropped`, f.duplicates && `${f.duplicates} duplicates dropped`, f.flipped && 'turned right way out'].filter(Boolean);
      status(`Imported ${file.name}${fixed.length ? ' (' + fixed.join(', ') + ')' : ''}.`);
      viewer.view('iso');
    } catch (err) { status(`${file.name}: ${err.message}`, true); }
  }
}

const MIME = { stl: 'model/stl', '3mf': 'model/3mf', obj: 'model/obj' };
async function exportModel() {
  if (!doc.parts.length) { status('Nothing to export.'); return; }
  const name = `${project?.name || 'model'}.${fmt}`;
  let handle = null;
  // ask for the place first, while the click still counts as a click
  try { handle = await window.showSaveFilePicker({ suggestedName: name, id: 'wt3d-export', types: [{ description: fmt.toUpperCase(), accept: { [MIME[fmt]]: ['.' + fmt] } }] }); }
  catch (err) { if (err.name === 'AbortError') { status('Export cancelled.'); return; } }
  status('Joining parts...');
  let bytes;
  try {
    await sendBlobs();
    const { tris } = await pool.call('kern', { type: 'flatten', parts: doc.parts });
    ({ bytes } = await pool.call('io', { type: 'save', tris, fmt }, [tris.buffer]));
  } catch (err) { status(err.message, true); return; }
  if (handle) {
    try {
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      const buf = await (await handle.getFile()).arrayBuffer();
      const r = await pool.call('io', { type: 'check', name: handle.name, buf }, [buf]);
      if (!r.report.watertight) { await handle.remove?.().catch(() => {}); status(`The exported file did not read back as a closed solid (${r.text}), so it was removed.`, true); return; }
      status(`Exported ${handle.name}: one closed solid, ${count(r.report.triangles)} triangles, read back and checked.`);
    } catch (err) { status(`Could not write the file: ${err.message}`, true); }
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[fmt] }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(`Exported ${name} to downloads: one closed solid, checked before writing.`);
}

// ---- keys -------------------------------------------------------------------------------------
importInput.addEventListener('change', () => { importFiles([...importInput.files]); importInput.value = ''; });
view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('dragging'); });
view.addEventListener('dragleave', () => view.classList.remove('dragging'));
view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('dragging'); importFiles([...e.dataTransfer.files]); });

function zoom(f) {
  const c = viewer.camera, t = viewer.controls.target;
  c.position.sub(t).multiplyScalar(f).add(t);
  viewer.request();
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey, s = e.shiftKey;
  const act = fn => { e.preventDefault(); fn(); };
  if (c && k === 'z' && s) return act(redo);
  if (c && k === 'z') return act(undo);
  if (c && k === 'y') return act(redo);
  if (c && k === 'a') return act(() => setSel(doc.parts.filter(p => !p.hidden).map(p => p.id)));
  if (c && k === 'g' && s) return act(ungroupSel);
  if (c && k === 'g') return act(() => groupSel());
  if (c && k === 'i') return act(() => groupSel('intersect'));
  if (c && k === 'b') return act(() => status('Bundle (group without joining) is not built yet.'));
  if (c && k === 'h' && s) return act(showAll);
  if (c && k === 'h') return act(hideSel);
  if (c && k === 'l') return act(toggleLock);
  if (c && k === 'd') return act(duplicateSel);
  if (c && k === 'c') return act(copySel);
  if (c && k === 'x') return act(() => { copySel(); deleteSel(); });
  if (c && k === 'v') return act(paste);
  if (c && k === 'e') return act(exportModel);
  if (c && k === 'o') return act(openProject);
  if (c && (k === 'arrowup' || k === 'arrowdown')) return act(() => nudge(0, 0, (k === 'arrowup' ? 1 : -1) * (s ? 10 : GRID)));
  if (c) return;
  if (k.startsWith('arrow')) return act(() => {
    // follow the view: the part moves the way the arrow points on screen
    const b = viewer.bounds(sel);
    const ax = viewer.screenAxes(b ? b.getCenter(b.min.clone()) : null);
    const dir = { arrowright: ax.right, arrowleft: ax.right.map(v => -v), arrowup: ax.up, arrowdown: ax.up.map(v => -v) }[k];
    const d = s ? 10 : GRID;
    nudge(dir[0] * d, dir[1] * d, 0);
  });
  if (k === 'delete' || k === 'backspace') return act(deleteSel);
  if (k === 'escape') return act(() => { if (step) cancelStep(); else setSel([]); });
  if (k === 'f') return act(() => viewer.view(null, sel));
  if (k === 'h') return act(() => setHole(true));
  if (k === 's') return act(() => setHole(false));
  if (k === 'd') return act(dropToPlate);
  if (k === 'm') return act(() => mirrorSel(s ? 1 : e.altKey ? 2 : 0));
  if (k === '+' || k === '=') return act(() => zoom(0.8));
  if (k === '-' || k === '_') return act(() => zoom(1.25));
  if (k === 'w' || k === 'r' || k === 'n' || k === 'e' || k === 'l' || k === 'c') {
    const what = { w: 'Workplane', r: 'Ruler', n: 'Notes', e: 'Shape workplane', l: 'Align', c: 'Cruise' }[k];
    return act(() => status(`${what} is not built yet.`));
  }
});

window.addEventListener('beforeunload', e => { if (project?.pending) { e.preventDefault(); } });

refresh();
viewer.view('iso');
