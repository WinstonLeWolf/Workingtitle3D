import { gridPicker } from '../hollower/index.js';
// repair panel: close a mesh. As an imported mesh's first step it works on the file as read
// (changing it later re-reads the file); after other steps it works on the part as it is.
export default {
  id: 'repair',
  title: 'Repair',
  blurb: 'Close a mesh: weld gaps, fill holes, or rebuild it as one solid.',
  suffix: 'repaired',
  live: false,
  defaults: { gap: 0.01, maxHole: 0, solid: false, voxel: 0.5, tidy: true },
  stepLabel: p => p.solid ? `Repair: make solid, ${p.voxel} mm grid` : `Repair: gaps ${p.gap} mm${p.maxHole ? `, holes to ${p.maxHole} mm` : ''}`,

  validate(p) {
    if (!(p.gap >= 0)) return 'Gap close cannot be negative.';
    if (!(p.maxHole >= 0)) return 'Largest hole cannot be negative.';
    if (p.solid && !(p.voxel > 0)) return 'The grid must be above zero.';
    return null;
  },

  panel(el, api) {
    const { ui, params: p } = api;
    const solidBox = ui.h('div');
    const fixBox = ui.h('div');
    const show = () => {
      solidBox.style.display = p.solid ? '' : 'none';
      fixBox.style.display = p.solid ? 'none' : '';
    };
    fixBox.append(
      ui.tip(ui.numfield('Gap close', p.gap, 'mm', v => api.set('gap', v), { min: 0, step: 0.01, digits: 3 }), 'Points closer than this are joined, and a point this close to an edge is sewn into it.'),
      ui.tip(ui.numfield('Largest hole', p.maxHole, 'mm', v => api.set('maxHole', v), { min: 0, step: 1, digits: 1 }), 'Rim length of the biggest hole to fill. 0 fills every hole.'),
    );
    solidBox.append(
      ...gridPicker(ui, p.voxel, v => api.set('voxel', v)),
      ui.check('Tidy flat areas after', p.tidy, v => api.set('tidy', v)),
    );
    el.append(ui.tip(ui.check('Make solid', p.solid, v => { p.solid = v; show(); api.set('solid', v); }), 'Rebuilds the surface on a grid. Closes anything; detail finer than the grid is rounded.'), fixBox, solidBox);
    show();
  },
};
