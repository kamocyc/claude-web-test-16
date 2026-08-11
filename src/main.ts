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

// Handles for the screenshot tool and for poking at state from the console.
Object.assign(window as unknown as Record<string, unknown>, {
  __viewer: viewer,
  __environment: environment,
  __params: params,
  __materials: materials,
  __controls: controls,
});
