import type { Vec2 } from '../core/types.js';
import type { CityParams, UseZone, ZoningParams } from '../core/params.js';
import { makeFbm, makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { maxInscribedCircle } from '../geom/polygon.js';
import type { Block } from './Blocks.js';
import type { Lot, LotFrontage, LotKind } from './Lots.js';
import { roadSamples, type RoadNetwork } from './Roads.js';

/**
 * Zoning is *derived*, not painted.
 *
 * An accessibility field plus hard geometric eligibility rules. The area and
 * frontage gates do the real work: a マンション physically cannot fit anywhere
 * except a large parcel with wide frontage on a wide road, and the subdivision
 * only produces those along arterials. Detached houses then fill the quiet
 * interiors on their own, with no clustering logic anywhere.
 */

export interface UrbanityField {
  at(p: Vec2): number;
  station: Vec2;
}

/** A simple uniform grid for nearest-sample queries. */
class PointGrid {
  private cells = new Map<number, Vec2[]>();
  private cell: number;

  constructor(points: Vec2[], cell = 40) {
    this.cell = cell;
    for (const p of points) {
      const k = this.key(p.x, p.y);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(p);
    }
  }

  private key(x: number, y: number): number {
    // Cantor-ish pairing on the cell indices; collisions merely cost a few extra
    // distance checks.
    const i = Math.floor(x / this.cell) + 4096;
    const j = Math.floor(y / this.cell) + 4096;
    return i * 8192 + j;
  }

  nearestDistance(p: Vec2, maxRings = 4): number {
    let best = Infinity;
    const ci = Math.floor(p.x / this.cell);
    const cj = Math.floor(p.y / this.cell);
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dj = -ring; dj <= ring; dj++) {
        for (let di = -ring; di <= ring; di++) {
          if (ring > 0 && Math.abs(di) !== ring && Math.abs(dj) !== ring) continue;
          const list = this.cells.get(this.key((ci + di) * this.cell, (cj + dj) * this.cell));
          if (!list) continue;
          for (const q of list) {
            const d = V.dist(p, q);
            if (d < best) best = d;
          }
        }
      }
      // One extra ring after the first hit, so a diagonal neighbour cannot win.
      if (best < ring * this.cell) break;
    }
    return best;
  }
}

const falloff = (d: number, radius: number): number =>
  d >= radius ? 0 : Math.pow(1 - d / radius, 1.35);

export function makeUrbanityField(net: RoadNetwork, params: CityParams): UrbanityField {
  const z = params.zoning;
  const arterial = new PointGrid(roadSamples(net, 'arterial', 10), 40);
  const collector = new PointGrid(roadSamples(net, 'collector', 12), 40);
  const noise = makeFbm(subSeed(params.seed, 'urbanity'), 2);
  const station = net.station;

  return {
    station,
    at(p: Vec2): number {
      const u =
        0.55 * falloff(V.dist(p, station), z.stationRadius) +
        0.3 * falloff(arterial.nearestDistance(p), z.arterialRadius) +
        0.15 * falloff(collector.nearestDistance(p), z.collectorRadius) +
        z.noiseWeight * noise(p.x / z.noiseScale, p.y / z.noiseScale) -
        0.075;
      return Math.min(1, Math.max(0, u));
    },
  };
}

/** What a gate gets to look at, computed once per lot. */
export interface LotContext {
  /** The widest frontage, whatever its class. */
  bestFrontage: number;
  /** Total frontage on an arterial or a collector. */
  wideFrontage: number;
  /** Class of the primary frontage. */
  primaryClass: LotFrontage['cls'];
  /** How far the lot runs back from its primary frontage, metres. */
  depth: number;
  /** Radius of the largest circle inscribed in the lot. */
  inradius: number;
}

const onWideRoad = (c: LotContext): boolean =>
  c.primaryClass === 'arterial' || c.primaryClass === 'collector';

interface UseGate {
  kind: LotKind;
  test(lot: Lot, z: ZoningParams, c: LotContext): boolean;
}

