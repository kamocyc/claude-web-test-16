import * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import type { UseZone } from '../core/params.js';
import type { City } from '../city/City.js';
import type { LotKind } from '../city/Lots.js';
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
  | 'vacantAvoidable'
  | 'landUse'
  | 'useZones'
  | 'zoneFill'
  | 'useFill';

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
  // Legend colour only; these four are drawn per vertex.
  landUse: 0x63e08a,
  useZones: 0xffb03a,
  zoneFill: 0x9a6bff,
  useFill: 0x63e08a,
};

/**
 * Lot colours by use.
 *
 * A `Record<LotKind, …>` rather than a lookup with a white fallback. It was the
 * latter, and the five uses added after it was written all came out white —
 * which reads as a rendering fault rather than as "nobody assigned a colour",
 * and is invisible until you look at a town that has them.
 */
const KIND_COLORS: Record<LotKind, number> = {
  house: 0x63e08a,
  apart: 0x3fbf7f,
  mansion: 0x2f8fd0,
  shophouse: 0xffb03a,
  zakkyo: 0xff5fa2,
  konbini: 0x00d0d0,
  factory: 0x9a6bff,
  warehouse: 0x7a7f8a,
  vacant: 0x9aa0a6,
};

/** District outline colours by 用途地域. */
const ZONE_COLORS: Record<UseZone, number> = {
  lowRise: 0x63e08a,
  midRise: 0x3fbf7f,
  neighbourCom: 0xffb03a,
  commercial: 0xff5fa2,
  quasiIndust: 0xc0a060,
  industrial: 0x9a6bff,
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
  landUse: 0.47,
  useZones: 0.3,
  // Below the line layers, so an outline drawn over a fill still reads.
  zoneFill: 0.12,
  useFill: 0.16,
};

export class DebugOverlay {
  readonly group = new THREE.Group();
  private layers = new Map<OverlayLayer, THREE.Object3D>();
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

    // Land use, coloured per ring rather than per layer. Judging whether the
    // zoning worked from the finished buildings is as hopeless as judging
    // subdivision from them: a 工場 and a マンション are both big pale boxes from
    // above. The district layer in particular is what answers the one question
    // the flood fill exists to answer — is the industrial belt actually one
    // piece, or has it broken into islands?
    const lotRings = ringSegmentsColored(
      city.lots.map((l) => ({
        poly: l.polygon,
        color: KIND_COLORS[l.zonedKind],
      })),
      HEIGHTS.landUse,
    );
    this.addLayer('landUse', lotRings.positions, lotRings.colors);

    const zoneRings = ringSegmentsColored(
      city.roads.districts.map((d) => ({ poly: d.polygon, color: ZONE_COLORS[d.zone] })),
      HEIGHTS.useZones,
    );
    this.addLayer('useZones', zoneRings.positions, zoneRings.colors);

    // Filled, not just outlined. An outline tells you where a boundary is; a
    // wash tells you how much of the town each 用途地域 got, which is the
    // question the area ceilings exist to answer and the one an outline is
    // worst at — a big district and a small one look the same as two rings.
    this.addFillLayer(
      'zoneFill',
      city.roads.districts.map((d) => ({ poly: d.polygon, color: ZONE_COLORS[d.zone] })),
      HEIGHTS.zoneFill,
    );
    this.addFillLayer(
      'useFill',
      city.lots.map((l) => ({ poly: l.polygon, color: KIND_COLORS[l.zonedKind] })),
      HEIGHTS.useFill,
    );
  }

  /**
   * A translucent wash over a set of rings, coloured per ring.
   *
   * Unlit and depth-test-free like the line layers, so it reads over the roofs
   * from any angle rather than being hidden by the town it describes.
   */
  private addFillLayer(
    layer: OverlayLayer,
    rings: { poly: Polygon; color: number }[],
    h: number,
  ): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const c = new THREE.Color();
    for (const { poly, color } of rings) {
      if (poly.length < 3) continue;
      c.setHex(color, THREE.SRGBColorSpace);
      // Fan triangulation is wrong on a concave ring, and district faces are
      // routinely concave, so go through the same ear clipper the roofs use.
      const shape = poly.map((p) => new THREE.Vector2(p.x, p.y));
      for (const tri of THREE.ShapeUtils.triangulateShape(shape, [])) {
        for (const i of tri) {
          const p = poly[i]!;
          positions.push(p.x, h, p.y);
          colors.push(c.r, c.g, c.b);
        }
      }
    }
    if (positions.length === 0) return;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 998;
    mesh.visible = this.enabled.has(layer);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.layers.set(layer, mesh);
  }

  private addLayer(layer: OverlayLayer, positions: number[], colors?: number[]): void {
    if (positions.length === 0) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    // `LineBasicMaterial` takes one colour for the whole layer, so a layer that
    // distinguishes categories has to carry them per vertex.
    if (colors) geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      ...(colors ? { vertexColors: true } : { color: COLORS[layer] }),
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
    for (const object of this.layers.values()) {
      this.group.remove(object);
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
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

/** Ring outlines with a colour per ring, for the category layers. */
function ringSegmentsColored(
  rings: { poly: Polygon; color: number }[],
  h: number,
): { positions: number[]; colors: number[] } {
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  for (const { poly, color } of rings) {
    c.setHex(color, THREE.SRGBColorSpace);
    for (let i = 0, n = poly.length; i < n; i++) {
      const a: Vec2 = poly[i]!;
      const b: Vec2 = poly[(i + 1) % n]!;
      positions.push(a.x, h, a.y, b.x, h, b.y);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  return { positions, colors };
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
