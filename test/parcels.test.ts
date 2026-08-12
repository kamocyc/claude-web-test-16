import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { minAreaObb } from '../src/geom/obb.js';
import { differencePoly, multiArea } from '../src/geom/boolean.js';
import * as V from '../src/geom/vec2.js';
import type { Polygon, Vec2 } from '../src/core/types.js';

/**
 * The proportion of a parcel, and whether the block it came out of was used up.
 *
 * Reported by eye — "長細い建物が多い" — and until now measured nowhere. The
 * suite had a floor on how *narrow* a building may be (`shapes.test.ts`,
 * "no footprint is a corridor") but nothing at all on how long it may be for
 * that width, so a town of 4.5 m × 15 m houses passed everything.
 *
 * It was one: the median parcel was 7.8 m by 20.8 m. The street grid was spaced
 * at 40–66 m and the lots were drawn 13.5 m deep, two numbers with no relation
 * to each other, so a block gave 34–60 m of usable depth where two rows of lots
 * needed 27. The difference had to go somewhere — the lots stretched to fill it,
 * a third of the town ended up behind a 私道 dug into the leftover, and what
 * neither of those absorbed was abandoned as bare ground.
 *
 * `city/LotModule.ts` now derives the grid from the plot instead, and
 * `Lots.rowDepth` fits the row to the block it actually got. These are the
 * numbers that says so.
 */

const LAYOUTS: RoadLayout[] = ['district', 'grid'];
const SEEDS = ['par-1', 'par-3'];

function town(seed: string, layout: RoadLayout, extent = 190) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  params.roads.extent = extent;
  const city = generateCity(params);
  return { params, city, plan: planBuildings(city, params) };
}

/** Long side over short side of the tightest enclosing rectangle. */
function aspect(poly: Polygon): number {
  const o = minAreaObb(poly);
  return Math.max(o.rect.w, o.rect.d) / Math.max(0.01, Math.min(o.rect.w, o.rect.d));
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? NaN;
};

const share = (xs: number[], over: number): number => xs.filter((x) => x > over).length / xs.length;

/** A road's footprint, a little wider than the carriageway to cover the gutter. */
function roadStrip(a: Vec2, b: Vec2, width: number): Polygon | null {
  const d = V.sub(b, a);
  const l = V.len(d);
  if (l < 0.2) return null;
  const dir = V.scale(d, 1 / l);
  const n = V.perp(dir);
  const h = width / 2;
  const a2 = V.addScaled(a, dir, -h);
  const b2 = V.addScaled(b, dir, h);
  return [V.addScaled(a2, n, -h), V.addScaled(b2, n, -h), V.addScaled(b2, n, h), V.addScaled(a2, n, h)];
}

describe('parcel proportion', () => {
  for (const layout of LAYOUTS) {
    it(`the typical parcel is not long and thin (${layout})`, () => {
      const asp = SEEDS.flatMap((seed) => town(seed, layout).city.lots.map((l) => aspect(l.polygon)));
      expect(asp.length).toBeGreaterThan(400);

      // A Japanese suburban plot is half again as deep as it is wide, give or
      // take — the module aims at 9.6 m by 12.8 m. Twice as long as it is wide
      // is already a plot that will only take a narrow house; the bound is set
      // above that so the corner parcels and the odd block end have room, and
      // well below the 2.22 this measured before.
      expect(median(asp), `median parcel aspect ${median(asp).toFixed(2)}`).toBeLessThan(1.75);

      // And the tail. 2.5:1 on a 120 m² plot is 6.9 m by 17.3 m — the shape that
      // was reported. Some of these are real: a 店舗併用住宅 on a 商店街 has a
      // narrow 間口 by design, and a leftover behind a bent street is a leftover.
      // Nearly a quarter of the town was not.
      const thin = share(asp, 2.5);
      expect(thin, `${(thin * 100).toFixed(0)}% of parcels are over 2.5:1`).toBeLessThan(0.2);
    }, 60000);

    it(`buildings inherit that proportion (${layout})`, () => {
      // The parcel decides the building, so this is mostly the test above seen
      // one stage later — but only mostly, and the gap is the point. A footprint
      // can be squarer than its plot (the setbacks and the parking space come
      // off the ends) or longer (a 敷地いっぱい plan on a shallow plot). What
      // must not happen is the plot being fine and the house coming out a
      // corridor anyway.
      const asp = SEEDS.flatMap((seed) =>
        town(seed, layout).plan.buildings.map((b) => aspect(b.footprint.outline)),
      );
      expect(asp.length).toBeGreaterThan(300);
      expect(median(asp), `median footprint aspect ${median(asp).toFixed(2)}`).toBeLessThan(1.95);
      expect(share(asp, 2.5), 'share of footprints over 2.5:1').toBeLessThan(0.28);
    }, 120000);
  }
});

describe('block efficiency', () => {
  for (const layout of LAYOUTS) {
    it(`almost all the land in a block is sold as lots (${layout})`, () => {
      // 区画の道路はあくまで建物のためである. Land inside a block that is neither
      // road nor lot is land the layout wasted, and it is invisible in every
      // other test in the suite: the town is still valid, the lots are still
      // well formed, there is just a strip of nothing down the middle of every
      // block. Which is exactly what there used to be.
      // At the shipped extent: a 190 m town has too few whole blocks in it for
      // the ratio to say much, and it was the only measure here that could not
      // tell the old layout from the new one at that size.
      const { city } = town('par-2', layout, DEFAULT_PARAMS.roads.extent);

      const roads: Polygon[] = [];
      for (const e of city.roads.edges) {
        const s = roadStrip(city.roads.graph.node(e.a).p, city.roads.graph.node(e.b).p, e.width + 1);
        if (s) roads.push(s);
      }
      for (const lane of city.roads.privateLanes) {
        const s = roadStrip(lane.a, lane.b, lane.width + 1);
        if (s) roads.push(s);
      }

      const lotArea = new Map<number, number>();
      for (const l of city.lots) lotArea.set(l.blockId, (lotArea.get(l.blockId) ?? 0) + l.area);

      let usable = 0;
      let sold = 0;
      for (const b of city.blocks) {
        // A block face is bounded by road *centrelines*, so half a carriageway
        // all the way round is inside it and was never developable.
        usable += multiArea(differencePoly([b.polygon], roads));
        sold += lotArea.get(b.id) ?? 0;
      }

      const used = sold / usable;
      expect(used, `${(used * 100).toFixed(1)}% of the buildable land in blocks became lots`)
        .toBeGreaterThan(0.82);
    }, 120000);
  }
});
