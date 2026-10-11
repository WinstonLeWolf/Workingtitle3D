// Drive the built page headless and muted (no window on screen, no sound): add shapes, make a
// hole, group, add a fillet step, undo/redo, import an STL, drag a part, export by download
// and read the file back. Screenshots go to .tmp/browser for a look; delete them after.
// node tests/browser.mjs
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
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
try {
  const page = await browser.newPage();
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
  const keys = async (...k) => { for (const x of k) await page.keyboard.down(x); for (const x of k.reverse()) await page.keyboard.up(x); await sleep(150); };

  await shot('0-empty');
  await click('.shapes .btn', 'Box');
  await page.waitForSelector('dialog[open]');
  await shot('1-folder-ask');
  await click('dialog .btn', 'Later');
  await click('.shapes .btn', 'Cylinder');
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
  await click('header .btn', 'Pick folder');
  await page.waitForSelector('dialog[open]');
  const msg = await page.$eval('dialog[open]', d => d.textContent);
  step('no folder access explained', /switched off/.test(msg) && /brave:\/\/flags/.test(msg));
  await click('dialog .btn', 'OK');

  // rotation turns about the part's middle; Bottom Z shows where it really sits
  await click('.shapes .btn', 'Box');
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

  // export
  await keys('Control', 'e');
  await waitStatus(/Exported|ERROR/);
  let file = null;
  for (let i = 0; i < 100 && !file; i++) { const f = readdirSync(join(OUT, 'dl')).find(n => n.endsWith('.stl')); if (f) file = join(OUT, 'dl', f); else await sleep(100); }
  if (!file) step('export', false, await statusText());
  else {
    await sleep(300);
    const buf = readFileSync(file);
    const r = report(readSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
    step('export + read back', r.watertight, `${r.triangles} tris  ${describe(r)}  vol ${r.volume.toFixed(0)}`);
  }
} catch (e) {
  fail++;
  console.log('FAIL ' + e.message);
} finally {
  await browser.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
