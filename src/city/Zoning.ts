import type { Vec2 } from '../core/types.js';
import type { CityParams, UseZone, ZoningParams } from '../core/params.js';
import { makeFbm, makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
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
}

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
const GATE: Record<'mansion' | 'apart' | 'house', UseGate> = {
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
  lowRise: [GATE.mansion, GATE.apart, GATE.house],
  midRise: [GATE.mansion, GATE.apart, GATE.house],
  neighbourCom: [GATE.mansion, GATE.apart, GATE.house],
  commercial: [GATE.mansion, GATE.apart, GATE.house],
  quasiIndust: [GATE.mansion, GATE.apart, GATE.house],
  industrial: [GATE.mansion, GATE.apart, GATE.house],
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
    const ctx: LotContext = {
      bestFrontage: bestFrontage.len,
      wideFrontage,
      primaryClass: bestFrontage.cls,
    };

    lot.kind = lot.zonedKind = 'house';
    for (const gate of ZONE_GATES[lot.useZone]) {
      if (!gate.test(lot, z, ctx)) continue;
      lot.kind = lot.zonedKind = gate.kind;
      break;
    }
  }

  assignClusters(lots, blocks, params);
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
