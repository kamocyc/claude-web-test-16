import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { describeGradeViolation, gradeViolations } from '../src/city/RoadProfile.js';
import { intersectPoly } from '../src/geom/boolean.js';
import { area } from '../src/geom/polygon.js';
import * as V from '../src/geom/vec2.js';
import { gradeGround } from '../src/terrain/Graded.js';
import type { Vec2 } from '../src/core/types.js';

/**
 * What the land is allowed to do to the town.
 *
 * The detectors here are written against the finished city rather than inside
 * the code that produces it, in the same spirit as
 * `RoadClearance.clearanceViolations`: the assertion that is worth having is one
 * that would still catch a regression after the generator has been replaced. The
 * road profiler is *supposed* to guarantee the gradient bound; the point of
 * `gradeViolations` is that nothing has to take its word for it.
 */

const LAYOUTS: RoadLayout[] = ['district', 'grid'];

function town(seed: string, layout: RoadLayout) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  params.roads.extent = 190;
  return { params, city: generateCity(params) };
}

describe('road gradients', () => {
  for (const layout of LAYOUTS) {
    for (const seed of ['slope-1', 'slope-2']) {
      it(`no road is steeper than its class allows (${layout}, ${seed})`, () => {
        const { params, city } = town(seed, layout);
        const bad = gradeViolations(city.roads, city.roadHeights, params.roads);
        expect(
          bad.slice(0, 5).map((v) => describeGradeViolation(city.roads, v)),
          `${bad.length} roads too steep`,
        ).toEqual([]);
      });
    }
  }

  it('the profile is a design, not a drape', () => {
    // If road heights merely sampled the ground, the network's roughness would
    // match the terrain's. It should be conspicuously smoother — that is the
    // whole claim `city/RoadProfile.ts` makes.
    const { city } = town('slope-1', 'district');
    let design = 0;
    let ground = 0;
    let n = 0;
    for (const e of city.roads.edges) {
      const a = city.roads.graph.node(e.a).p;
      const b = city.roads.graph.node(e.b).p;
      const len = V.dist(a, b);
      if (len < 5) continue;
      design += Math.abs(city.roadHeights.at(e.b) - city.roadHeights.at(e.a)) / len;
      ground += Math.abs(city.terrain.heightAt(b) - city.terrain.heightAt(a)) / len;
      n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(design / n, 'the roads are draped, not graded').toBeLessThan(ground / n);
  });
});

describe('the river', () => {
  for (const seed of ['slope-1', 'slope-2']) {
    it(`carries no buildings (${seed})`, () => {
      const { params, city } = town(seed, 'district');
      const plan = planBuildings(city, params);
      const banks = city.terrain.bankPolygons;
      expect(banks.length).toBeGreaterThan(0);

      const wet: string[] = [];
      for (const b of plan.buildings) {
        for (const bank of banks) {
          const overlap = intersectPoly([b.footprint.outline], [bank]);
          const a = overlap.reduce((s, poly) => s + area(poly), 0);
          // A corner clipping the margin is not a house in the river; a
          // meaningful share of the footprint is.
          if (a > b.footprint.area * 0.25) {
            wet.push(`lot ${b.lot.id}: ${a.toFixed(0)} m² of ${b.footprint.area.toFixed(0)} in the river`);
          }
        }
      }
      expect(wet.slice(0, 5), `${wet.length} buildings in the water`).toEqual([]);
    });

    it(`is only crossed by roads that could bridge it (${seed})`, () => {
      const { params, city } = town(seed, 'district');
      const E = params.roads.extent;
      /**
       * The perimeter ring is exempt, and only the perimeter ring.
       *
       * It is the road round the outside of the town, it is laid rather than
       * grown, and where the river leaves the map it crosses it — as the real
       * thing does, on a bridge, which `props/Ground.ts` draws for any crossing
       * whatever its class. What this test is actually about is the Tier-2 grid:
       * a residential street has no business out over the water, because nobody
       * builds a bridge for the lane behind a house.
       */
      const onPerimeter = (p: { x: number; y: number }): boolean =>
        Math.abs(Math.abs(p.x) - E) < 2 || Math.abs(Math.abs(p.y) - E) < 2;

      const crossings: string[] = [];
      for (const e of city.roads.edges) {
        if (e.cls === 'arterial' || e.cls === 'collector') continue;
        const a = city.roads.graph.node(e.a).p;
        const b = city.roads.graph.node(e.b).p;
        if (onPerimeter(a) && onPerimeter(b)) continue;
        // Sampled rather than clipped: what matters is that no local street has
        // its *middle* out over the water, which is what a missing bridge looks
        // like. Ends may sit in the margin — that is a street stopping at a bank.
        for (let i = 2; i <= 8; i++) {
          const p = V.lerp(a, b, i / 10);
          if (city.terrain.waterAt(p) !== null) {
            crossings.push(`${e.cls} #${e.id} crosses the channel`);
            break;
          }
        }
      }
      expect(crossings.slice(0, 5), `${crossings.length} un-bridged crossings`).toEqual([]);
    });
  }
});

/**
 * Every carriageway is visible.
 *
 * Measured against the ground that is actually *drawn* — `gradeGround`, not the
 * natural heightfield — because being buried is a fact about the triangles, and
 * a road is allowed to sit metres under the land it crosses as long as the town
 * dug the land out of the way first. Roads have always been graded and lanes
 * never were: a 私道 had no profile at all, took both ends from whatever street
 * was within 40 m, and was drawn as one flat plane between them, so on a slope
 * it borrowed a height from the street on the far side of the block and vanished
 * into the hill. On the default seed 34 of 47 lanes ran more than a metre under
 * the land and the worst was seven metres down.
 */
function burial(city: ReturnType<typeof generateCity>): string[] {
  const graded = gradeGround(city);
  if (!graded) return [];
  const out: string[] = [];
  const at = (q: { x: number; y: number }) => `(${q.x.toFixed(0)}, ${q.y.toFixed(0)})`;

  /** Deepest burial anywhere across the width of one straight piece of road. */
  const check = (a: Vec2, b: Vec2, width: number, ya: number, yb: number): number => {
    const len = V.dist(a, b);
    if (len < 0.5) return 0;
    const n = V.perp(V.scale(V.sub(b, a), 1 / len));
    let worst = 0;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const c = V.lerp(a, b, t);
      const y = ya + (yb - ya) * t;
      // Across the carriageway only, not out to the kerb: the outermost
      // centimetres are where the earthworks quad takes over.
      for (const off of [-0.4, -0.2, 0, 0.2, 0.4]) {
        worst = Math.max(worst, graded.heightAt(V.addScaled(c, n, off * width)) - y);
      }
    }
    return worst;
  };

  for (const e of city.roads.edges) {
    const a = city.roads.graph.node(e.a).p;
    const b = city.roads.graph.node(e.b).p;
    const d = check(a, b, e.width, city.roadHeights.at(e.a), city.roadHeights.at(e.b));
    if (d > 1) out.push(`${e.cls} ${at(a)}–${at(b)}: ${d.toFixed(1)} m of ground over it`);
  }
  for (const prof of city.laneHeights.profiles) {
    let worst = 0;
    for (let i = 0; i + 1 < prof.points.length; i++) {
      const d = check(
        prof.points[i]!,
        prof.points[i + 1]!,
        prof.width,
        prof.heights[i]!,
        prof.heights[i + 1]!,
      );
      worst = Math.max(worst, d);
    }
    if (worst > 1) {
      out.push(`私道 ${at(prof.points[0]!)}: ${worst.toFixed(1)} m of ground over it`);
    }
  }
  return out;
}

