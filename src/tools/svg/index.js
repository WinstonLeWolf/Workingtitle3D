import { parseSvgPolygons } from '../../core/svg.js';

export default {
  id: 'svg',
  title: 'SVG',
  blurb: 'Extrude an SVG profile into a 3D solid.',
  suffix: 'svg',
  live: true,
  stepLabel: p => `SVG ${p.height} mm`,
  defaults: { height: 10, polygons: [] },
  validate(p) {
    if (!p.polygons || !p.polygons.length) {
      return { wait: 'Click "Import SVG..." to choose an SVG file.' };
    }
    return null;
  },
  panel(el, api) {
    const { ui, params: p } = api;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.svg';
    fileInput.style.display = 'none';

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const { polygons, width, depth } = parseSvgPolygons(text);
        api.set('polygons', polygons);
        noteEl.textContent = `${polygons.length} shape${polygons.length === 1 ? '' : 's'} loaded (${width} x ${depth} mm).`;
      } catch (err) {
        noteEl.textContent = `Error: ${err.message}`;
      }
      fileInput.value = '';
    });

    const noteEl = ui.h('div', { class: 'note' }, p.polygons && p.polygons.length ? `${p.polygons.length} shape${p.polygons.length === 1 ? '' : 's'} loaded.` : 'No SVG loaded.');
    const importBtn = ui.button(p.polygons && p.polygons.length ? 'Replace SVG...' : 'Import SVG...', () => fileInput.click());

    el.append(
      importBtn,
      fileInput,
      ui.numfield('Height', p.height, 'mm', v => api.set('height', v), { min: 0.1, step: 1 }),
      noteEl
    );

    return {
      update() {
        noteEl.textContent = p.polygons && p.polygons.length ? `${p.polygons.length} shape${p.polygons.length === 1 ? '' : 's'} loaded.` : 'No SVG loaded.';
      }
    };
  }
};
