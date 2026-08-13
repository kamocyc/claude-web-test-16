import * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import type { UseZone } from '../core/params.js';
import type { City } from '../city/City.js';
import { contourSegments } from '../terrain/heightfield.js';
import type { LotKind } from '../city/Lots.js';
import { UNBUILDABLE_VACANCY, UNSOLD_VACANCY, type VacancyReason } from '../building/types.js';

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
  | 'vacantUnsold'
  | 'vacantUnbuildable'
  | 'vacantAvoidable'
  | 'landUse'
  | 'useZones'
  | 'zoneFill'
  | 'useFill'
  | 'contours'
  | 'water'
  | 'growth';

const COLORS: Record<OverlayLayer, number> = {
  roads: 0x4aa3ff,
  blocks: 0xffd24a,
  lots: 0x63e08a,
  frontage: 0xff6b6b,
  buildable: 0xb07cff,
  footprints: 0xffffff,
  flagPoles: 0xff9f43,
  // Three colours, because the distinctions are the whole point: sand is a plot
  // that has not sold yet and will, grey is a scrap of land nothing belongs on
  // ever, red is a lot the generator failed to use.
  vacantUnsold: 0xd9a441,
  vacantUnbuildable: 0x9aa0a6,
  vacantAvoidable: 0xff2d55,
  // Legend colour only; these four are drawn per vertex.
  landUse: 0x63e08a,
  useZones: 0xffb03a,
  zoneFill: 0x9a6bff,
  useFill: 0x63e08a,
  contours: 0x8a8f6a,
  water: 0x4aa3ff,
  // Legend colour only; drawn per vertex from the generation.
  growth: 0xffd24a,
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
  vacantUnsold: 0.64,
  vacantUnbuildable: 0.65,
  vacantAvoidable: 0.66,
  landUse: 0.47,
  useZones: 0.3,
  // Below the line layers, so an outline drawn over a fill still reads.
  zoneFill: 0.12,
  useFill: 0.16,
  contours: 0.08,
  water: 0.2,
  growth: 0.38,
};

/**
 * Ground height under the overlay, set for the duration of a rebuild.
 *
 * Every layer here used to be drawn at a fixed y — 0.35 for roads, 0.6 for
 * footprints — which was exactly right on a flat world and useless on 26 m of
 * relief, where most of the town would be above its own outlines. The heights
 * above are now *offsets*, and this is what they are offset from. A module-level
 * hook rather than an argument threaded through six helpers: this is the debug
 * overlay, and the helpers are called once each per regeneration.
 */
let groundAt: (x: number, y: number) => number = () => 0;

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
    groundAt = (x, y) => city.terrain.heightAtXY(x, y);

    const roadSegs: number[] = [];
    for (const e of city.roads.edges) {
      const a = city.roads.graph.node(e.a).p;
      const b = city.roads.graph.node(e.b).p;
      const h = HEIGHTS.roads;
      roadSegs.push(a.x, groundAt(a.x, a.y) + h, a.y, b.x, groundAt(b.x, b.y) + h, b.y);
    }
    for (const lane of city.roads.privateLanes) {
      const la = groundAt(lane.a.x, lane.a.y) + HEIGHTS.roads;
      const lb = groundAt(lane.b.x, lane.b.y) + HEIGHTS.roads;
      roadSegs.push(lane.a.x, la, lane.a.y, lane.b.x, lb, lane.b.y);
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
        const hm = groundAt(f.mid.x, f.mid.y) + h;
        const ht = groundAt(tip.x, tip.y) + h;
        frontSegs.push(f.mid.x, hm, f.mid.y, tip.x, ht, tip.y);
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

    // Empty lots, in three layers rather than two. A lot with no building used
    // to be indistinguishable from ordinary ground — you could see the hole in
    // the block but not why it was there, or even whether the generator knew.
    // Two layers were then not enough either: "unavoidable" put the plot that
    // has not sold yet and the sliver no house could ever stand on under one
    // colour, and they are opposite facts. One of them fills in when the town
    // gets older, and looking at the overlay you could not tell which lots.
    const vacant = city.lots.filter((l) => l.kind === 'vacant');
    const inGroup = (l: (typeof vacant)[number], group: readonly VacancyReason[]): boolean =>
      l.vacancyReason !== null && group.includes(l.vacancyReason);
    const unsold = vacant.filter((l) => inGroup(l, UNSOLD_VACANCY));
    const unbuildable = vacant.filter((l) => inGroup(l, UNBUILDABLE_VACANCY));
    const avoidable = vacant.filter(
      (l) => !inGroup(l, UNSOLD_VACANCY) && !inGroup(l, UNBUILDABLE_VACANCY),
    );
    for (const [layer, lots] of [
      ['vacantUnsold', unsold],
      ['vacantUnbuildable', unbuildable],
      ['vacantAvoidable', avoidable],
    ] as const) {
      this.addLayer(layer, crossedRings(lots.map((l) => l.polygon), HEIGHTS[layer]));
    }

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

    // --- terrain and growth -------------------------------------------------
    // The three layers that make this generation's decisions visible. Contours
    // are the most useful thing in the file while tuning the land: the roads
    // are *supposed* to run along them, and whether they do is impossible to
    // judge from a shaded hillside.
    const field = city.terrain.field;
    if (field) {
      const contour: number[] = [];
      for (const [a, b] of contourSegments(field, 2)) {
        contour.push(
          a.x, groundAt(a.x, a.y) + HEIGHTS.contours, a.y,
          b.x, groundAt(b.x, b.y) + HEIGHTS.contours, b.y,
        );
      }
      this.addLayer('contours', contour);
    }

    this.addLayer(
      'water',
      ringSegments([...city.terrain.waterPolygons, ...city.terrain.bankPolygons], HEIGHTS.water),
    );

    // Roads coloured by the step that built them: dark at the station, bright
    // at the fringe. Debugging growth without this is guesswork.
    const maxGen = Math.max(1, ...city.roads.edges.map((e) => e.gen));
    const growthSegs: number[] = [];
    const growthCols: number[] = [];
    const gc = new THREE.Color();
    for (const e of city.roads.edges) {
      const a = city.roads.graph.node(e.a).p;
      const b = city.roads.graph.node(e.b).p;
      gc.setHSL(0.62 - 0.62 * Math.max(0, e.gen) / maxGen, 0.85, 0.55, THREE.SRGBColorSpace);
      const h = HEIGHTS.growth;
      growthSegs.push(a.x, groundAt(a.x, a.y) + h, a.y, b.x, groundAt(b.x, b.y) + h, b.y);
      growthCols.push(gc.r, gc.g, gc.b, gc.r, gc.g, gc.b);
    }
    this.addLayer('growth', growthSegs, growthCols);
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
          positions.push(p.x, groundAt(p.x, p.y) + h, p.y);
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
    out.push(minX, groundAt(minX, minY) + h, minY, maxX, groundAt(maxX, maxY) + h, maxY);
    out.push(minX, groundAt(minX, maxY) + h, maxY, maxX, groundAt(maxX, minY) + h, minY);
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
      positions.push(a.x, groundAt(a.x, a.y) + h, a.y, b.x, groundAt(b.x, b.y) + h, b.y);
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
      out.push(a.x, groundAt(a.x, a.y) + h, a.y, b.x, groundAt(b.x, b.y) + h, b.y);
    }
  }
  return out;
}
