/**
 * Capture a fixed set of views from the running dev server.
 *
 * Chromium is preinstalled at /opt/pw-browsers, so `playwright install` is never
 * needed. SwiftShader provides WebGL2 without a GPU — slow, but correct.
 *
 *   node tools/screenshot.mjs [--url http://127.0.0.1:5173] [--out shots]
 *                             [--seed sakura-3] [--only overview]
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
const ONLY = arg('only', null);

/** [name, cameraPosition, lookAtTarget] */
const VIEWS = [
  ['overview', [230, 190, 285], [0, 0, 0]],
  ['district', [95, 62, 120], [10, 0, 20]],
  ['street-house', [18, 6.5, 26], [-14, 3, -6]],
  ['street-close', [-52, 4.2, 8], [-30, 3.2, 22]],
  ['rooftops', [60, 34, 60], [0, 6, 0]],
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

// Hide the debug panel so it does not cover the view.
await page.addStyleTag({ content: '.lil-gui{display:none!important} #hint{display:none!important}' });

for (const [name, pos, target] of shots) {
  await page.evaluate(([p, t]) => window.__setCamera(p, t), [pos, target]);
  // Let a few frames render so shadows and the environment settle.
  await page.waitForTimeout(2500);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

const stats = await page.evaluate(() => document.getElementById('hud')?.textContent ?? '');
console.log('\n' + stats);

await browser.close();