/**
 * The geometric eligibility rules, one per use.
 *
 * These are the *same* rules as before, only named. Zoning stays derived rather
 * than painted: a マンション can physically go nowhere except a large parcel with
 * wide frontage, and the subdivision only produces those along arterials — so no
 * rule here ever has to say where one goes.
 */
const GATE: Record<
  | 'mansion'
  | 'apart'
  | 'house'
  | 'shophouse'
  | 'shophouseCore'
  | 'zakkyo'
  | 'konbini'
  | 'factory'
  | 'warehouse',
  UseGate
> = {
  mansion: {
    kind: 'mansion',
    test: (lot, z, c) =>
      lot.area >= z.mansionMinArea &&
      c.wideFrontage >= z.mansionMinFrontage &&
      lot.urbanity > z.mansionMinUrbanity,
  },
  apart: {
    kind: 'apart',
    test: (lot, z, c) =>
      lot.area >= z.apartMinArea &&
      c.bestFrontage >= z.apartMinFrontage &&
      lot.urbanity >= z.apartUrbanityLo &&
      lot.urbanity <= z.apartUrbanityHi,
  },
  house: { kind: 'house', test: () => true },

  // 店舗併用住宅. A narrow parcel on a road worth having a shop on — which is
  // exactly what `neighbourCom`'s parcel grain produces, so the row falls out of
  // the subdivision rather than being placed.
  /**
   * 店舗併用住宅 in 商業地域 — the shape of the parcel is the whole test.
   *
   * Inside the downtown there is no second question to ask. The zone is already
   * the statement that this is where the shops are, and a 商業地域 whose back
   * streets came out as detached houses is not a downtown. Requiring high
   * urbanity here as well left twelve shops in the town, most of the commercial
   * district being houses.
   */
  shophouseCore: {
    kind: 'shophouse',
    test: (_lot, z, c) =>
      c.bestFrontage >= z.shophouseMinFrontage && c.bestFrontage <= z.shophouseMaxFrontage,
  },

  /**
   * 店舗併用住宅 in 近隣商業 — the shape, *and* a street worth opening on.
   *
   * 近隣商業 is a district; a 商店街 is a street. Without the second test the
   * shops spread over the whole district, which at this granularity is a fifth
   * of the map. With it they line the main roads through it and thin out behind,
   * which is what 近隣商業 actually looks like.
   */
  shophouse: {
    kind: 'shophouse',
    test: (lot, z, c) =>
      c.bestFrontage >= z.shophouseMinFrontage &&
      c.bestFrontage <= z.shophouseMaxFrontage &&
      (onWideRoad(c) || lot.urbanity >= z.shophouseMinUrbanity),
  },
  zakkyo: {
    kind: 'zakkyo',
    test: (lot, z, c) =>
      lot.area >= z.zakkyoMinArea && lot.urbanity > z.zakkyoMinUrbanity && c.bestFrontage >= 8,
  },
  // コンビニ. Wide, shallow and on a wide road: the shape is the whole
  // requirement, because the forecourt is most of the site. A deep parcel of the
  // same area is a different building entirely.
  konbini: {
    kind: 'konbini',
    test: (lot, z, c) =>
      lot.area >= z.konbiniMinArea &&
      onWideRoad(c) &&
      c.bestFrontage >= z.konbiniMinFrontage &&
      c.depth < c.bestFrontage * z.konbiniMaxDepthRatio,
  },
  factory: {
    kind: 'factory',
    test: (lot, z, c) => lot.area >= z.factoryMinArea && c.inradius >= z.industrialMinRadius,
  },
  // A 倉庫 wants the same shape as a 工場, only more of it. The inscribed-circle
  // test is what keeps a long thin remnant from becoming a shed: 1,600 m² of
  // 8 m wide strip is not a warehouse.
  warehouse: {
    kind: 'warehouse',
    test: (lot, z, c) => lot.area >= z.warehouseMinArea && c.inradius >= z.industrialMinRadius,
  },
};

