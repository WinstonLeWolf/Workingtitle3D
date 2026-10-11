// The shell: shapes, parts, inspector, view, project folder, keys.
// Parts are recipes in the Doc; meshes come from the worker; tools are steps in a recipe.
import workerSrc from 'virtual:worker-src';
import tools from 'virtual:tools-ui';
import { Viewer } from './viewer.js';
import * as ui from './ui.js';
import { Vector3, Box3 } from 'three';
import { Doc, shapeKey, IDENT, matrix } from './doc.js';
import { Project } from './project.js';
import * as folders from './folders.js';
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
const MOVE_STEPS = [0.1, 0.2, 0.3, 0.4, 0.5, 1, 5];
let moveStep = 1;   // mm per arrow press, drag snap and size handle; picked bottom left of the view
let plate = { w: 200, d: 200, every: 10 };   // the grid, for this session
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
const projLabel = h('button', { type: 'button', class: 'file', onclick: () => renameProject() });
const projBtn = button('Save as project', () => pickProjectFolder(), { small: true });
const reopenBtn = button('Reopen', () => reopenLast(), { small: true, title: 'Reopen the last project' });
reopenBtn.style.display = 'none';
const btnUndo = button('Undo', () => undo(), { title: 'Ctrl+Z' });
const btnRedo = button('Redo', () => redo(), { title: 'Ctrl+Y' });
// grid: width, depth and line spacing, in a small panel under its button
const gridPop = h('div', { class: 'card pop', style: 'display:none' });
function showGridPop(on) {
  gridPop.style.display = on ? '' : 'none';
  if (!on) return;
  const set = (k, v) => { plate = { ...plate, [k]: v }; viewer.setPlate(plate); status(`Grid ${+plate.w.toFixed(2)} x ${+plate.d.toFixed(2)} mm, a line every ${+plate.every.toFixed(2)} mm.`); };
  gridPop.replaceChildren(h('h3', {}, 'Grid'),
    ui.numfield('Width', plate.w, 'mm', v => set('w', v), { min: 10, max: 5000, step: 10, lazy: true, digits: 1 }),
    ui.numfield('Depth', plate.d, 'mm', v => set('d', v), { min: 10, max: 5000, step: 10, lazy: true, digits: 1 }),
    ui.numfield('Line every', plate.every, 'mm', v => set('every', v), { min: 0.5, max: 500, step: 1, lazy: true, digits: 1 }),
    h('div', { class: 'note' }, 'Kept for this session.'),
    h('div', { class: 'row' }, button('Done', () => showGridPop(false), { small: true })));
}
const header = h('header', {},
  button('New', () => newProject(), { title: 'Start an empty project' }),
  button('Open', () => openProject(), { title: 'Open a project folder' }),
  button('Import', () => importInput.click(), { title: 'Add an STL, 3MF or OBJ as a part (Ctrl+I is intersect)' }),
  seg([['stl', 'STL'], ['3mf', '3MF'], ['obj', 'OBJ']], fmt, v => { fmt = v; }),
  button('Export', () => exportModel(), { title: 'Join every solid part into one closed solid, into exports/ (Ctrl+E)' }),
  button('Export as...', () => exportModel(true), { title: 'Export to a place you pick (Ctrl+Shift+E)' }),
  btnUndo, btnRedo,
  h('span', { class: 'popwrap' }, button('Grid', () => showGridPop(gridPop.style.display === 'none'), { title: 'Grid size and line spacing' }), gridPop),
  h('span', { class: 'spacer' }), projLabel, reopenBtn, projBtn, importInput);

const shapeGrid = h('div', { class: 'shapes' }, ...Object.keys(SHAPES).map(k => {
  const b = button(k[0].toUpperCase() + k.slice(1), () => addShape(k), { title: `Add a ${k} on the plate` });
  return b;
}));
const partList = h('div', { class: 'parts' });
const stepCard = h('div');
const inspector = h('div', { class: 'inspector', style: 'display:none' });
// one panel on the right, full height, tabs at the very top, each tab scrolls:
// Parts (the parts list, then the tool step and the selected part's options) and New parts (shapes)
const panes = { parts: h('div', { class: 'pane' }, card('Parts', partList), stepCard, inspector),
  shapes: h('div', { class: 'pane', style: 'display:none' }, card('Shapes', shapeGrid)) };
