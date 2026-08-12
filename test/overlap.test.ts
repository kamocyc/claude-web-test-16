import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  applyRoadLayout,
  cloneParams,
  type RoadLayout,
} from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import type { Polygon, Vec2 } from '../src/core/types.js';
import * as V from '../src/geom/vec2.js';
import { area } from '../src/geom/polygon.js';
import { differencePoly, multiArea, intersectPoly } from '../src/geom/boolean.js';
import { UNAVOIDABLE_VACANCY } from '../src/building/types.js';

/**
 * Buildings must not stand on roads, and lots must not be left empty without a
 * reason.
 *
 * Neither of these had any test at all. Nothing intersected a building with a
 * road — the nearest checks were lots-inside-their-block, which for a dead-end
 * street is exactly the wrong containment (the street lies *inside* the block,
 * so a house built on top of it passes), and footprint-inside-its-envelope,
 * which never looks at asphalt.
 */

const LAYOUTS: RoadLayout[] = ['district', 'grid'];
const SEEDS = ['ov-1', 'ov-2'];

/**
 * The road surface as it is actually drawn.
 *
 * This has to mirror `props/Ground.ts` `addRibbon` exactly, including the
 * overshoot past a junction and the rule that a dead end and a private lane do
 * not get one. A test that used bare a-to-b rectangles would agree with the
 * generator's intent instead of with its output, and miss the two defects most
 * likely to occur.
 */
