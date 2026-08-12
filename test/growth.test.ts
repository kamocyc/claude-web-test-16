import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import * as V from '../src/geom/vec2.js';

/**
 * That the town grew, rather than merely being irregular.
 *
 * "Grew" is a claim with consequences, and these are them: the middle is built
 * up more than the edge, the newest estates are not sold out, a longer history
 * leaves a finer partition, and the whole thing is one connected place. None of
 * those is visible in a screenshot with any confidence, which is why they are
 * here.
 */

function grown(seed: string, steps = DEFAULT_PARAMS.roads.growth.steps, extent = 190) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, 'district');
  params.roads.extent = extent;
  params.roads.growth.steps = steps;
  return { params, city: generateCity(params) };
}

/** Chebyshev radius — the town is a square, so its "distance out" is too. */
const radius = (p: { x: number; y: number }): number => Math.max(Math.abs(p.x), Math.abs(p.y));

describe('a grown town', () => {
  it('is one connected place', () => {
    const { city } = grown('grow-1');
    const parent = new Map<number, number>();
    const find = (a: number): number => {
      let r = a;
      while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
      return r;
    };
    for (const e of city.roads.edges) {
      const ra = find(e.a);
      const rb = find(e.b);
      if (ra !== rb) parent.set(ra, rb);
    }
    // Measured as a share of road length rather than as a component count. The
    // town deliberately deletes spans and leaves 行き止まり everywhere, and the
    // Tier-2 grid is cut at the river bank — so the occasional short orphan is
    // the cost of those, not a failure. What would be a failure is a *district*
    // floating free of the town.
    const lengthByRoot = new Map<number, number>();
    let total = 0;
    for (const e of city.roads.edges) {
      const len = V.dist(city.roads.graph.node(e.a).p, city.roads.graph.node(e.b).p);
      const r = find(e.a);
      lengthByRoot.set(r, (lengthByRoot.get(r) ?? 0) + len);
      total += len;
    }
    const biggest = Math.max(...lengthByRoot.values());
    expect(
      biggest / total,
      `largest component holds ${((biggest / total) * 100).toFixed(1)}% of the roads`,
    ).toBeGreaterThan(0.97);
  });

  it('builds the middle up more than the edge', () => {
    // **Floor area**, not footprint area, and not parcels per hectare.
    //
    // Each of the other two reads the gradient backwards, for its own reason.
    // Parcels per hectare: lot sizes grow outward, so a fringe of big houses on
    // big plots counts as *sparser* than a tight centre while being far emptier.
    // Footprint coverage: the middle of the town is the 商業地域, which is
    // forecourts, car parks and a station — a コンビニ covers a third of its plot
    // by design. What "びっしり建物が建つ" actually names is the amount of
    // building, and downtown has it stacked rather than spread.
    const { params, city } = grown('grow-1');
    const E = params.roads.extent;
    const plan = planBuildings(city, params);

    let innerBuilt = 0;
    let outerBuilt = 0;
    for (const b of plan.buildings) {
      const floors = b.mass.floors.length;
      const r = radius(b.lot.centroid);
      if (r < E / 2) innerBuilt += b.footprint.area * floors;
      else if (r > (3 * E) / 4) outerBuilt += b.footprint.area * floors;
    }
    const innerArea = E ** 2;
    const outerArea = (2 * E) ** 2 - (1.5 * E) ** 2;
    const inner = innerBuilt / innerArea;
    const outer = outerBuilt / outerArea;

    expect(
      inner,
      `floor area ratio: inner ${inner.toFixed(2)}, outer ${outer.toFixed(2)}`,
    ).toBeGreaterThan(outer);
  });

  it('leaves the newest estates part-sold', () => {
    const { params, city } = grown('grow-1');
    const plan = planBuildings(city, params);
    expect(plan.vacancyReasons['not-yet-developed'] ?? 0).toBeGreaterThan(0);

    // And they are out at the fringe, not scattered through the middle: that is
    // the difference between a young edge and a generator dropping lots.
    const undeveloped = city.lots.filter((l) => l.vacancyReason === 'not-yet-developed');
    const built = city.lots.filter((l) => l.vacancyReason === null);
    const meanR = (ls: typeof undeveloped) => ls.reduce((s, l) => s + radius(l.centroid), 0) / ls.length;
    expect(meanR(undeveloped)).toBeGreaterThan(meanR(built));
  });

  it('an older town is a superset of a younger one', () => {
    // The definition of growth, and the one invariant that separates it from
    // "the seed happens to include a step count": a town does not un-build the
    // roads it already had.
    const young = grown('grow-1', 8).city;
    const old = grown('grow-1', 20).city;

    // The town grows, it is not re-rolled.
    //
    // This is the assertion the whole `fullAt` split exists to make true. The
    // frontier schedule used to be `(step / steps)`, so raising the age changed
    // the radius every single step aimed at: the candidate sets differed from
    // step one and the older town was not a continuation of the younger one but
    // an unrecognisably different place. `steps` behaved as a second seed.
    //
    // Measured as the share of the young town's Tier-1 that is still there when
    // the town is older. Not edge-for-edge: the later steps genuinely build
    // *around* what exists, the closure pass ties off different loose ends, and
    // the clearance pass may delete a span a newer road made redundant. But the
    // roads themselves have to survive.
    const tier1 = (c: typeof young) => c.roads.edges.filter((e) => e.cls !== 'local');
    const kept = (a: typeof young, b: typeof young) => {
      let survived = 0;
      let total = 0;
      for (const e of tier1(a)) {
        const p0 = a.roads.graph.node(e.a).p;
        const p1 = a.roads.graph.node(e.b).p;
        const len = V.dist(p0, p1);
        total += len;
        const mid = V.lerp(p0, p1, 0.5);
        const found = tier1(b).some((f) => {
          const q0 = b.roads.graph.node(f.a).p;
          const q1 = b.roads.graph.node(f.b).p;
          return V.distToSegment(mid, q0, q1) < 8;
        });
        if (found) survived += len;
      }
      return survived / Math.max(1, total);
    };

    const share = kept(young, old);
    expect(share, `only ${(share * 100).toFixed(0)}% of the young town survived into the old one`)
      .toBeGreaterThan(0.8);

    // And the older town is the bigger one: growth adds.
    expect(old.roads.districts.length).toBeGreaterThanOrEqual(young.roads.districts.length);
    expect(old.lots.length).toBeGreaterThan(young.lots.length);
  });

  it('is deterministic', () => {
    const a = grown('grow-2').city;
    const b = grown('grow-2').city;
    expect(a.roads.edges.length).toBe(b.roads.edges.length);
    expect(a.lots.length).toBe(b.lots.length);
    for (let i = 0; i < a.lots.length; i += 17) {
      expect(a.lots[i]!.polygon).toEqual(b.lots[i]!.polygon);
      expect(a.lots[i]!.platform.padY).toBe(b.lots[i]!.platform.padY);
    }
  });
});
