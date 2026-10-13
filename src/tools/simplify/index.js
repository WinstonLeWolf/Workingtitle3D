// simplify panel: fewer triangles, smaller files. Edge collapse; with Preserve surface no
// point moves further than the limit from the original surface.
import { stlBytes, sizeText } from '../../core/decimate.js';

export default {
  id: 'simplify',
  title: 'Simplify',
  blurb: 'Fewer triangles and a smaller file. Preserve surface keeps the shape within a set distance.',
  suffix: 'simplified',
  live: false,
  defaults: { percent: 50, preserve: true, tol: 0.01 },
  stepLabel: p => `Simplify to ${p.percent}%${p.preserve ? `, within ${p.tol} mm` : ''}`,

  validate(p) {
    if (!(p.percent > 0 && p.percent <= 100)) return 'Keep is above 0 and up to 100 %.';
    if (p.preserve && !(p.tol > 0)) return 'The surface limit must be above 0 mm.';
    return null;
  },

  panel(el, api) {
    const { ui, params: p } = api;
    const est = ui.h('div', { class: 'note' });
    const tolBox = ui.h('div');
    const update = () => {
      const n = api.model()?.triangles || 0;
      const t = Math.max(4, Math.round(n * p.percent / 100));
      est.textContent = n
        ? `${n.toLocaleString('en-US')} to ${t.toLocaleString('en-US')} triangles, STL ${sizeText(stlBytes(n))} to ${sizeText(stlBytes(t))}`
        : '';
      tolBox.style.display = p.preserve ? '' : 'none';
    };
    tolBox.append(
      ui.tip(ui.numfield('Surface limit', p.tol, 'mm', v => { p.tol = v; update(); api.set('tol', v); }, { min: 0.0001, step: 0.01, digits: 4 }), 'No point ends up further than this from the original surface, so nothing is cut into.'),
    );
    el.append(
      ui.slider('Keep', p.percent, '%', { min: 0.1, max: 100, step: 0.1, digits: 1 }, v => { p.percent = v; update(); }, v => api.set('percent', v)),
      est,
      ui.check('Preserve surface', p.preserve, v => { p.preserve = v; update(); api.set('preserve', v); }),
      tolBox,
    );
    update();
    return { update };
  },
};
