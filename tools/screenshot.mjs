/**
 * Capture a fixed set of views from the running dev server.
 *
 * Chromium is preinstalled at /opt/pw-browsers, so `playwright install` is never
 * needed. SwiftShader provides WebGL2 without a GPU — slow, but correct.
 *
 *   node tools/screenshot.mjs [--url http://127.0.0.1:5173] [--out shots]
 *                             [--seed sakura-3] [--only overview]
 *                             [--zones commercial,industrial] [--kinds konbini,factory]
 *
 * `--zones` adds two shots per 用途地域 named: one from the air and one standing
 * on the longest street inside it. Fixed camera positions cannot show the
 * zoning, because where the shops and the factories land is different for every
 * seed — and a shopping street only reads as one when you are looking *along* it.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = arg('url', 'http://127.0.0.1:5173');
const OUT = arg('out', 'shots');
const SEED = arg('seed', null);
const LAYOUT = arg('layout', null);
const ONLY = arg('only', null);
const AGE = arg('age', null);
const ZONES = arg('zones', null);
const KINDS = arg('kinds', null);

/** [name, cameraPosition, lookAtTarget] */
const VIEWS = [
  ['overview', [230, 190, 285], [0, 0, 0]],
  ['district', [95, 62, 120], [10, 0, 20]],
  ['street-house', [18, 6.5, 26], [-14, 3, -6]],
  ['street-close', [-52, 4.2, 8], [-30, 3.2, 22]],
  ['rooftops', [60, 34, 60], [0, 6, 0]],
  // Terrain. A town on a hillside cannot be judged from inside it: the whole
  // point is the shape of the land under it, and every fixed street-level
  // camera above is aimed at a building.
  ['land', [0, 900, 40], [0, 0, 0]],
  ['land-low', [420, 130, 470], [-40, 0, -40]],
];


const shots = ONLY ? VIEWS.filter(([n]) => n === ONLY) : VIEWS;

await mkdir(OUT, { recursive: true });

// The environment ships a Chromium at /opt/pw-browsers whose revision may not
// match what this Playwright version would download. Point at it explicitly
// rather than fetching another copy — `playwright install` is not available.
const executablePath = existsSync('/opt/pw-browsers/chromium')
  ? '/opt/pw-browsers/chromium'
  : undefined;

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    // SwiftShader gives WebGL2 without a GPU: slow, but it renders correctly.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[page:${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

console.log(`opening ${URL} …`);
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });

await page.waitForFunction(() => window.__cityReady === true, null, { timeout: 300000 });
console.log('city generated');

if (SEED) {
  await page.evaluate((s) => {
    window.__cityReady = false;
    window.__setSeed(s);
  }, SEED);
  await page.waitForFunction(() => window.__cityReady === true, null, { timeout: 300000 });
  console.log(`seed set to ${SEED}`);
}

if (LAYOUT) {
  await page.evaluate((l) => {
    window.__cityReady = false;
    window.__setLayout(l);
  }, LAYOUT);
  await page.waitForFunction(() => window.__cityReady === true, null, { timeout: 300000 });
  console.log(`layout set to ${LAYOUT}`);
}

// Hide the debug panel so it does not cover the view.
await page.addStyleTag({ content: '.lil-gui{display:none!important} #hint{display:none!important}' });

if (AGE) {
  await page.evaluate((n) => window.__setAge(n), Number(AGE));
  await page.waitForFunction(() => window.__cityReady === true);
  await page.waitForTimeout(1500);
}

for (const [name, pos, target] of shots) {
  await page.evaluate(([p, t]) => window.__setCamera(p, t), [pos, target]);
  // Let a few frames render so shadows and the environment settle.
  await page.waitForTimeout(2500);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

for (const zone of ZONES ? ZONES.split(',') : []) {
  const centre = await page.evaluate((z) => window.__zoneCentre(z), zone);
  if (!centre) {
    console.log(`no ${zone} district in this town`);
    continue;
  }
  await page.evaluate(([p, t]) => window.__setCamera(p, t), [
    [centre[0] + 90, 70, centre[1] + 90],
    [centre[0], 0, centre[1]],
  ]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `${zone}-air.png`) });
  console.log(`wrote ${path.join(OUT, `${zone}-air.png`)}`);

  const view = await page.evaluate((z) => window.__streetViewIn(z), zone);
  if (!view) continue;
  await page.evaluate(([p, t]) => window.__setCamera(p, t), view);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `${zone}-street.png`) });
  console.log(`wrote ${path.join(OUT, `${zone}-street.png`)}`);
}

for (const kind of KINDS ? KINDS.split(',') : []) {
  const view = await page.evaluate((k) => window.__kindView(k), kind);
  if (!view) {
    console.log(`no ${kind} in this town`);
    continue;
  }
  await page.evaluate(([p, t]) => window.__setCamera(p, t), view);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, `kind-${kind}.png`) });
  console.log(`wrote ${path.join(OUT, `kind-${kind}.png`)}`);
}

if (!ONLY || ONLY === 'river') {
  const view = await page.evaluate(() => window.__riverView());
  if (view) {
    await page.evaluate(([p, t]) => window.__setCamera(p, t), view);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, 'river.png') });
    console.log(`wrote ${path.join(OUT, 'river.png')}`);
  } else {
    console.log('no river in this town');
  }
}

// The 擁壁 view has to be *found* — a retaining wall is wherever the land
// happened to fall away, which moves with the seed.
if (!ONLY || ONLY === 'wall') {
  const view = await page.evaluate(() => window.__wallView());
  if (view) {
    await page.evaluate(([p, t]) => window.__setCamera(p, t), view);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, 'wall.png') });
    console.log(`wrote ${path.join(OUT, 'wall.png')}`);
  } else {
    console.log('no retaining wall in this town');
  }
}

const stats = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
console.log('\n' + stats);

await browser.close();
