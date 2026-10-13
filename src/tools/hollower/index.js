// hollower panel: hollow a closed model to a set wall, optionally open through one face.
import { problem } from './limits.js';

// presets plus a box for any value; each follows the other
export function gridPicker(ui, value, set) {
  const presets = ['1', '0.5', '0.25', '0.1'];
  let seg, box;
  seg = ui.seg(presets.map(v => [v, v + ' mm']), presets.includes(String(value)) ? String(value) : '', v => { box.set(+v); set(+v); });
  box = ui.numfield('Resolution', value, 'mm', v => { seg.set?.(presets.includes(String(v)) ? String(v) : ''); set(v); }, { min: 0.001, step: 0.05, digits: 3, lazy: true });
  return [box, seg];
}

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
      ui.numfield('Wall thickness', p.wall, 'mm', v => api.set('wall', v), { min: 0.001, step: 0.2, digits: 3 }),
      ...gridPicker(ui, p.voxel, v => api.set('voxel', v)),
      ui.check('Open through a face', p.open, v => { p.open = v; update(); api.set('open', v); }),
      faceLine,
    );
    update();
    return { update };
  },
};
