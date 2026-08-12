import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '../src/core/params.js';
import { generateRoads } from '../src/city/Roads.js';
import { extractBlocks } from '../src/city/Blocks.js';
import { subdivideBlock, type Lot } from '../src/city/Lots.js';
import { area, isSimple, isCCW } from '../src/geom/polygon.js';
import { intersectPoly, multiArea } from '../src/geom/boolean.js';
import { findNonPlanarCrossings } from '../src/geom/planarGraph.js';

/**
 * Subdivision invariants. This is the most valuable test in the project: every
 * downstream stage inherits the quality of the lot polygons, and a violation
 * here shows up much later as a building with a NaN wall.
 */

function buildLots(seed: string) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  params.roads.extent = 190; // smaller town keeps the test fast
  const roads = generateRoads(params.seed, params.roads, params.landUse);
  const { blocks } = extractBlocks(roads, params.seed);
  const lots: Lot[] = [];
  for (const b of blocks) lots.push(...subdivideBlock(b, roads, params, lots.length));
  return { params, roads, blocks, lots };
}

describe('road network', () => {
  it('is planar after generation', () => {
    const { roads } = buildLots('planar-1');
    // makePlanar splits every crossing; anything left would break face extraction.
    expect(findNonPlanarCrossings(roads.graph)).toEqual([]);
  });

  it('produces blocks', () => {
    const { blocks } = buildLots('blocks-1');
    expect(blocks.length).toBeGreaterThan(8);
    for (const b of blocks) {
      expect(isSimple(b.polygon)).toBe(true);
      expect(isCCW(b.polygon)).toBe(true);
      expect(b.area).toBeGreaterThan(199);
    }
  });
});

describe('lot subdivision invariants', () => {
  const seeds = ['inv-1', 'inv-2', 'inv-3'];

  it('produces a meaningful number of lots', () => {
    for (const seed of seeds) {
      const { lots } = buildLots(seed);
      expect(lots.length, `seed ${seed}`).toBeGreaterThan(60);
    }
  });

  it('every lot polygon is simple, CCW and above the minimum area', () => {
    for (const seed of seeds) {
      const { params, lots } = buildLots(seed);
      for (const lot of lots) {
        expect(lot.polygon.length, `lot ${lot.id} vertex count`).toBeGreaterThanOrEqual(3);
        expect(isCCW(lot.polygon), `lot ${lot.id} winding`).toBe(true);
        expect(isSimple(lot.polygon), `lot ${lot.id} simplicity`).toBe(true);
        expect(lot.area, `lot ${lot.id} area`).toBeGreaterThanOrEqual(params.lots.minLotArea - 1e-6);
        for (const p of lot.polygon) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
      }
    }
  });

  /**
   * 接道義務 is 2 m. It is no longer a hard invariant here: `minFrontage` sits
   * below the legal figure on purpose, so the scrap a road widening left behind
   * survives as ground instead of becoming a hole in the city. Real suburbs
   * carry the same thing — 未接道 parcels, usually with an old house still on
   * them — but they are the exception, so this asserts the proportion.
   */
  it('every lot fronts a street, and nearly all meet 接道義務', () => {
    for (const seed of seeds) {
      const { params, lots } = buildLots(seed);
      let legal = 0;
      for (const lot of lots) {
        expect(lot.frontages.length, `lot ${lot.id} has no frontage`).toBeGreaterThan(0);
        const best = Math.max(...lot.frontages.map((f) => f.len));
        expect(best, `lot ${lot.id} frontage length`).toBeGreaterThanOrEqual(params.lots.minFrontage);
        if (best >= 2.0) legal++;
      }
      expect(legal / lots.length, `seed ${seed}`).toBeGreaterThan(0.95);
    }
  });

  it('lots within a block do not meaningfully overlap', () => {
    const { blocks, lots } = buildLots('overlap-1');
    const byBlock = new Map<number, typeof lots>();
    for (const l of lots) {
      const list = byBlock.get(l.blockId) ?? [];
      list.push(l);
      byBlock.set(l.blockId, list);
    }
    for (const b of blocks) {
      const group = byBlock.get(b.id) ?? [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const overlap = multiArea(intersectPoly([group[i]!.polygon], [group[j]!.polygon]));
          expect(overlap, `lots ${group[i]!.id}/${group[j]!.id} overlap`).toBeLessThan(0.5);
        }
      }
    }
  });

  it('lots stay inside their block', () => {
    const { blocks, lots } = buildLots('inside-1');
    const blockById = new Map(blocks.map((b) => [b.id, b]));
    for (const lot of lots) {
      const b = blockById.get(lot.blockId)!;
      const inside = multiArea(intersectPoly([lot.polygon], [b.polygon]));
      expect(inside / area(lot.polygon), `lot ${lot.id} escapes its block`).toBeGreaterThan(0.97);
    }
  });
});

describe('determinism', () => {
  it('the same seed produces identical lots', () => {
    const a = buildLots('det-1').lots;
    const b = buildLots('det-1').lots;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.polygon).toEqual(b[i]!.polygon);
    }
  });

  it('a different seed produces different lots', () => {
    const a = buildLots('det-1').lots;
    const b = buildLots('det-2').lots;
    const key = (ls: typeof a) => ls.map((l) => l.polygon.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';')).join('|');
    expect(key(a)).not.toBe(key(b));
  });
});
