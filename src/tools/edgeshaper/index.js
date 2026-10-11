// edgeshaper panel: fillet, chamfer or cove round the top, bottom or both faces of a flat part.
import { section, problem } from './profile.js';

const thick = model => (model ? model.bounds.hi[2] - model.bounds.lo[2] : 0);

export default {
  id: 'edgeshaper',
  title: 'Edge shaper',
  blurb: 'Fillet, chamfer or cove round the edge of a flat part (an outline pushed straight up).',
  suffix: 'shaped',
  live: true,
  stepLabel: p => `${p.kind[0].toUpperCase() + p.kind.slice(1)} ${p.face} ${p.width} x ${p.height} mm${p.edges === 'only' ? ', picked edges' : p.edges === 'except' ? ', all but picked' : ''}`,
  defaults: { kind: 'fillet', face: 'top', width: 2, height: 2, start: null, edges: 'all' },
  // the app sends clicks on the part here as wall picks while this is true
  pickWalls: p => p.edges === 'only' || p.edges === 'except',

  validate(p, { model, selection }) {
    const bad = problem(p, thick(model));
    if (bad) return bad;
    if ((p.edges === 'only' || p.edges === 'except') && !selection?.segs?.length) {
      return { wait: p.edges === 'only' ? 'Click the side walls whose edges to shape.' : 'Click the side walls to leave alone.' };
    }
    return null;
  },

  panel(el, api) {
    const { ui, params: p } = api;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'section');
    const draw = () => {
      const m = api.model();
      const t = thick(m);
      svg.replaceChildren();
      if (!m || problem(p, t)) return;
      const pts = section(p, t);
      const W = svg.clientWidth || 260, H = 110, pad = 12;
      const maxD = Math.max(...pts.map(q => q[0]));
      const k = Math.min((W - 2 * pad) / maxD, (H - 2 * pad) / t);
      const x = d => pad + d * k, y = z => H - pad - z * k;
      const ns = 'http://www.w3.org/2000/svg';
      const poly = document.createElementNS(ns, 'polygon');
      poly.setAttribute('points', pts.map(([d, z]) => `${x(d).toFixed(1)},${y(z).toFixed(1)}`).join(' '));
      poly.setAttribute('fill', '#2d5a2d');
      poly.setAttribute('stroke', '#7dcf7d');
      poly.setAttribute('stroke-width', '1.5');
      poly.setAttribute('stroke-linejoin', 'round');
      svg.append(poly);
      caption.textContent = `Section at the edge, part ${t.toFixed(2)} mm thick.`;
    };
    const caption = ui.h('div', { class: 'note' });
    const pickNote = ui.h('div', { class: 'note' });
    const picks = () => {
      const n = api.selection()?.walls || 0;
      pickNote.textContent = p.edges === 'all' || !p.edges ? '' : `${n} wall${n === 1 ? '' : 's'} picked. Click side walls on the part to pick or drop them; a round side is one wall.`;
    };
    const set = (k, v) => { api.set(k, v); draw(); };
    el.append(
      ui.seg([['fillet', 'Fillet'], ['chamfer', 'Chamfer'], ['cove', 'Cove']], p.kind, v => set('kind', v)),
      ui.h('div', { class: 'sub' }, 'Face'),
      ui.seg([['top', 'Top'], ['bottom', 'Bottom'], ['both', 'Both']], p.face, v => set('face', v)),
      ui.h('div', { class: 'sub' }, 'Edges'),
      ui.seg([['all', 'All'], ['only', 'Picked'], ['except', 'All but picked']], p.edges || 'all', v => { if (v === 'all') api.clearSelection(); set('edges', v); picks(); }),
      pickNote,
      ui.numfield('Width into the face', p.width, 'mm', v => set('width', v), { min: 0.01, max: 1000, step: 0.5 }),
      ui.numfield('Height down the side', p.height, 'mm', v => set('height', v), { min: 0.01, max: 1000, step: 0.5 }),
      ui.numfield('Start height', p.start, 'mm', v => set('start', v), { min: 0, max: 1000, step: 0.5, empty: 'auto' }),
      ui.h('div', { class: 'note' }, 'Start height: where the cut meets the side wall, above the opposite face. Auto = flush with the treated face.'),
      svg,
      caption,
    );
    requestAnimationFrame(draw);
    picks();
    return { update: () => { draw(); picks(); } };
  },
};