/**
 * Which uses each 用途地域 will consider, most demanding first.
 *
 * A `Record` over `UseZone` rather than a lookup with a default: a zone that
 * nobody remembered to list is a compile error, not a district that silently
 * comes out as detached houses.
 *
 * The last entry of every list must be unconditional, or a lot in that zone has
 * no use at all.
 */
const ZONE_GATES: Record<UseZone, UseGate[]> = {
  // No マンション in 第一種低層住専: the 10 m absolute height limit is the whole
  // character of the zone, and expressing it as "the use is not available here"
  // is the same move as every other regulation in this generator.
  lowRise: [GATE.apart, GATE.house],
  midRise: [GATE.mansion, GATE.apart, GATE.house],
  neighbourCom: [GATE.konbini, GATE.mansion, GATE.zakkyo, GATE.shophouse, GATE.apart, GATE.house],
  commercial: [GATE.zakkyo, GATE.konbini, GATE.mansion, GATE.shophouseCore, GATE.apart, GATE.house],
  // 準工業 is the zone where a machine shop and a house are neighbours, and the
  // mixed list is the point of it rather than a compromise.
  // マンション belongs here too, and its absence was conspicuous: 準工業 is where
  // a great many real Japanese apartment blocks stand, and leaving it out of the
  // list took the town from thirteen マンション to two.
  quasiIndust: [GATE.warehouse, GATE.factory, GATE.konbini, GATE.mansion, GATE.apart, GATE.house],
  // The last entry has to be unconditional or a lot here gets no use at all —
  // and in 工業地域 that fallback should not be a house.
  industrial: [GATE.warehouse, GATE.factory, GATE.konbini, { kind: 'factory', test: () => true }],
};

export function assignZoning(
  lots: Lot[],
  blocks: Block[],
  urbanity: UrbanityField,
  params: CityParams,
): void {
  const z = params.zoning;

  for (const lot of lots) {
    lot.urbanity = urbanity.at(lot.centroid);

    const bestFrontage = lot.frontages[0]!;
    const wideFrontage = lot.frontages
      .filter((f) => f.cls === 'arterial' || f.cls === 'collector')
      .reduce((s, f) => s + f.len, 0);
    let depth = 0;
    for (const p of lot.polygon) {
      depth = Math.max(depth, V.dot(V.sub(p, bestFrontage.mid), V.neg(bestFrontage.outward)));
    }
    const ctx: LotContext = {
      bestFrontage: bestFrontage.len,
      wideFrontage,
      primaryClass: bestFrontage.cls,
      depth,
      inradius: maxInscribedCircle(lot.polygon, 0.5).radius,
    };

    lot.kind = lot.zonedKind = 'house';
    for (const gate of ZONE_GATES[lot.useZone]) {
      if (!gate.test(lot, z, ctx)) continue;
      lot.kind = lot.zonedKind = gate.kind;
      break;
    }
  }

  capKonbiniPerDistrict(lots, blocks, params);
  assignClusters(lots, blocks, params);
}

/**
 * Keep the convenience stores from clustering.
 *
 * The gate is purely geometric, and it has to be — that is what makes a コンビニ
 * a discovered consequence of a wide shallow parcel rather than something the
 * zoning placed. But a run of similar parcels along one arterial all qualify at
 * once, and five in a row is not a suburb, it is a joke.
 *
 * Rationing per district rather than by a coin flip keeps it deterministic and
 * order-independent: the best-scoring qualifying lots in each district keep the
 * use, the rest fall through to what they would otherwise have been. Score is
 * frontage — of two candidate sites the one with more road on it is the one that
 * gets built.
 */