const tabs = seg([['parts', 'Parts'], ['shapes', 'New parts']], 'parts', v => showTab(v));
tabs.classList.add('tabs');
function showTab(v) { tabs.set(v); for (const [k, el] of Object.entries(panes)) el.style.display = k === v ? '' : 'none'; }
const aside = h('aside', {}, tabs, panes.parts, panes.shapes);

const view = h('div', { id: 'view' });
const dropHint = h('div', { class: 'drop' }, h('b', {}, 'Add a shape, or drop an STL, 3MF or OBJ here'), 'Right drag orbits, middle drag pans, wheel zooms. Nothing leaves this computer.');
let cutAxis = null, cutAt = 50;
const cutRange = ui.slider('at', cutAt, '%', { min: 0, max: 100, step: 0.5, digits: 1 }, v => { cutAt = v; if (cutAxis) viewer.setClip(cutAxis, v / 100); });
cutRange.classList.add('cut');
const cutSeg = seg([['off', 'Off'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']], 'off', v => { cutAxis = v === 'off' ? null : v; viewer.setClip(cutAxis, cutAt / 100); });
const views = h('div', { class: 'overlay tl' },
  ...[['iso', 'Fit (F)'], ['top', 'Top'], ['front', 'Front'], ['right', 'Right']].map(([k, l]) => button(l, () => viewer.view(k, k === 'iso' ? sel : []), { small: true })));
cutSeg.title = 'Cut the view open along X, Y or Z';
const cut = h('div', { class: 'overlay cutbar' }, cutSeg, cutRange);
const pastBanner = h('div', { class: 'banner', style: 'display:none' });
// move step: one column of buttons, bottom left
const moveBtns = MOVE_STEPS.map(v => h('button', { type: 'button', class: 'movestep' + (v === moveStep ? ' on' : ''),
  title: `Move in ${v} mm steps (arrows, drag)`, onclick: () => setMoveStep(v) }, v.toFixed(1)));
const moveCol = h('div', { class: 'overlay bl' }, h('span', { class: 'lbl' }, 'mm'), ...moveBtns);
function setMoveStep(v) {
  moveStep = v;
  moveBtns.forEach((b, i) => b.classList.toggle('on', MOVE_STEPS[i] === v));
  status(`Moves go in ${v} mm steps. Shift + arrow: ${+(v * 10).toFixed(2)} mm.`);
  renderInspector();
}
// status: one thin line along the bottom of the view, no bar
const statusMsg = h('span', { class: 'msg' }, 'Ready.');
view.append(header, dropHint, views, cut, moveCol, pastBanner, h('footer', {}, statusMsg));
app.append(view, aside);

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
  endPast(false);   // any change to the model ends the history view
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
  endPast(false);
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
  // history of this part: drag through it to watch it being made; Keep rolls it back
  const tl = doc.timeline(p.id);
  if (tl.length > 1) {
    const n = tl.length, at = past?.id === p.id ? past.k : n;
    const label = h('div', { class: 'note' });
    const keep = button('Keep this', () => keepPast(), { small: true, title: 'Roll this part back to the step shown' });
    const back = button('Back to now', () => endPast(), { small: true });
    pastUi = { label, keep, back, n, tl, id: p.id };
    body.push(h('div', { class: 'sub' }, 'History'),
      ui.slider(`Step (of ${n})`, at, '', { min: 1, max: n, step: 1 }, k => scrubTo(k)),
      label, h('div', { class: 'row' }, back, keep));
    pastLabel(at);
  } else pastUi = null;
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
      v => upd(`Move ${p.name}`, q => { q.xform.pos[i] = +(q.xform.pos[i] + v - at[i]).toFixed(6); }), { step: moveStep, lazy: true, digits: 3 })));
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
  if (m) {
    const b = wb;
    body.push(kv([['size', b ? `${mm(b.max.x - b.min.x)} x ${mm(b.max.y - b.min.y)} x ${mm(b.max.z - b.min.z)}` : '-'], ['volume', `${(m.volume / 1000).toFixed(2)} cm3`], ['triangles', count(m.tris.length / 9)]]));
  }
  if (lock) body.push(h('div', { class: 'note' }, 'Locked: Ctrl+L to unlock.'));
  inspector.replaceChildren(card(p.kind === 'group' ? `Group${p.mode === 'intersect' ? ' (intersect)' : ''}` : p.kind, ...body));
}