function ribbon(a: Vec2, b: Vec2, width: number, extend: { start: boolean; end: boolean }): Polygon | null {
  const d = V.sub(b, a);
  const l = V.len(d);
  if (l < 0.2) return null;
  const dir = V.scale(d, 1 / l);
  const n = V.perp(dir);
  const half = width / 2;
  const over = half * 0.9;
  const a2 = V.addScaled(a, dir, extend.start ? -over : 0);
  const b2 = V.addScaled(b, dir, extend.end ? over : 0);
  return [
    V.addScaled(a2, n, -half),
    V.addScaled(b2, n, -half),
    V.addScaled(b2, n, half),
    V.addScaled(a2, n, half),
  ];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boxOf = (poly: Polygon): Box => ({
  minX: Math.min(...poly.map((p) => p.x)),
  minY: Math.min(...poly.map((p) => p.y)),
  maxX: Math.max(...poly.map((p) => p.x)),
  maxY: Math.max(...poly.map((p) => p.y)),
});

const disjoint = (a: Box, b: Box): boolean =>
  a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;

/**
 * How much of `poly` is road.
 *
 * Measured by subtraction — what is left of the polygon once every nearby
 * ribbon is taken off it — rather than by intersection. The ribbons overlap
 * each other at every junction, so they are not a valid multipolygon: handing
 * them to the clipper as one double-counts the shared corners, and unioning
 * them first is worse, because a union that fails returns its input unchanged
 * and the intersection then reports a whole building as asphalt. Difference
 * unions its clip set internally, and if it fails it returns the subject
 * untouched — which reads as zero overlap, so a broken oracle stays quiet
 * instead of crying wolf.
 */
function roadAreaUnder(poly: Polygon, roads: { poly: Polygon; box: Box }[]): number {
  const box = boxOf(poly);
  const near = roads.filter((r) => !disjoint(box, r.box)).map((r) => r.poly);
  if (near.length === 0) return 0;
  return Math.max(0, area(poly) - multiArea(differencePoly([poly], near)));
}

function roadSurfaces(city: ReturnType<typeof generateCity>): Polygon[] {
  const degree = new Map<number, number>();
  for (const e of city.roads.edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const out: Polygon[] = [];
  for (const e of city.roads.edges) {
    const r = ribbon(city.roads.graph.node(e.a).p, city.roads.graph.node(e.b).p, e.width, {
      start: (degree.get(e.a) ?? 0) > 1,
      end: (degree.get(e.b) ?? 0) > 1,
    });
    if (r) out.push(r);
  }
  for (const lane of city.roads.privateLanes) {
    const r = ribbon(lane.a, lane.b, lane.width, { start: false, end: false });
    if (r) out.push(r);
  }
  return out;
}

function meshCity(seed: string, layout: RoadLayout) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  params.roads.extent = 190;
  const city = generateCity(params);
  // Deciding what stands on each lot needs no materials and no DOM — that is
  // the point of `planBuildings` being separate from mesh building.
  const plan = planBuildings(city, params);
  return { params, city, plan };
}

describe('buildings and roads', () => {
  for (const layout of LAYOUTS) {
    for (const seed of SEEDS) {
      it(`no building stands on a road (${layout}, ${seed})`, () => {
        const { city, plan } = meshCity(seed, layout);
        const roads = roadSurfaces(city).map((poly) => ({ poly, box: boxOf(poly) }));

        const bad: string[] = [];
        for (const b of plan.buildings) {
          const onRoad = roadAreaUnder(b.footprint.outline, roads);
          // A hair of overlap is the boolean's own rounding, not a house in the
          // carriageway; a tenth of a square metre is well below one vertex of
          // slop on a 100 m² footprint.
          if (onRoad > 0.1) {
            bad.push(
              `lot ${b.lot.id}: ${onRoad.toFixed(2)} m² of a ` +
                `${b.footprint.area.toFixed(0)} m² footprint is on asphalt ` +
                `(${((onRoad / b.footprint.area) * 100).toFixed(1)}%)`,
            );
          }
        }
        bad.sort();
        expect(bad.slice(0, 5), `${bad.length} buildings overlapping a road`).toEqual([]);
      }, 60000);

      it(`no lot is laid over a road (${layout}, ${seed})`, () => {
        const { city } = meshCity(seed, layout);
        const roads = roadSurfaces(city).map((poly) => ({ poly, box: boxOf(poly) }));

        // The lot boundary is where the fences, gates and parking go, so land
        // taken by asphalt has to come off the lot too, not merely off the
        // building. This is the check that catches a dead-end street running
        // through a block the subdivider knew nothing about.
        const bad: string[] = [];
        for (const lot of city.lots) {
          const onRoad = roadAreaUnder(lot.polygon, roads);
          if (onRoad > lot.area * 0.05 + 0.5) {
            bad.push(
              `lot ${lot.id}: ${onRoad.toFixed(1)} m² of ${lot.area.toFixed(0)} m² is road`,
            );
          }
        }
        bad.sort();
        expect(bad.slice(0, 5), `${bad.length} lots overlapping a road`).toEqual([]);
      }, 60000);
    }
  }
});

describe('empty lots', () => {
  for (const layout of LAYOUTS) {
    it(`every empty lot says why (${layout})`, () => {
      const { city, plan } = meshCity('vac-1', layout);
      const vacant = city.lots.filter((l) => l.kind === 'vacant');

      // The point of the reason is that it exists. A lot with no building and
      // no explanation is indistinguishable from a bug, and used to be one:
      // `buildBuilding` returned a bare null and the renderer dropped it.
      const unexplained = vacant.filter((l) => l.vacancyReason === null);
      expect(unexplained.length, 'vacant lots carrying no reason').toBe(0);

      // 'not-attempted' means a lot was never offered a building at all.
      expect(plan.vacancyReasons['not-attempted'] ?? 0).toBe(0);

      // Parcels the fringe has simply not sold yet are excluded from the
      // budget. They are a decision — see `VacancyReason.not-yet-developed` —
      // and counting them here would turn "how much land did the generator fail
      // to use?" into "how young is the edge of the town?", which is a knob.
      const share =
        vacant.filter((l) => l.vacancyReason !== 'not-yet-developed').length / city.lots.length;
      const avoidable = vacant.filter(
        (l) => l.vacancyReason && !UNAVOIDABLE_VACANCY.includes(l.vacancyReason),
      );
      // Reported rather than merely asserted: the breakdown is what tells you
      // whether a regression is more empty land or a different kind of it.
      const breakdown = JSON.stringify(plan.vacancyReasons);
      // 5%, raised from 4% when the town started growing rather than being
      // placed. A grown district is bounded by roads that negotiated with a
      // hillside, so it is less rectangular than one cut by a straight arterial,
      // and a few more of its parcels come out as slivers. That is honest — the
      // gate that matters is `avoidable` below, which is unchanged.
      expect(share, `${vacant.length}/${city.lots.length} lots empty ${breakdown}`).toBeLessThan(
        0.05,
      );
      expect(
        avoidable.length / city.lots.length,
        `avoidable empties ${breakdown}`,
      ).toBeLessThan(0.02);
    });
  }
});

describe('lot area', () => {
  it('lots do not claim land twice', () => {
    // A guard on the interior-road change: subdividing every piece of a block
    // rather than only the largest must not let two pieces claim the same land.
    const { city } = meshCity('area-1', 'district');
    const byBlock = new Map<number, typeof city.lots>();
    for (const lot of city.lots) {
      const list = byBlock.get(lot.blockId) ?? [];
      list.push(lot);
      byBlock.set(lot.blockId, list);
    }
    const bad: string[] = [];
    for (const [blockId, lots] of byBlock) {
      for (let i = 0; i < lots.length; i++) {
        for (let j = i + 1; j < lots.length; j++) {
          const ov = multiArea(intersectPoly([lots[i]!.polygon], [lots[j]!.polygon]));
          if (ov > 0.5) {
            bad.push(`block ${blockId}: lots ${lots[i]!.id}/${lots[j]!.id} share ${ov.toFixed(1)} m²`);
          }
        }
      }
    }
    expect(bad.slice(0, 5), `${bad.length} overlapping lot pairs`).toEqual([]);
    expect(area(city.blocks[0]!.polygon)).toBeGreaterThan(0);
  }, 60000);
});
