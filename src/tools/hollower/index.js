// hollower panel: hollow a closed model to a set wall, optionally open through one face.
import { problem } from './limits.js';

export default {
  id: 'hollower',
  title: 'Hollow',
  blurb: 'Hollow a closed model to a set wall. Optionally open it through one flat face.',
  suffix: 'hollow',
  live: false,
  needsFace: true,
  defaults: { wall: 2, voxel: 0.5, open: false },
  stepLabel: p => `Hollow, wall ${p.wall} mm${p.open ? ', open' : ''}`,

  validate(p, { selection }) {
    const bad = problem(p);
    if (bad) return bad;
    if (p.open && !selection) return { wait: 'Click the face to open, in the view.' };
    return null;
  },

  panel(el, api) {
    const { ui, params: p } = api;
    const faceLine = ui.h('div', { class: 'note' });
    const update = () => {
      const s = api.selection();
      faceLine.textContent = !p.open ? 'Closed hollow: the cavity is sealed inside.'
        : s ? `Opens through the picked face (${s.area.toFixed(1)} mm2). Click another face to change it.`
          : 'Click a flat face on the outside of the model.';
    };
    el.append(
      ui.numfield('Wall thickness', p.wall, 'mm', v => api.set('wall', v), { min: 0.1, max: 100, step: 0.2 }),
      ui.h('div', { class: 'sub' }, 'Resolution'),
      ui.seg([['1', '1 mm'], ['0.5', '0.5 mm'], ['0.25', '0.25 mm']], String(p.voxel), v => api.set('voxel', +v)),
      ui.h('div', { class: 'note' }, 'Finer is slower. Inside corners are cut off by up to half of it.'),
      ui.check('Open through a face', p.open, v => { p.open = v; update(); api.set('open', v); }),
      faceLine,
    );
    update();
    return { update };
  },
};
