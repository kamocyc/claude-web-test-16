import type { Vec2 } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import { makeFbm, makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import type { Block } from './Blocks.js';
import type { Lot } from './Lots.js';
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

    if (
      lot.area >= z.mansionMinArea &&
      wideFrontage >= z.mansionMinFrontage &&
      lot.urbanity > z.mansionMinUrbanity
    ) {
      lot.kind = 'mansion';
    } else if (
      lot.area >= z.apartMinArea &&
      bestFrontage.len >= z.apartMinFrontage &&
      lot.urbanity >= z.apartUrbanityLo &&
      lot.urbanity <= z.apartUrbanityHi
    ) {
      lot.kind = 'apart';
    } else {
      lot.kind = 'house';
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
    for (const lot of ordered) {
      // Only same-kind neighbours belong to the same development.
      const cut = runLength >= 8 || (runLength >= 3 && rng.chance(params.zoning.clusterCutChance));
      if (cut) {
        cluster = nextCluster++;
        runLength = 0;
      }
      lot.clusterId = cluster;
      runLength++;
    }
    nextCluster++;
  }
}
