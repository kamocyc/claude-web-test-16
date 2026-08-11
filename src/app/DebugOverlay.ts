import * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import type { City } from '../city/City.js';
import { UNAVOIDABLE_VACANCY } from '../building/types.js';

/**
 * Line overlays for every intermediate stage. The lot and frontage layers are
 * not a nicety — subdivision quality is impossible to judge from the finished
 * buildings, and everything downstream inherits it.
 */

export type OverlayLayer =
  | 'roads'
  | 'blocks'
  | 'lots'
  | 'frontage'
  | 'buildable'
  | 'footprints'
  | 'flagPoles'
  | 'vacantUnavoidable'
  | 'vacantAvoidable';

const COLORS: Record<OverlayLayer, number> = {
  roads: 0x4aa3ff,
  blocks: 0xffd24a,
  lots: 0x63e08a,
  frontage: 0xff6b6b,
  buildable: 0xb07cff,
  footprints: 0xffffff,
  flagPoles: 0xff9f43,
  // Two colours, because the distinction is the whole point: grey is a scrap of
  // land nothing belongs on, red is a lot the generator failed to use.
  vacantUnavoidable: 0x9aa0a6,
  vacantAvoidable: 0xff2d55,
};

const HEIGHTS: Record<OverlayLayer, number> = {
  roads: 0.35,
  blocks: 0.4,
  lots: 0.45,
  frontage: 0.5,
  buildable: 0.55,
  footprints: 0.6,
  flagPoles: 0.5,
  vacantUnavoidable: 0.65,
  vacantAvoidable: 0.66,
};

export class DebugOverlay {
  readonly group = new THREE.Group();
  private layers = new Map<OverlayLayer, THREE.LineSegments>();
  private enabled = new Set<OverlayLayer>();

  constructor(parent: THREE.Object3D) {
    this.group.name = 'debug-overlay';
    parent.add(this.group);
  }

  setEnabled(layer: OverlayLayer, on: boolean): void {
    if (on) this.enabled.add(layer);
    else this.enabled.delete(layer);
    const mesh = this.layers.get(layer);
    if (mesh) mesh.visible = on;
  }

  isEnabled(layer: OverlayLayer): boolean {
    return this.enabled.has(layer);
  }

  /** Rebuild every layer from a freshly generated city. */
  rebuild(city: City, extra: { buildable?: Polygon[]; footprints?: Polygon[] } = {}): void {
    this.clear();

    const roadSegs: number[] = [];
    for (const e of city.roads.edges) {
      const a = city.roads.graph.node(e.a).p;
      const b = city.roads.graph.node(e.b).p;
      const h = HEIGHTS.roads;
      roadSegs.push(a.x, h, a.y, b.x, h, b.y);
    }
    for (const lane of city.roads.privateLanes) {
      roadSegs.push(lane.a.x, HEIGHTS.roads, lane.a.y, lane.b.x, HEIGHTS.roads, lane.b.y);
    }
    this.addLayer('roads', roadSegs);

    this.addLayer('blocks', ringSegments(city.blocks.map((b) => b.polygon), HEIGHTS.blocks));
    this.addLayer('lots', ringSegments(city.lots.map((l) => l.polygon), HEIGHTS.lots));

    // Frontage arrows: a stem along the street plus a head pointing outward.
    const frontSegs: number[] = [];
    for (const lot of city.lots) {
      for (const f of lot.frontages) {
        const h = HEIGHTS.frontage;
        const tip = V.addScaled(f.mid, f.outward, 2.2);
        frontSegs.push(f.mid.x, h, f.mid.y, tip.x, h, tip.y);
        const wing = V.scale(f.dir, 0.6);
        const back = V.addScaled(tip, f.outward, -0.9);
        frontSegs.push(tip.x, h, tip.y, back.x + wing.x, h, back.y + wing.y);
        frontSegs.push(tip.x, h, tip.y, back.x - wing.x, h, back.y - wing.y);
      }
    }
    this.addLayer('frontage', frontSegs);

    const poles = city.lots
      .map((l) => l.poleCorridor)
      .filter((p): p is Polygon => p !== null);
    this.addLayer('flagPoles', ringSegments(poles, HEIGHTS.flagPoles));

    this.addLayer('buildable', ringSegments(extra.buildable ?? [], HEIGHTS.buildable));
    this.addLayer('footprints', ringSegments(extra.footprints ?? [], HEIGHTS.footprints));

    // Empty lots, split by whether anything could have been done about it. A
    // lot with no building used to be indistinguishable from ordinary ground —
    // you could see the hole in the block but not why it was there, or even
    // whether the generator knew.
    const vacant = city.lots.filter((l) => l.kind === 'vacant');
    const unavoidable = vacant.filter(
      (l) => l.vacancyReason !== null && UNAVOIDABLE_VACANCY.includes(l.vacancyReason),
    );
    const avoidable = vacant.filter((l) => !unavoidable.includes(l));
    this.addLayer(
      'vacantUnavoidable',
      crossedRings(unavoidable.map((l) => l.polygon), HEIGHTS.vacantUnavoidable),
    );
    this.addLayer(
      'vacantAvoidable',
      crossedRings(avoidable.map((l) => l.polygon), HEIGHTS.vacantAvoidable),
    );
  }

  private addLayer(layer: OverlayLayer, positions: number[]): void {
    if (positions.length === 0) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: COLORS[layer],
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      fog: false,
    });
    const mesh = new THREE.LineSegments(geom, mat);
    mesh.renderOrder = 999;
    mesh.visible = this.enabled.has(layer);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.layers.set(layer, mesh);
  }

  clear(): void {
    for (const mesh of this.layers.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.layers.clear();
  }
}

/**
 * A ring with both diagonals struck across it.
 *
 * An empty lot is picked out by its outline alone only if you already know
 * which outline to look at; crossing it out makes it findable from the air,
 * which is the point of the layer.
 */
function crossedRings(polys: Polygon[], h: number): number[] {
  const out = ringSegments(polys, h);
  for (const poly of polys) {
    if (poly.length < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    out.push(minX, h, minY, maxX, h, maxY);
    out.push(minX, h, maxY, maxX, h, minY);
  }
  return out;
}

function ringSegments(polys: Polygon[], h: number): number[] {
  const out: number[] = [];
  for (const poly of polys) {
    for (let i = 0, n = poly.length; i < n; i++) {
      const a: Vec2 = poly[i]!;
      const b: Vec2 = poly[(i + 1) % n]!;
      out.push(a.x, h, a.y, b.x, h, b.y);
    }
  }
  return out;
}
