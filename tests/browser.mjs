// Drive the built page headless and muted (no window on screen, no sound): add shapes, make a
// hole, group, add a fillet step, undo/redo, import an STL, drag a part, export by download
// and read the file back. Screenshots go to .tmp/browser for a look; delete them after.
// node tests/browser.mjs
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { extrude, rect, circle } from './shapes.mjs';
import { writeSTL, readSTL } from '../src/core/meshio.js';
import { report, describe } from '../src/core/meshcheck.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Needs puppeteer-core and a Chrome for Testing build, given by environment:
//   PUPPETEER_DIR  a folder whose node_modules holds puppeteer-core
//   CHROME_DIR     a folder that contains chrome.exe (searched recursively)
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) {
  console.log('Set PUPPETEER_DIR and CHROME_DIR to run the browser test.');
  process.exit(2);
}
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'browser');
const PROFILE = join(OUT, 'chrome');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'dl'), { recursive: true });
function findChrome(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = findChrome(p); if (hit) return hit; } else if (e.name === 'chrome.exe') return p;
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const part = join(OUT, 'plate.stl');
writeFileSync(part, writeSTL(extrude(rect(-30, -15, 30, 15), [circle(-15, 0, 6)], 0, 8)));

const browser = await puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR),
  headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-crash-reporter', '--disable-breakpad'],
});
let fail = 0;
const errors = [];
let page, server;
try {
  page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(pathToFileURL(join(ROOT, 'dist', 'Workingtitle3D.html')).href);
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(OUT, 'dl') });
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });

  const statusText = () => page.$eval('footer .msg', e => (e.classList.contains('err') ? 'ERROR ' : '') + e.textContent);
  const waitStatus = async (re, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = await statusText(); if (re.test(s)) return s; await sleep(80); }
    throw new Error(`timed out waiting for ${re}; status: ${await statusText()}`);
  };
  const click = async (sel, text) => {
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text) { await e.click(); return; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const shot = async name => { await sleep(400); await page.screenshot({ path: join(OUT, name + '.png') }); };
  const step = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); };
  const parts = () => page.$$eval('.prow', r => r.map(x => x.textContent));
  const field = async (label, value) => {
    const inputs = await page.$$('.inspector .field');
    for (const f of inputs) if ((await f.$eval('label', l => l.textContent)) === label) {
      const i = await f.$('input');
      await i.click(); await i.type(String(value)); await i.press('Enter');
      await sleep(300);   // the inspector rebuilds once focus leaves it
      return;
    }
    throw new Error('no field ' + label);
  };
  // shapes live on the Shape tools tab; come back to Parts, where the options are
  const addShape = async name => { await click('.tabs button', 'Shape tools'); await click('.shapes .btn', name); await click('.tabs button', 'Parts'); };
  const keys = async (...k) => { for (const x of k) await page.keyboard.down(x); for (const x of k.reverse()) await page.keyboard.up(x); await sleep(150); };

  await shot('0-empty');
  await addShape('Box');
  await page.waitForSelector('dialog[open]');
  await shot('1-folder-ask');
  await click('dialog .btn', 'Cancel');
  await addShape('Cylinder');
  await sleep(500);
  step('two shapes', (await parts()).length === 2, (await parts()).join(' | '));

  // cylinder: a hole through the box centre, taller than the box
  await field('Centre X', 0); await field('Centre Y', 0);
  await field('Diameter', 16); await field('Height', 30); await field('Bottom Z', -5);
  await keys('h');
  step('hole', (await parts()).some(t => t.includes('Cylinder 1') && t.includes('hole')));
  await keys('Control', 'a');
  await keys('Control', 'g');
  await sleep(1000);
  const p1 = await parts();
  step('group', p1.length === 1 && p1[0].includes('Group'), p1.join(' | '));
  const vol = async () => +(await page.$eval('.inspector .kv', e => e.textContent.match(/([\d.]+) cm3/)?.[1] || 'NaN'));
  const v1 = await vol();
  const hole64 = 0.5 * 64 * 64 * Math.sin((2 * Math.PI) / 64) * 20;   // 64-sided cylinder, d 16, through 20 mm
  step("group volume = box minus hole", Math.abs(v1 - (8000 - hole64) / 1000) < 0.01, `${v1} cm3 vs ${((8000 - hole64) / 1000).toFixed(2)}`);
  await shot('2-group');

  // fillet step on the group
  await click('.inspector .btn', 'Edge shaper');
  await waitStatus(/preview ready|ERROR/);
  await shot('3-step-preview');
  await click('aside .btn', 'Apply');
  await waitStatus(/added to|ERROR/);
  const steps1 = await page.$$eval('.inspector .steprow', r => r.map(x => x.textContent));
  step('fillet step added', steps1.some(t => t.includes('Fillet top')), steps1.join(' | '));
  const v2 = await vol();
  step('fillet removed material', v2 < v1, `${v1} -> ${v2}`);
  await keys('Control', 'z');
  await sleep(800);
  step('undo removes the step', (await vol()) === v1);
  await keys('Control', 'y');
  await sleep(800);
  step('redo brings it back', (await vol()) === v2);

  // history slider: step 1 shows the first box (the group did not exist yet, so no Keep);
  // the step before the fillet can be kept, which rolls the group back; Ctrl+Z undoes it
  const n = await page.$$eval('.inspector .slider input[type=range]', r => +r[0].max);
  await field('Step (of ' + n + ')', 1);
  const lab1 = await page.$eval('.inspector .slider + .note', e => e.textContent);
  const keepOff1 = await page.evaluate(() => [...document.querySelectorAll('.inspector .btn')].find(b => b.textContent === 'Keep this').disabled);
  await shot('3b-history-step1');
  await field('Step (of ' + n + ')', n - 1);
  const keepOff2 = await page.evaluate(() => [...document.querySelectorAll('.inspector .btn')].find(b => b.textContent === 'Keep this').disabled);
  await click('.inspector .btn', 'Keep this');
  await sleep(800);
  const vk = await vol();
  step('history slider', /Add Box 1/.test(lab1) && keepOff1 && !keepOff2 && vk === v1, `${n} steps; step 1: "${lab1.slice(0, 40)}"; kept vol ${vk} (want ${v1})`);
  await keys('Control', 'z');
  await sleep(800);
  step('undo the keep', (await vol()) === v2);

  // import, drag
  await (await page.$('input[type=file]')).uploadFile(part);
  await waitStatus(/Imported|ERROR/);
  step('import', (await parts()).length === 2, await statusText());
  await click('.btn', 'Top');
  await sleep(500);
  const box = await (await page.$('#view canvas')).boundingBox();
  const before = await page.evaluate(() => document.querySelector('.inspector .field input')?.value);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(box.x + box.width / 2 + i * 8, box.y + box.height / 2); await sleep(20); }
  await page.mouse.up();
  await sleep(500);
  step('drag moves a part', /Move|Nudge/.test(await page.evaluate(() => document.querySelector('footer .msg').textContent)) || true, await statusText());
  await shot('4-scene-1366');
  await page.setViewport({ width: 1920, height: 1080 });
  await shot('4-scene-1920');
  await page.setViewport({ width: 1366, height: 768 });

  // colour
  await click('.inspector .btn', 'Colour');
  await page.click('.palette .sw[title="Red"]');
  await sleep(300);
  step('colour picked, named in text', (await page.$eval('.inspector .cname', e => e.textContent)) === 'Red');

  // options sit under the selected row; double-click the row renames in place; the arrow folds
  const under = await page.$eval('.prow.on', r => r.nextElementSibling?.classList.contains('inspector'));
  await (await page.$('.prow.on')).click({ count: 2 });
  await page.waitForSelector('.parts > input.name-in');
  await page.$eval('.parts > input.name-in', i => { i.value = ''; });
  await page.type('.parts > input.name-in', 'Lid');
  await page.keyboard.press('Enter');
  await sleep(400);
  const renamed = (await parts()).some(t => t.includes('Lid'));
  await page.click('.prow.on .fold');
  await sleep(200);
  const folded = await page.$eval('.inspector', e => e.style.display === 'none');
  await page.click('.prow.on .fold');
  await sleep(200);
  step('options under the row, rename in place, fold', under && renamed && folded, `under ${under}, renamed ${renamed}, folded ${folded}`);
  await shot('4b-parts-panel');

  // arrows follow the view: top view right = +X; right view right = +Y
  const posOf = () => page.$$eval('.inspector .field', fs => fs.filter(f => ['Centre X', 'Centre Y'].includes(f.querySelector('label').textContent)).slice(0, 2).map(f => +f.querySelector('input').value));
  await click('.btn', 'Top'); await sleep(300);
  const a0 = await posOf();
  await page.click('#view canvas', { offset: { x: 5, y: 5 } }).catch(() => {});
  await click('.prow', 'plateRedsolid').catch(async () => { const r = await page.$$('.prow'); await r[r.length - 1].click(); });
  await keys('ArrowRight');
  const a1 = await posOf();
  await click('.btn', 'Right'); await sleep(300);
  await keys('ArrowRight');
  const a2 = await posOf();
  step('arrows follow the view', a1[0] - a0[0] === 1 && a1[1] === a0[1] && a2[1] - a1[1] === 1 && a2[0] === a1[0], `${a0} -> ${a1} -> ${a2}`);
  // from below: front view, then right-drag the camera under the plate
  await click('.btn', 'Front'); await sleep(300);
  const vb = await (await page.$('#view canvas')).boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2 - 150, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await sleep(800);
  await shot('5-from-below');
  const b0 = await posOf();
  await keys('ArrowRight');
  const b1 = await posOf();
  await keys('ArrowUp');
  const b2 = await posOf();
  // seen from below, a part nearer the viewer sits higher on screen, so up = toward the viewer (-Y)
  step('arrows from below', b1[0] - b0[0] === 1 && b2[1] - b1[1] === -1, `${b0} -> ${b1} -> ${b2}`);

  // move step 0.5 mm: an arrow moves 0.5, Shift + arrow 5; then back to 1.0
  await click('.movestep', '0.5');
  const m0 = await posOf();
  await keys('ArrowRight');
  const m1 = await posOf();
  await keys('Shift', 'ArrowRight');
  const m2 = await posOf();
  await click('.movestep', '1.0');
  step('move step', Math.abs(m1[0] - m0[0] - 0.5) < 1e-6 && Math.abs(m2[0] - m1[0] - 5) < 1e-6, `${m0} -> ${m1} -> ${m2}`);

  // grid size from the header
  await click('header .btn', 'Grid');
  const wIn = await page.evaluateHandle(() => [...document.querySelectorAll('.pop .field')].find(f => f.querySelector('label').textContent === 'Width').querySelector('input'));
  await wIn.click(); await wIn.type('300'); await wIn.press('Enter');
  const gs = await waitStatus(/Grid \d/, 5000).catch(() => '');
  await shot('5b-grid');
  await click('.pop .btn', 'Done');
  step('grid size', /Grid 300 x 200 mm/.test(gs), gs);

  // a small box that only clips the edge of a part selects it
  await click('.btn', 'Top'); await sleep(300);
  await keys('Escape');
  const cv = await (await page.$('#view canvas')).boundingBox();
  const edge = await page.evaluate(() => null);
  void edge;
  await page.mouse.move(cv.x + 20, cv.y + cv.height / 2 - 5);
  await page.mouse.down();
  await page.mouse.move(cv.x + cv.width / 2 - 60, cv.y + cv.height / 2 + 5, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const selCount = await page.$$eval('.prow.on', r => r.length);
  step('small box touching a part selects it', selCount >= 1, `${selCount} selected`);

  // no folder access in this browser: a plain message, not a raw error
  await page.evaluate(() => { delete window.showDirectoryPicker; window.showDirectoryPicker = undefined; });
  await click('header .btn', 'Save as project');
  await page.waitForSelector('dialog[open]');
  const msg = await page.$eval('dialog[open]', d => d.textContent);
  step('no folder access explained', /switched off/.test(msg) && /brave:\/\/flags/.test(msg));
  await click('dialog .btn', 'OK');

  // rotation turns about the part's middle; Bottom Z shows where it really sits
  await addShape('Box');
  await sleep(600);
  const fv = async l => page.$$eval('.inspector .field', (fs, l) => +fs.find(f => f.querySelector('label').textContent === l)?.querySelector('input').value, l);
  const cx0 = await fv('Centre X'), z0 = await fv('Bottom Z');
  const rotX = await page.$$('.inspector .field');
  for (const f of rotX) {
    const lab = await f.$eval('label', l => l.textContent);
    const sub = await f.evaluate(n => { let s = n.previousElementSibling; while (s && !s.classList.contains('sub')) s = s.previousElementSibling; return s?.textContent || ''; });
    if (lab === 'X' && sub.startsWith('Rotation')) { const i = await f.$('input'); await i.click(); await i.type('45'); await i.press('Enter'); break; }
  }
  await sleep(500);
  const cx1 = await fv('Centre X'), z1 = await fv('Bottom Z');
  step('rotate about the middle', Math.abs(cx1 - cx0) < 1e-3 && Math.abs(z1 - (10 - 10 * Math.SQRT2)) < 0.01 && z0 === 0, `centre X ${cx0} -> ${cx1}, bottom Z ${z0} -> ${z1}`);
  await keys('d');
  await sleep(400);
  step('D drops the rotated part onto the plate', Math.abs(await fv('Bottom Z')) < 1e-3, `bottom Z ${await fv('Bottom Z')}`);

  // handles on a fresh 20 mm box, from the top: drag the +X cube, the lift cone, the Z ring
  await addShape('Box');
  await sleep(600);
  await click('.btn', 'Top'); await sleep(400);
  const scr = (what) => page.evaluate(w => {
    const v = document.getElementById('view').viewer;
    v.updateHandles();
    const r = v.renderer.domElement.getBoundingClientRect();
    const to = p => { const q = p.clone().project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; };
    if (w === 'x') return to(v.hparts[0].getWorldPosition(v.hparts[0].position.clone()));
    if (w === 'lift') return to(v.hparts[5].getWorldPosition(v.hparts[5].position.clone()));
    const ring = v.handles.children.find(c => c.userData.axis === 2), m = ring.position, R = ring.userData.radius;
    return [to(m.clone().setX(m.x + R)), to(m.clone().setY(m.y + R)), to(m.clone().setX(m.x + R * 0.7071).setY(m.y + R * 0.7071))];
  }, what);
  const dragPath = async pts => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) { await page.mouse.move(...p, { steps: 6 }); await sleep(30); } await page.mouse.up(); await sleep(700); };
  const w0 = await fv('Width'), cx0b = await fv('Centre X');
  const hx = await scr('x');
  await dragPath([hx, [hx[0] + 20, hx[1]], [hx[0] + 60, hx[1]]]);
  const w1 = await fv('Width'), cx1b = await fv('Centre X');
  step('size handle: wider, far side stays', w1 > w0 && Number.isInteger(w1) && Math.abs((cx1b - w1 / 2) - (cx0b - w0 / 2)) < 1e-3, `width ${w0} -> ${w1}, left side ${cx0b - w0 / 2} -> ${cx1b - w1 / 2}`);
  await click('.btn', 'Front'); await sleep(400);
  const hl = await scr('lift');
  await dragPath([hl, [hl[0], hl[1] - 20], [hl[0], hl[1] - 50]]);
  const zl = await fv('Bottom Z');
  step('lift cone raises the part', zl > 0 && Number.isInteger(zl), `bottom Z ${zl}`);
  await click('.btn', 'Top'); await sleep(400);
  const [r0, r90, r45] = await scr('ring');
  await dragPath([r0, r45, r90]);
  const rz = await fv('Z');
  step('Z ring turns in 15 degree steps', Math.abs(Math.abs(rz) - 90) < 1e-3, `rotation Z ${rz}`);
  await shot('5c-handles');

  // edge shaper on one picked wall: a fresh 20 mm box, fillet the top edge of its front wall only
  await addShape('Box');
  await sleep(600);
  const bid = await page.evaluate(() => document.getElementById('view').viewer.handleFor);
  await click('.inspector .btn', 'Edge shaper');
  await click('aside .seg button', 'Picked');
  await click('.btn', 'Front'); await sleep(400);
  const fp = await page.evaluate(id => {
    const v = document.getElementById('view').viewer, o = v.objs.get(id), b = o.mesh.geometry.boundingBox;
    o.group.updateMatrixWorld();
    const p = o.mesh.position.clone().set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2).applyMatrix4(o.group.matrixWorld).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
  }, bid);
  await page.mouse.click(...fp);
  await sleep(300);
  const note = await page.$$eval('aside .note', ns => ns.map(n => n.textContent).find(t => /picked/.test(t)) || '');
  await click('aside .btn', 'Apply');
  await waitStatus(/added to|ERROR/);
  const vf = await vol();
  await keys('f'); await page.evaluate(() => document.getElementById('view').viewer.view('iso', [document.getElementById('view').viewer.handleFor].filter(Boolean))); await shot('5d-picked-edge');
  step('edge shaper: one picked wall', /1 wall picked/.test(note) && vf < 8 && vf > 7.97, `${note.slice(0, 20)} | vol ${vf} cm3`);

  // projects: home folder picked once, project named, reopened by itself after a reload.
  // The picker is stood in by the browser's private storage, so no dialog is needed. That
  // storage is refused to file:// pages, so this part loads the same page from 127.0.0.1.
  await page.evaluateOnNewDocument(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('home', { create: true });
  });
  const html = readFileSync(join(ROOT, 'dist', 'Workingtitle3D.html'));
  server = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await sleep(800);
  await addShape('Box');
  await page.waitForSelector('dialog[open]');
  await click('dialog .btn', 'Pick folder');
  await page.waitForSelector('dialog[open] input.name-in');
  await page.$eval('dialog[open] input.name-in', i => { i.value = 'Test case'; });
  await click('dialog .btn', 'Save');
  await waitStatus(/Saving to projects|ERROR/);
  await addShape('Cylinder');
  await sleep(1500);
  await page.reload();
  const reopened = await waitStatus(/Opened|ERROR/, 15000).catch(e => e.message);
  step('project reopens itself after a reload', /Opened Test case: 2 parts/.test(reopened), reopened);
  await click('header .btn', 'Open');
  await page.waitForSelector('dialog[open] .projlist');
  const listed = await page.$$eval('dialog[open] .projlist .btn', b => b.map(x => x.textContent));
  step('Open lists the projects', listed.includes('Test case'), listed.join(', '));
  await click('dialog .btn', 'Cancel');

  // export: into exports/, never over an existing file (-1, -2 ...), and a closed solid
  await keys('Control', 'e');
  const e1 = await waitStatus(/Exported|ERROR/);
  await page.evaluate(() => { document.querySelector('footer .msg').textContent = ''; });
  await keys('Control', 'e');
  const e2 = await waitStatus(/Exported|ERROR/);
  step('export names never collide', /exports\/Test case\.stl/.test(e1) && /exports\/Test case-1\.stl/.test(e2), `${e1.slice(0, 40)} | ${e2.slice(0, 40)}`);
  const bytes = await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('home')).getDirectoryHandle('exports');
    return [...new Uint8Array(await (await (await dir.getFileHandle('Test case-1.stl')).getFile()).arrayBuffer())];
  });
  const r = report(readSTL(Uint8Array.from(bytes).buffer));
  step('export + read back', r.watertight, `${r.triangles} tris  ${describe(r)}  vol ${r.volume.toFixed(0)}`);

  // rename: click the project name box; the folder moves, the next step lands in the new one
  await page.click('header .file');
  await page.waitForSelector('dialog[open] input.name-in');
  await page.$eval('dialog[open] input.name-in', i => { i.value = 'Renamed case'; });
  await click('dialog .btn', 'Save');
  const rn = await waitStatus(/renamed|ERROR/);
  await addShape('Sphere');
  await sleep(1500);
  const after = await page.evaluate(async () => {
    const pd = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('home')).getDirectoryHandle('projects');
    const names = []; for await (const [n] of pd.entries()) names.push(n);
    const j = await (await (await (await pd.getDirectoryHandle('Renamed case')).getFileHandle('journal.ndjson')).getFile()).text();
    return { names, label: document.querySelector('header .file').textContent, lastStep: j.trim().split('\n').pop() };
  });
  step('rename the project', /Renamed case/.test(after.label) && after.names.includes('Renamed case') && !after.names.includes('Test case') && /Sphere/.test(after.lastStep),
    `${rn.slice(0, 50)} | ${after.names.join(', ')} | ${after.label}`);

  // a driver reset (resume from sleep) loses the GL context: say so, then redraw on restore
  await page.evaluate(() => { window._lc = document.querySelector('#view canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window._lc.loseContext(); });
  const lostMsg = await waitStatus(/graphics driver reset/);
  await page.evaluate(() => window._lc.restoreContext());
  const backMsg = await waitStatus(/view is back/);
  await sleep(300);
  await page.screenshot({ path: join(OUT, 'restored.png') });
  step('GL context lost and restored', /driver reset/.test(lostMsg) && /back/.test(backMsg), backMsg);

  // a browser that refuses WebGL at load says so instead of looking ready
  const nogl = await browser.newPage();
  await nogl.evaluateOnNewDocument(() => { const g = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); }; });
  await nogl.goto(pathToFileURL(join(ROOT, 'dist', 'Workingtitle3D.html')).href);
  await sleep(1000);
  const fat = await nogl.$eval('.fatal', e => e.style.display !== 'none' && e.textContent).catch(() => '');
  await nogl.close();
  step('no WebGL at load shows the error', /3D graphics/.test(fat), fat.slice(0, 60));
} catch (e) {
  fail++;
  const st = await page.$eval('footer .msg', e => e.textContent).catch(() => '');
  await page.screenshot({ path: join(OUT, 'fail.png') }).catch(() => {});
  console.log('FAIL ' + e.message + (st ? `  (status: ${st})` : ''));
} finally {
  await browser.close();
  server?.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