// ---- history view ---------------------------------------------------------------------------
let past = null;     // {id, k, t, shown} while looking at an earlier step
let pastUi = null;
let pastSeq = 0;
function pastLabel(k) {
  if (!pastUi) return;
  const { n, tl, label, keep, back } = pastUi;
  label.textContent = k >= n ? 'Now.' : `After step ${tl[k - 1]}: ${doc.history[tl[k - 1] - 1].label}`;
  back.disabled = k >= n;
  keep.disabled = k >= n || !past?.ownState;
  if (k < n && past && !past.ownState) label.textContent += '  (before this part existed as one piece: Ctrl+Z goes back that far)';
  pastBanner.style.display = k < n ? '' : 'none';
  pastBanner.textContent = `HISTORY  -  step ${k} of ${n}. Esc returns to now.`;
}
async function scrubTo(k) {
  if (!pastUi) return;
  const { n, tl, id } = pastUi;
  k = Math.max(1, Math.min(n, Math.round(k)));
  if (k >= n) { endPast(false); pastLabel(n); return; }   // no redraw: the slider is still being dragged
  const t = tl[k - 1], my = ++pastSeq;
  const ids = new Set(doc.idsIn(doc.top(id)));
  const shown = doc.partsAt(t).filter(q => !q.hidden && doc.idsIn(q).some(x => ids.has(x)));
  past = { id, k, t, ownState: shown.find(q => q.id === id) || null };
  pastLabel(k);
  try {
    await sendBlobs();
    const items = [];
    for (const q of shown) {
      const r = await pool.call('kern', { type: 'mesh', part: q });
      items.push({ tris: r.tris, xform: q.xform, color: q.color, hole: q.hole });
    }
    if (my === pastSeq && past) viewer.showPast(items);
  } catch (err) { status(err.message, true); }
}
function endPast(redraw = true) {
  if (!past && !viewer.past) return;
  past = null;
  pastSeq++;
  pastBanner.style.display = 'none';
  viewer.showPast(null);
  if (redraw) renderInspector();
}
function keepPast() {
  if (!past?.ownState) return;
  const { id, k } = past, name = doc.top(id)?.name;
  const state = past.ownState;
  endPast();
  doc.setPart(id, state, `Roll ${name} back to history step ${k}`);
  status(`${name} rolled back to step ${k}. Ctrl+Z undoes that.`);
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
  const snap = e.shiftKey ? 0.1 : moveStep;
  drag.d = [+(Math.round(dx / snap) * snap).toFixed(6), +(Math.round(dy / snap) * snap).toFixed(6)];
  for (const id of drag.ids) {
    const p = doc.top(id), s = drag.start.get(id);
    viewer.setXform(id, { ...p.xform, pos: [s[0] + drag.d[0], s[1] + drag.d[1], s[2]] });
  }
  status(`Move ${mm(drag.d[0])}, ${mm(drag.d[1])} mm${e.shiftKey || moveStep <= 0.1 ? '' : '  (Shift: 0.1 mm steps)'}`);
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
  showTab('parts');
  stepCard.scrollIntoView({ block: 'nearest' });
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
    projLabel.title = 'Click to rename the project';
    projBtn.style.display = 'none';
    if (project.error) { projLabel.textContent = ''; status(`Could not write to the project folder: ${project.error.message}`, true); }
  } else {
    projLabel.textContent = doc.history.length ? 'not saved to disk' : '';
    projLabel.title = 'Click to save as a named project';
    projBtn.style.display = doc.history.length ? '' : 'none';
  }
}

function watch(p) {
  project = p;
  p.onstate = () => updateHeader();
  updateHeader();
}

// ---- the home folder: projects/<name>/ inside it ----------------------------------------
let home = null;

async function noFolderAccess() {
  if (typeof window.showDirectoryPicker === 'function') return false;
  status('This browser has folder access switched off, so projects cannot be saved. In Brave: brave://flags/#file-system-access-api, Enabled, restart.', true);
  await ask(h('div', {}, h('p', {}, 'This browser has folder access switched off, so the project cannot be saved to a folder.'),
    h('p', {}, 'In Brave: put brave://flags/#file-system-access-api in the address bar, set it to Enabled, and restart Brave.'),
    h('p', {}, 'Edge, Vivaldi and Chromium have it on already. Export still works meanwhile.')));
  return true;
}