function capKonbiniPerDistrict(lots: Lot[], blocks: Block[], params: CityParams): void {
  const districtOf = new Map<number, number>();
  for (const b of blocks) districtOf.set(b.id, b.districtId);

  const byDistrict = new Map<number, Lot[]>();
  for (const lot of lots) {
    if (lot.zonedKind !== 'konbini') continue;
    const d = districtOf.get(lot.blockId) ?? -1;
    let list = byDistrict.get(d);
    if (!list) byDistrict.set(d, (list = []));
    list.push(lot);
  }

  for (const list of byDistrict.values()) {
    if (list.length <= params.zoning.konbiniPerDistrict) continue;
    const ranked = list
      .slice()
      .sort((a, b) => (b.frontages[0]?.len ?? 0) - (a.frontages[0]?.len ?? 0) || a.id - b.id);
    for (const lot of ranked.slice(params.zoning.konbiniPerDistrict)) {
      // Fall through the rest of the zone's ladder, skipping the gate that just
      // won, so a demoted site becomes whatever it would have been without it.
      lot.kind = lot.zonedKind = 'house';
      const ctx = contextFor(lot);
      for (const gate of ZONE_GATES[lot.useZone]) {
        if (gate.kind === 'konbini' || !gate.test(lot, params.zoning, ctx)) continue;
        lot.kind = lot.zonedKind = gate.kind;
        break;
      }
    }
  }
}

function contextFor(lot: Lot): LotContext {
  const best = lot.frontages[0]!;
  let depth = 0;
  for (const p of lot.polygon) {
    depth = Math.max(depth, V.dot(V.sub(p, best.mid), V.neg(best.outward)));
  }
  return {
    bestFrontage: best.len,
    wideFrontage: lot.frontages
      .filter((f) => f.cls === 'arterial' || f.cls === 'collector')
      .reduce((s, f) => s + f.len, 0),
    primaryClass: best.cls,
    depth,
    inradius: maxInscribedCircle(lot.polygon, 0.5).radius,
  };
}

/**
 * 分譲地 clusters: runs of 3–8 adjacent lots that will share a style vector.
 *
 * This deliberately *reintroduces* near-repetition, because that is what real
 * Japanese suburbs look like — five identical developer-built houses, then an
 * older varied stretch, then another run. It also makes the repetition that
 * remains read as intentional rather than as a bug.
 */
function assignClusters(lots: Lot[], blocks: Block[], params: CityParams): void {
  const rng = makeRng(subSeed(params.seed, 'clusters'));
  const byBlock = new Map<number, Lot[]>();
  for (const lot of lots) {
    let list = byBlock.get(lot.blockId);
    if (!list) byBlock.set(lot.blockId, (list = []));
    list.push(lot);
  }

  let nextCluster = 0;
  for (const block of blocks) {
    const group = byBlock.get(block.id);
    if (!group) continue;

    // Order lots around the block by the angle of their centroid, so "adjacent"
    // means adjacent along the street rather than adjacent in creation order.
    const ordered = group
      .map((l) => ({ l, a: Math.atan2(l.centroid.y - block.centroid.y, l.centroid.x - block.centroid.x) }))
      .sort((x, y) => x.a - y.a)
      .map((x) => x.l);

    let cluster = nextCluster++;
    let runLength = 0;
    let previous: LotKind | null = null;
    for (const lot of ordered) {
      // Only same-kind neighbours belong to the same development.
      //
      // This is what the line above has always claimed and never did: the cut
      // rule looked at run length alone. With three uses, all residential, that
      // was harmless — a house and the apartment beside it plausibly went up
      // together. It stops being harmless the moment a factory and a house can
      // be neighbours, because a cluster is a *shared style vector*, and sharing
      // one across that boundary means a 工場 built to the era and wealth of the
      // house next door.
      const kindChanged = previous !== null && previous !== lot.kind;
      const cut =
        kindChanged || runLength >= 8 || (runLength >= 3 && rng.chance(params.zoning.clusterCutChance));
      if (cut) {
        cluster = nextCluster++;
        runLength = 0;
      }
      lot.clusterId = cluster;
      previous = lot.kind;
      runLength++;
    }
    nextCluster++;
  }
}