describe('buried roads', () => {
  for (const seed of ['slope-1', 'slope-2']) {
    it(`no road or lane is under the ground that is drawn (${seed})`, () => {
      const { city } = town(seed, 'district');
      // The town is on a hillside and its lanes exist — an assertion that none
      // of them is buried says nothing if there is nothing to bury.
      expect(city.laneHeights.profiles.length, 'no private lanes in this town').toBeGreaterThan(5);
      const bad = burial(city);
      expect(bad.slice(0, 5), `${bad.length} buried carriageways`).toEqual([]);
    });
  }

  it('a lane follows the land it crosses', () => {
    // The other half of the claim: a 私道 is not graded like a street. Away from
    // the junction where it has to meet the road, it should be on the ground —
    // if it is not, it is a street with a different name and the burial test
    // above could be passed by simply excavating the whole block.
    const { city } = town('slope-1', 'district');
    let onGround = 0;
    let total = 0;
    for (const prof of city.laneHeights.profiles) {
      const n = prof.points.length - 1;
      // Skip the first and last few stations: that is the blend onto the street.
      for (let i = 4; i <= n - 4; i++) {
        total++;
        const d = Math.abs(city.terrain.heightAt(prof.points[i]!) - prof.heights[i]!);
        if (d < 1) onGround++;
      }
    }
    expect(total, 'no lane long enough to measure').toBeGreaterThan(30);
    expect(onGround / total, 'lanes are graded like streets').toBeGreaterThan(0.7);
  });
});

describe('platforms', () => {
  for (const seed of ['slope-1', 'slope-2']) {
    it(`every platform that stands proud of the ground is retained (${seed})`, () => {
      const { params, city } = town(seed, 'district');
      const p = params.platform;
      const unsupported: string[] = [];
      let walled = 0;

      for (const lot of city.lots) {
        for (const edge of lot.platform.edges) {
          if (Math.abs(edge.worst) < p.wallMin) continue;
          walled++;
          if (edge.kind !== 'wall') {
            unsupported.push(
              `lot ${lot.id} edge ${edge.i}: ${edge.worst.toFixed(2)} m of ${edge.kind}`,
            );
          }
        }
      }
      expect(unsupported.slice(0, 5), `${unsupported.length} unsupported edges`).toEqual([]);
      // And the town is actually on a hillside — an assertion that every wall is
      // where it should be is worthless if there are no walls.
      expect(walled, 'no lot needed a retaining wall at all').toBeGreaterThan(40);
    });

    it(`pads sit on a stair riser, within reach of their street (${seed})`, () => {
      const { params, city } = town(seed, 'district');
      const p = params.platform;
      for (const lot of city.lots) {
        const { padY, streetY } = lot.platform;
        // Quantised: this is what makes neighbouring platforms line up into a
        // staircase instead of a smooth ramp.
        const steps = padY / p.riserQuantum;
        expect(Math.abs(steps - Math.round(steps)), `lot ${lot.id} pad off-riser`).toBeLessThan(1e-6);
        expect(padY - streetY, `lot ${lot.id} too far above its street`).toBeLessThan(
          p.maxRiseAboveStreet + p.plinth + p.riserQuantum,
        );
        expect(streetY - padY, `lot ${lot.id} too far below its street`).toBeLessThan(
          p.maxCutBelowStreet + p.riserQuantum,
        );
      }
    });
  }
});