/** The home folder, ready to write. Call from a click: it may need to ask. */
async function ensureHome() {
  if (home) return home;
  if (await noFolderAccess()) return false;
  const saved = await folders.savedHome();
  try {
    if (saved.home && saved.state === 'granted') return (home = saved.home);
    if (saved.home) {
      // the browser wants a click before it gives the folder back
      const go = await ask(`Allow the projects folder (${saved.home.name}) again?`, [['Cancel', false], ['Allow', true, true]]);
      if (!go) return null;
      if (await folders.allow(saved.home)) return (home = saved.home);
    }
    const go = await ask(h('div', {}, h('p', {}, 'Pick the folder this app lives in (the Workingtitle3D folder).'),
      h('p', {}, 'Projects are kept in a projects folder inside it. This is asked once; after that the app remembers it.')),
      [['Cancel', false], ['Pick folder', true, true]]);
    if (!go) return null;
    home = await folders.pickHome();
    return home;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    status(`Could not use that folder: ${err.message}`, true);
    return false;   // an error, already shown
  }
}

/** In-page dialog asking for a project name. */
function askName(message, def) {
  return new Promise(res => {
    const input = h('input', { type: 'text', class: 'name-in', value: def, spellcheck: 'false' });
    const d = h('dialog', {}, h('div', {}, message), h('div', { class: 'row' }, input));
    const done = v => { d.close(); d.remove(); res(v); };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(folders.cleanName(input.value) || null); if (e.key === 'Escape') done(null); });
    d.append(h('div', { class: 'row' }, button('Cancel', () => done(null)), button('Save', () => done(folders.cleanName(input.value) || null), { go: true })));
    d.addEventListener('cancel', () => done(null));
    document.body.append(d);
    d.showModal();
    input.select();
  });
}

