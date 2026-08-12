import * as THREE from 'three';
import {
  DEFAULT_PARAMS,
  applyRoadLayout,
  cloneParams,
  type CityParams,
  type RoadLayout,
} from './core/params.js';
import { generateCity, type City } from './city/City.js';
import { buildCityMesh, disposeCityMesh, type CityMeshResult } from './build/CityMesh.js';
import { createMaterials, type MaterialLibrary } from './material/materials.js';
import { Viewer } from './app/Viewer.js';
import { Environment } from './app/Environment.js';
import { Controls } from './app/Controls.js';
import { DebugOverlay } from './app/DebugOverlay.js';

const container = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;

const params: CityParams = cloneParams(DEFAULT_PARAMS);

const viewer = new Viewer(container);
const materials: MaterialLibrary = createMaterials(
  viewer.renderer.capabilities.getMaxAnisotropy(),
);
const environment = new Environment(viewer.scene, viewer.renderer, params.render);
materials.setIblAvailable(environment.supportsPmrem);
const controls = new Controls(viewer.camera, viewer.renderer.domElement, params.roads.extent + 40);
const overlay = new DebugOverlay(viewer.scene);

let city: City | null = null;
let mesh: CityMeshResult | null = null;
let generateMs = 0;

function regenerate(): void {
  loading.classList.remove('hidden');
  loading.textContent = '街を生成しています…';

  // Yield a frame so the overlay actually paints before the blocking build.
  requestAnimationFrame(() => {
    const t0 = performance.now();
    if (mesh) {
      viewer.scene.remove(mesh.group);
      disposeCityMesh(mesh.group);
    }

    city = generateCity(params);
    mesh = buildCityMesh(city, params, materials);
    viewer.scene.add(mesh.group);
    overlay.rebuild(city, { buildable: mesh.buildableDebug, footprints: mesh.footprintDebug });
    generateMs = performance.now() - t0;

    loading.classList.add('hidden');
    // Exposed for the Playwright screenshot tool.
    (window as unknown as { __cityReady?: boolean }).__cityReady = true;
  });
}

viewer.camera.position.set(190, 150, 235);
controls.orbit.target.set(0, 0, 0);

viewer.onUpdate((dt) => {
  controls.update(dt);
  environment.update();
  environment.followCamera(controls.focus);

  const s = viewer.stats;
  const cityStats = mesh?.stats;
  hud.textContent = [
    `seed        ${params.seed}`,
    `lots        ${city?.lots.length ?? 0}`,
    `buildings   ${cityStats?.buildings ?? 0}`,
    `triangles   ${(s.triangles / 1000).toFixed(0)}k`,
    `draw calls  ${s.drawCalls}`,
    `props       ${cityStats?.propInstances ?? 0}`,
    `generate    ${generateMs.toFixed(0)} ms`,
    `fps         ${s.fps.toFixed(0)}`,
    `mode        ${controls.currentMode}`,
  ].join('\n');
});

regenerate();
viewer.start();

// The debug UI is development-only, and dynamically imported so lil-gui is
// tree-shaken out of production builds entirely.
if (import.meta.env.DEV) {
  void import('./app/DebugUI.js').then(({ createDebugUI }) => {
    createDebugUI({
      params,
      regenerate,
      overlay,
      environment,
      materials,
      controls,
      getStats: () => mesh?.stats ?? null,
    });
  });
}

// Screenshot hooks used by tools/screenshot.mjs.
(window as unknown as Record<string, unknown>).__setCamera = (
  pos: [number, number, number],
  target: [number, number, number],
) => {
  controls.setView(new THREE.Vector3(...pos), new THREE.Vector3(...target));
};
(window as unknown as Record<string, unknown>).__setSeed = (seed: string) => {
  params.seed = seed;
  regenerate();
};
(window as unknown as Record<string, unknown>).__setLayout = (layout: RoadLayout) => {
  applyRoadLayout(params.roads, layout);
  regenerate();
};

/** Even-odd point in ring, for the street-view helper above. */
function pointInRing(poly: { x: number; y: number }[], p: { x: number; y: number }): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Handles for the screenshot tool and for poking at state from the console.
Object.assign(window as unknown as Record<string, unknown>, {
  __viewer: viewer,
  __environment: environment,
  __params: params,
  __materials: materials,
  __controls: controls,
  // Land use is invisible from a fixed camera position — the whole point of the
  // zoning is that different parts of the town are different — so the shot tool
  // needs to be able to ask where the shops and the factories actually are.
  /**
   * A camera standing on a street inside the given 用途地域, looking along it.
   *
   * Pointing a camera at a district centroid puts it inside a building or on a
   * roof about as often as not, which makes it useless for checking the thing
   * these zones exist to produce — the view *along* a shopping street.
   */
  __streetViewIn: (zone: string, eye = 4.5): [[number, number, number], [number, number, number]] | null => {
    const d = city?.roads.districts.find((k) => k.zone === zone);
    if (!d || !city) return null;
    let cx = 0;
    let cy = 0;
    for (const p of d.polygon) {
      cx += p.x;
      cy += p.y;
    }
    cx /= d.polygon.length;
    cy /= d.polygon.length;

    // The longest road segment whose midpoint is inside the district: the street
    // most worth standing on, and one that certainly is not inside a building.
    let best: { a: THREE.Vector2; b: THREE.Vector2; len: number } | null = null;
    for (const e of city.roads.edges) {
      const a = city.roads.graph.node(e.a).p;
      const b = city.roads.graph.node(e.b).p;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (!pointInRing(d.polygon, { x: mx, y: my })) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!best || len > best.len) best = { a: new THREE.Vector2(a.x, a.y), b: new THREE.Vector2(b.x, b.y), len };
    }
    if (!best) return null;
    const t = 0.2;
    const px = best.a.x + (best.b.x - best.a.x) * t;
    const py = best.a.y + (best.b.y - best.a.y) * t;
    const qx = best.a.x + (best.b.x - best.a.x) * 0.85;
    const qy = best.a.y + (best.b.y - best.a.y) * 0.85;
    void cx;
    void cy;
    return [
      [px, eye, py],
      [qx, eye * 0.6, qy],
    ];
  },
  __zoneCentre: (zone: string): [number, number] | null => {
    const d = city?.roads.districts.find((k) => k.zone === zone);
    if (!d) return null;
    let x = 0;
    let y = 0;
    for (const p of d.polygon) {
      x += p.x;
      y += p.y;
    }
    return [x / d.polygon.length, y / d.polygon.length];
  },
});
