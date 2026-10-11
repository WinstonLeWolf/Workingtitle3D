// Builds dist/Workingtitle3D.html: one self-contained file, double-click to run, offline.
// The worker is bundled first and handed to the main bundle as a string.
// Every folder in src/tools/ is a plugin: index.js (panel, main thread) and
// compute.js (worker). Both lists are generated, so a new tool is a new folder.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = path.join(root, 'src');
const out = path.join(root, 'dist', 'Workingtitle3D.html');
const watch = process.argv.includes('--watch');

function toolIds() {
  const dir = path.join(src, 'tools');
  return fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'index.js'))).sort();
}

function virtuals(workerSource) {
  return {
    name: 'virtuals',
    setup(b) {
      b.onResolve({ filter: /^virtual:/ }, a => ({ path: a.path, namespace: 'virtual' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, a => {
        const ids = toolIds();
        const rel = f => JSON.stringify(path.join(src, 'tools', f).replace(/\\/g, '/'));
        if (a.path === 'virtual:tools-ui') {
          return { contents: ids.map((id, i) => `import t${i} from ${rel(id + '/index.js')};`).join('\n')
            + `\nexport default [${ids.map((_, i) => 't' + i).join(',')}];`, resolveDir: src };
        }
        if (a.path === 'virtual:tools-compute') {
          return { contents: ids.map((id, i) => `import * as t${i} from ${rel(id + '/compute.js')};`).join('\n')
            + `\nexport default {${ids.map((id, i) => JSON.stringify(id) + ':t' + i).join(',')}};`, resolveDir: src };
        }
        if (a.path === 'virtual:worker-src') {
          return { contents: `export default ${JSON.stringify(workerSource)};`, resolveDir: src };
        }
      });
    },
  };
}

// the boolean library's engine is embedded as bytes; its Node-only branches are never taken here
const common = { bundle: true, format: 'iife', target: 'es2022', minify: !watch, legalComments: 'none', write: false, logLevel: 'silent',
  loader: { '.wasm': 'binary' }, external: ['node:*', 'module'], define: { 'import.meta.url': '"file:///app/"' } };

async function build() {
  const t0 = Date.now();
  const w = await esbuild.build({ ...common, entryPoints: [path.join(src, 'core', 'worker.js')], plugins: [virtuals('')] });
  const workerSource = w.outputFiles[0].text;
  const m = await esbuild.build({ ...common, entryPoints: [path.join(src, 'core', 'main.js')], plugins: [virtuals(workerSource)] });
  const js = m.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(src, 'core', 'theme.css'), 'utf8');
  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
    .replace('/*CSS*/', () => css)
    .replace('/*JS*/', () => js);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`dist/Workingtitle3D.html  ${(html.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms  tools: ${toolIds().join(', ')}`);
}

try {
  await build();
} catch (e) {
  console.error(e.errors ? e.errors.map(x => `${x.location?.file}:${x.location?.line} ${x.text}`).join('\n') : e);
  if (!watch) process.exit(1);
}
if (watch) {
  let timer = null;
  fs.watch(src, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch(e => console.error(e.message)), 100);
  });
  console.log('watching src/');
}
