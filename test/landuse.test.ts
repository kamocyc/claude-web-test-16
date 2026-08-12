import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout, type UseZone } from '../src/core/params.js';
import { generateRoads } from '../src/city/Roads.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { districtAdjacency } from '../src/city/LandUse.js';
import { districtCentroid, type District } from '../src/city/RoadDistricts.js';
import * as V from '../src/geom/vec2.js';

/**
 * 用途地域 invariants.
 *
 * These are the properties the flood fill exists to guarantee. A threshold on a
 * scalar field satisfies none of them — that is the whole argument — so if any
 * of these ever goes red, the assignment has quietly become a threshold again.
 */

const SEEDS = ['sakura-3', 'kaede-11', 'hinode-7', 'midori-42', 'asagao-5', 'yanagi-88'];
const LAYOUTS: RoadLayout[] = ['district', 'grid'];

function town(seed: string, layout: RoadLayout) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  const net = generateRoads(params.seed, params.roads, params.landUse);
  return { params, net, adj: districtAdjacency(net.districts) };
}

const indicesOf = (districts: District[], zone: UseZone): number[] =>
  districts.map((d, i) => (d.zone === zone ? i : -1)).filter((i) => i >= 0);

describe('land use', () => {
  it('makes the industrial belt one connected piece', () => {
    for (const layout of LAYOUTS) {
      for (const seed of SEEDS) {
        const { net, adj } = town(seed, layout);
        const industrial = new Set(indicesOf(net.districts, 'industrial'));
        if (industrial.size === 0) continue;

        const stack = [[...industrial][0]!];
        const seen = new Set(stack);
        while (stack.length > 0) {
          for (const j of adj[stack.pop()!]!) {
            if (!industrial.has(j) || seen.has(j)) continue;
            seen.add(j);
            stack.push(j);
          }
        }
        expect(seen.size, `${layout}/${seed}: industrial belt is in pieces`).toBe(industrial.size);
      }
    }
  }, 60000);

  it('keeps industry away from the station', () => {
    for (const layout of LAYOUTS) {
      for (const seed of SEEDS) {
        const { params, net } = town(seed, layout);
        for (const d of net.districts) {
          if (d.zone !== 'industrial') continue;
          const dist = V.dist(districtCentroid(d), net.station);
          // Centroid, not nearest boundary point. The districts are hundreds of
          // metres across, so no district's whole boundary is ever this far from
          // the station — measured at extent 320 the furthest any of them gets
          // is 217 m in the grid layout. A boundary rule designates nothing.
          expect(
            dist,
            `${layout}/${seed}: industrial district ${d.id} sits ${dist.toFixed(0)} m from the station`,
          ).toBeGreaterThanOrEqual(params.landUse.industrialMinStationDist - 1);
        }
      }
    }
  }, 60000);

  it('never lets a factory share a boundary with the shops', () => {
    for (const layout of LAYOUTS) {
      for (const seed of SEEDS) {
        const { net, adj } = town(seed, layout);
        for (let i = 0; i < net.districts.length; i++) {
          if (net.districts[i]!.zone !== 'industrial') continue;
          for (const j of adj[i]!) {
            const z = net.districts[j]!.zone;
            expect(
              z === 'commercial' || z === 'neighbourCom',
              `${layout}/${seed}: industrial district ${i} abuts ${z} district ${j}`,
            ).toBe(false);
          }
        }
      }
    }
  }, 60000);

  it('designates a downtown, and only one', () => {
    for (const layout of LAYOUTS) {
      for (const seed of SEEDS) {
        const { net } = town(seed, layout);
        const cores = indicesOf(net.districts, 'commercial');
        expect(cores.length, `${layout}/${seed}: ${cores.length} commercial districts`).toBe(1);
      }
    }
  }, 60000);

  it('gives the industrial belt roughly the share it was asked for', () => {
    for (const layout of LAYOUTS) {
      for (const seed of SEEDS) {
        const { params, net } = town(seed, layout);
        const area = net.districts
          .filter((d) => d.zone === 'industrial')
          .reduce((s, d) => s + d.area, 0);
        const share = area / Math.pow(2 * params.roads.extent, 2);
        const target = params.landUse.industrialShare;
        // Wide bounds on purpose. The fill can only take whole districts, and
        // they are very uneven — it stops short when the next one would overshoot
        // the ceiling, and lands over when the seed alone is large. What this
        // catches is the two real failures: designating nothing, and designating
        // half the town.
        expect(share, `${layout}/${seed}: industrial share ${(share * 100).toFixed(1)}%`).toBeGreaterThan(
          target * 0.5,
        );
        expect(share, `${layout}/${seed}: industrial share ${(share * 100).toFixed(1)}%`).toBeLessThan(
          target * 1.6,
        );
      }
    }
  }, 60000);

  it('actually builds every use it defines', () => {
    // At the shipped extent, in both layouts. A gate that quietly stops firing —
    // a threshold drifting past what the subdivision can produce — breaks no
    // other invariant in the suite: the town is still valid, it has just lost a
    // whole category of building, and nothing would say so.
    for (const layout of LAYOUTS) {
      const params = cloneParams(DEFAULT_PARAMS);
      applyRoadLayout(params.roads, layout);
      const city = generateCity(params);
      const counts: Record<string, number> = {};
      for (const l of city.lots) counts[l.zonedKind] = (counts[l.zonedKind] ?? 0) + 1;

      const n = city.lots.length;
      const atLeast = (kind: string, min: number) =>
        expect(counts[kind] ?? 0, `${layout}: ${kind} = ${counts[kind] ?? 0} of ${n} lots`).toBeGreaterThanOrEqual(min);
      atLeast('house', Math.floor(n * 0.2));
      atLeast('apart', 10);
      atLeast('shophouse', 8);
      atLeast('zakkyo', 3);
      atLeast('konbini', 1);
      atLeast('factory', 3);
      atLeast('warehouse', 3);
    }
  }, 120000);

  it('leaves every コンビニ a forecourt to park in', () => {
    // The car park is not decoration on one of these — it is most of the site,
    // and the shop being pushed to the back of the plot is the whole reason the
    // building type looks the way it does. A コンビニ with its glazing on the
    // pavement is a different building from a different decade.
    for (const layout of LAYOUTS) {
      const params = cloneParams(DEFAULT_PARAMS);
      applyRoadLayout(params.roads, layout);
      const city = generateCity(params);
      const plan = planBuildings(city, params);

      for (const b of plan.buildings) {
        if (b.spec.kind !== 'konbini') continue;
        const f = b.lot.frontages[0]!;
        const inward = V.neg(f.outward);
        let clear = Infinity;
        for (const p of b.footprint.outline) clear = Math.min(clear, V.dot(V.sub(p, f.mid), inward));
        expect(clear, `${layout}: konbini on lot ${b.lot.id} stands ${clear.toFixed(1)} m off the street`)
          .toBeGreaterThan(2.5);
        expect(
          b.lot.area - b.footprint.area,
          `${layout}: konbini on lot ${b.lot.id} has no open ground`,
        ).toBeGreaterThan(60);
      }
    }
  }, 120000);

  it('is deterministic, and does vary by seed', () => {
    const zonesOf = (seed: string) =>
      town(seed, 'district').net.districts.map((d) => d.zone).join(',');
    expect(zonesOf('sakura-3')).toBe(zonesOf('sakura-3'));
    expect(zonesOf('sakura-3')).not.toBe(zonesOf('kaede-11'));
  }, 60000);
});
