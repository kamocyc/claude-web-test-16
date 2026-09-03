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
import * as V3 from './geom/vec2.js';

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
  // Cleared here, not just set at the end: the screenshot tool waits on this
  // flag, and after the first town it is already true — so every `__setSeed` or
  // `__setAge` shot was taken of the *previous* town.
  (window as unknown as { __cityReady?: boolean }).__cityReady = false;

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
    controls.setObstacles(mesh.footprintDebug);
    // Walking follows the ground and whatever platform has been cut into it;
    // driving follows the carriageway, which is graded and does not.
    const padGrid = makePadSampler(city);
    controls.setGround(
      (x, z) => padGrid(x, z) ?? city!.terrain.heightAtXY(x, z),
      (x, z) =>
        city!.roadHeights.nearestRoadHeight({ x, y: z }, 24) ?? city!.terrain.heightAtXY(x, z),
    );
    // Re-exposed on every regeneration rather than in the static handle block
    // below, because it is a different set of polygons each time. Used to check
    // from the console — or from a script — that the street modes really are
    // staying out of the buildings.
    (window as unknown as Record<string, unknown>).__footprints = mesh.footprintDebug;
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
    `mode        ${controls.currentMode}` +
      (controls.currentMode === 'drive' ? `  ${controls.speedKmh.toFixed(0)} km/h` : ''),
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
      getCity: () => city ?? null,
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
/** The town's age, for the shot tool: `--age 10` beside `--seed`. */
(window as unknown as Record<string, unknown>).__setAge = (steps: number) => {
  params.roads.growth.steps = steps;
  regenerate();
};
(window as unknown as Record<string, unknown>).__setLayout = (layout: RoadLayout) => {
  applyRoadLayout(params.roads, layout);
  regenerate();
};

/**
 * A coarse raster of levelled pad heights, so walking does not sink through the
 * 擁壁 it just walked past.
 *
 * The terrain says where the *land* is; a lot has been cut to a level platform
 * a metre or two off it, and that platform is what you are standing on for most
 * of a walk through this town. Rasterised rather than searched, because this is
 * sampled once a frame and a linear scan over fifteen hundred lots is not.
 */
function makePadSampler(city: City): (x: number, z: number) => number | null {
  const cell = 8;
  const grid = new Map<number, number>();
  for (const lot of city.lots) {
    const pad = lot.platform.padY;
    if (pad === 0 && !city.terrain.field) continue;
    for (const q of lot.polygon) {
      const key = Math.floor(q.x / cell) * 100000 + Math.floor(q.y / cell);
      const prev = grid.get(key);
      if (prev === undefined || pad > prev) grid.set(key, pad);
    }
    const c = lot.centroid;
    const key = Math.floor(c.x / cell) * 100000 + Math.floor(c.y / cell);
    const prev = grid.get(key);
    if (prev === undefined || pad > prev) grid.set(key, pad);
  }
  return (x, z) => grid.get(Math.floor(x / cell) * 100000 + Math.floor(z / cell)) ?? null;
}

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
  __overlay: overlay,
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
  /** A camera looking at one building of the given use, for checking a new one. */
  __kindView: (kind: string): [[number, number, number], [number, number, number]] | null => {
    const lot = city?.lots.find((l) => l.zonedKind === kind);
    if (!lot) return null;
    const c = lot.centroid;
    // Steep and centred: a use is easiest to judge against the *lot* it stands
    // on, and for the drive-in ones the lot is most of the point. Pulled back in
    // proportion to the plot, since a factory parcel is thirty times a house's.
    const r = Math.max(18, Math.sqrt(lot.area) * 1.6);
    return [
      [c.x + r * 0.2, r * 1.1, c.y + r],
      [c.x, 0, c.y],
    ];
  },
  /**
   * A camera on the street below the tallest 擁壁 in the town.
   *
   * The fixed views cannot find one: a retaining wall is wherever the land
   * happened to fall away, which moves with the seed, and the whole point of
   * this feature is only legible from the low side of one.
   */
  __wallView: (): [[number, number, number], [number, number, number]] | null => {
    if (!city) return null;
    let best: { lot: (typeof city.lots)[number]; drop: number } | null = null;
    for (const lot of city.lots) {
      if (!lot.frontages[0]) continue;
      for (const e of lot.platform.edges) {
        if (e.kind !== 'wall') continue;
        if (!best || e.worst > best.drop) best = { lot, drop: e.worst };
      }
    }
    if (!best) return null;
    const f = best.lot.frontages[0]!;
    // Back off across the street and up a little, looking down the frontage.
    // Standing at eye height directly under the wall puts the rising ground
    // between the camera and the thing it is meant to show.
    const eye = V3.addScaled(V3.addScaled(f.mid, f.outward, 22), f.dir, 14);
    const ground = city.roadHeights.nearestRoadHeight(eye, 60) ?? city.terrain.heightAt(eye);
    return [
      [eye.x, ground + 7, eye.y],
      [f.mid.x, best.lot.platform.padY - best.drop * 0.5, f.mid.y],
    ];
  },
  /** Standing on the bank of the river, looking along it. */
  __riverView: (): [[number, number, number], [number, number, number]] | null => {
    const r = city?.terrain.river;
    if (!r || !city) return null;
    const i = Math.floor(r.centre.length / 2);
    const a = r.centre[i]!;
    const b = r.centre[Math.min(r.centre.length - 1, i + 3)]!;
    const d = V3.normalize(V3.sub(b, a));
    const n = V3.perp(d);
    // Well back and well up: the bank is built right to the water now, so a
    // camera at the old 34 m stood inside somebody's second floor.
    const eye = V3.addScaled(V3.addScaled(a, n, 70), d, -70);
    return [
      [eye.x, city.terrain.heightAt(eye) + 30, eye.y],
      [b.x, r.water[i]!, b.y],
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