async function nextUntitled() {
  const names = home ? await folders.listProjects(home) : [];
  let n = 1;
  while (names.includes(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

async function askForFolder() { await saveToProjects(); }

/** Save the current parts as a new named project under projects/. */
async function saveToProjects() {
  const got = await ensureHome();
  if (!got) { if (got === null) status('Not saved to disk yet. "Save as project" (top right) when ready.'); return; }
  const taken = await folders.listProjects(home);
  let name = await askName('Name this project. Every step is saved in projects/ as you work.', await nextUntitled());
  while (name && taken.includes(name)) name = await askName(`"${name}" already exists. Pick another name.`, name + ' 2');
  if (!name) { status('Not saved to disk yet. "Save as project" (top right) when ready.'); return; }
  try {
    const dir = await folders.projectFolder(home, name, true);
    watch(await Project.create(dir, doc));
    await folders.remember('last', name);
    status(`Saving to projects/${name}. Every step is written there.`);
  } catch (err) { status(`Could not start the project: ${err.message}`, true); }
}
const pickProjectFolder = saveToProjects;

/** Rename the project: its folder under projects/ is copied to the new name, then the old one removed. */
async function renameProject() {
  if (!project) return saveToProjects();
  const pdir = home && await folders.projectsDir(home);
  const inside = pdir && (await pdir.resolve(project.dir).catch(() => null))?.length === 1;
  if (!inside) { status(`${project.name} is not in projects/, so rename its folder outside the app.`); return; }
  const old = project.name, taken = await folders.listProjects(home);
  let name = await askName('New name for this project.', old);
  while (name && name !== old && taken.includes(name)) name = await askName(`"${name}" already exists. Pick another name.`, name + ' 2');
  if (!name || name === old) return;
  try {
    await project.moveTo(await folders.projectFolder(home, name, true));
  } catch (err) {
    await pdir.removeEntry(name, { recursive: true }).catch(() => {});   // the half-made copy; the project stays where it was
    status(`Could not rename the project: ${err.message}`, true);
    return;
  }
  await pdir.removeEntry(old, { recursive: true }).catch(() => {});
  await folders.remember('last', name);
  updateHeader();
  status(`Project renamed: ${old} is now ${name}.`);
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

/** Open: the list of projects, or another folder. */
async function openProject() {
  if (!(await ensureHome())) return;
  const names = await folders.listProjects(home);
  const pick = await new Promise(res => {
    const d = h('dialog', {});
    const done = v => { d.close(); d.remove(); res(v); };
    const list = h('div', { class: 'projlist' }, ...names.map(n => button(n, () => done(n))));
    if (!names.length) list.append(h('p', {}, 'No projects yet.'));
    d.append(h('div', {}, 'Open a project'), list, h('div', { class: 'row' }, button('Other folder...', () => done({ other: true })), button('Cancel', () => done(null))));
    d.addEventListener('cancel', () => done(null));
    document.body.append(d);
    d.showModal();
  });
  if (!pick) return;
  if (pick.other) {
    try { await openFolder(await window.showDirectoryPicker({ mode: 'readwrite', id: 'wt3d-other' })); } catch (err) { if (err.name !== 'AbortError') status(err.message, true); }
    return;
  }
  await openFolder(await folders.projectFolder(home, pick));
  await folders.remember('last', pick);
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
/** A name not yet used in this folder: name.stl, name-1.stl, name-2.stl ... */
async function freeName(dir, base, ext) {
  const exists = async n => { try { await dir.getFileHandle(n); return true; } catch { return false; } };
  if (!(await exists(`${base}.${ext}`))) return `${base}.${ext}`;
  for (let i = 1; ; i++) if (!(await exists(`${base}-${i}.${ext}`))) return `${base}-${i}.${ext}`;
}

/** Export: straight into exports/ next to projects/, never overwriting (no dialog).
 *  pick = true (Export as...) asks where instead. */
async function exportModel(pick = false) {
  if (!doc.parts.length) { status('Nothing to export.'); return; }
  const base = folders.cleanName(project?.name || 'model') || 'model';
  const name = `${base}.${fmt}`;
  let handle = null;
  if (!pick && home) {
    try {
      const dir = await home.getDirectoryHandle('exports', { create: true });
      handle = await dir.getFileHandle(await freeName(dir, base, fmt), { create: true });
    } catch (err) { status(`Could not use the exports folder: ${err.message}`, true); return; }
  } else {
    // ask for the place first, while the click still counts as a click
    try { handle = await window.showSaveFilePicker({ suggestedName: name, id: 'wt3d-export', types: [{ description: fmt.toUpperCase(), accept: { [MIME[fmt]]: ['.' + fmt] } }] }); }
    catch (err) { if (err.name === 'AbortError') { status('Export cancelled.'); return; } }
  }
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
      status(`Exported ${home && !pick ? 'exports/' : ''}${handle.name}: one closed solid, ${count(r.report.triangles)} triangles, read back and checked.`);
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
  if (c && k === 'e') return act(() => exportModel(s));
  if (c && k === 'o') return act(openProject);
  if (c && (k === 'arrowup' || k === 'arrowdown')) return act(() => nudge(0, 0, (k === 'arrowup' ? 1 : -1) * moveStep * (s ? 10 : 1)));
  if (c) return;
  if (k.startsWith('arrow')) return act(() => {
    // follow the view: the part moves the way the arrow points on screen
    const b = viewer.bounds(sel);
    const ax = viewer.screenAxes(b ? b.getCenter(b.min.clone()) : null);
    const dir = { arrowright: ax.right, arrowleft: ax.right.map(v => -v), arrowup: ax.up, arrowdown: ax.up.map(v => -v) }[k];
    const d = moveStep * (s ? 10 : 1);
    nudge(dir[0] * d, dir[1] * d, 0);
  });
  if (k === 'delete' || k === 'backspace') return act(deleteSel);
  if (k === 'escape') return act(() => { if (gridPop.style.display !== 'none') showGridPop(false); else if (step) cancelStep(); else if (past) endPast(); else setSel([]); });
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

// reopen the last project: straight away if the browser still allows the home folder,
// else one click on Reopen (a page may only ask for access from a click)
async function reopenLast() {
  const saved = await folders.savedHome(), last = await folders.recall('last');
  if (!saved.home || !last) return;
  if (saved.state !== 'granted' && !(await folders.allow(saved.home).catch(() => false))) { status('The browser did not allow the projects folder.', true); return; }
  home = saved.home;
  reopenBtn.style.display = 'none';
  try { await openFolder(await folders.projectFolder(home, last)); } catch { status(`The last project, ${last}, is gone from projects/.`, true); }
}
(async () => {
  const saved = await folders.savedHome().catch(() => ({})), last = await folders.recall('last');
  if (!saved?.home || !last) return;
  if (saved.state === 'granted') reopenLast();
  else { reopenBtn.textContent = `Reopen ${last}`; reopenBtn.style.display = ''; }
})();
