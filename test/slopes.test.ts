import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { describeGradeViolation, gradeViolations } from '../src/city/RoadProfile.js';
import { intersectPoly } from '../src/geom/boolean.js';
import { area } from '../src/geom/polygon.js';
import * as V from '../src/geom/vec2.js';

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
