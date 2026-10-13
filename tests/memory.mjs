// Memory over a heavy step: import a large open mesh, repair it with Make solid, then watch
// the whole browser's private memory (every process of this headless instance) while idle.
// It must fall back after the step. Headless and muted.
// node tests/memory.mjs   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeSTL } from '../src/core/meshio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'memory');
const PROFILE = join(OUT, 'chrome-memprobe');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const findChrome = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = findChrome(p); if (hit) return hit; } else if (e.name === 'chrome.exe') return p;
  }
  return null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GRID = +(process.argv[2] || 0.25);

// a big open mesh: a 60 mm sphere, 400 x 400 facets, with its top cut off
const n = 400, r = 30, t = [];
const P = (i, j) => { const th = Math.PI * i / n, ph = 2 * Math.PI * j / n; return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th) + r]; };
for (let i = 20; i < n; i++) for (let j = 0; j < n; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1); t.push(...a, ...b, ...d); if (i < n - 1) t.push(...b, ...c, ...d); }
const file = join(OUT, 'bigholed.stl');
writeFileSync(file, writeSTL(Float32Array.from(t)));

// private bytes of every process started with this profile
const mem = () => {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*chrome-memprobe*' } | Measure-Object -Property PrivatePageCount -Sum | ForEach-Object { $_.Sum }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  return Math.round((+out || 0) / 1048576);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR), headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-crash-reporter', '--disable-breakpad'],
});
const rows = [];
const note = (stage, mb) => { rows.push([stage, mb]); console.log(`${stage.padEnd(28)} ${String(mb).padStart(6)} MB`); };
try {
  const page = await browser.newPage();
  page.on('dialog', d => d.dismiss());
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
  await page.goto(pathToFileURL(join(ROOT, 'Workingtitle3D.html')).href);
  await sleep(2000);
  note('loaded, empty', mem());
  const statusText = () => page.$eval('footer .msg', e => (e.classList.contains('err') ? 'ERROR ' : '') + e.textContent);
  const waitStatus = async (re, ms = 600000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await statusText(); if (re.test(s)) return s; await sleep(200); } return 'TIMEOUT'; };
  const clickText = async (sel, text) => { for (const e of await page.$$(sel)) if ((await e.evaluate(x => x.textContent.trim())) === text && await e.evaluate(x => x.offsetParent !== null)) { await e.click(); return; } throw new Error('no ' + text); };
  await (await page.$('input[accept*=".stl"]')).uploadFile(file);
  // the first change asks about a project folder; answer it, then wait for the part's panel
  for (let i = 0; i < 600; i++) {
    for (const b of await page.$$('dialog[open] .btn')) { await b.click(); break; }
    if (await page.$$eval('.inspector .btn', bs => bs.some(b => b.textContent === 'Repair'))) break;
    await sleep(200);
  }
  await sleep(3000);
  note(`imported, ${t.length / 9} tris`, mem());
  await clickText('.inspector .btn', 'Repair');
  await page.$$eval('aside input[type=checkbox]', cs => cs.find(c => c.closest('label')?.textContent.includes('Make solid'))?.click());
  // grid
  for (const f of await page.$$('aside .field')) if ((await f.$eval('label', l => l.textContent)) === 'Resolution') { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type(String(GRID)); await i.press('Enter'); }
  await sleep(300);
  let peak = 0, done = false;
  const watch = (async () => { while (!done) { peak = Math.max(peak, mem()); await sleep(500); } })();
  const t0 = Date.now();
  await clickText('aside .btn', 'Apply');
  const st = await waitStatus(/added to|ERROR/);
  done = true; await watch;
  console.log(`  ${st.slice(0, 100)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  note(`peak during repair (${GRID} mm)`, peak);
  note('just after', mem());
  await sleep(10000);
  note('10 s idle', mem());
  await sleep(20000);
  note('30 s idle', mem());
} finally {
  await browser.close();
}
