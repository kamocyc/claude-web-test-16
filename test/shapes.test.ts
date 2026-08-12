import { describe, expect, it } from 'vitest';
import { DEG, DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import * as V from '../src/geom/vec2.js';
import { maxInscribedCircle } from '../src/geom/polygon.js';
import type { Polygon, Vec2 } from '../src/core/types.js';

/**
 * Building shape and entrance placement.
 *
 * Both of these were reported by eye and neither had a test. The footprints
 * regularly ended in a needle — a ring doubling back on itself at 1.4°, drawing
 * as a razor blade stuck to the side of the house — or came out as a corridor
 * 15 m long and 1.8 m deep. And the entrance was decided per wall rather than
 * per building, so 28% of the houses had two or three front doors, one house in
 * forty had none at all, and a door regularly sat several metres back from the
 * street behind the parking space.
 */

const layouts: RoadLayout[] = ['district', 'grid'];
const seeds = ['sh-1', 'sh-2', 'sh-3'];

function town(seed: string, layout: RoadLayout) {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  params.roads.extent = 190;
  const city = generateCity(params);
  return { city, params, plan: planBuildings(city, params) };
}

/** The sharpest interior angle of a CCW ring, in degrees. */
function sharpestCorner(poly: Polygon): number {
  const n = poly.length;
  let worst = 360;
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n]!;
    const v = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const a = V.sub(p, v);
    const b = V.sub(q, v);
    if (V.len(a) < 1e-9 || V.len(b) < 1e-9) continue;
    const theta = V.angleBetween(a, b) / DEG;
    // A reflex vertex measures (360 − θ) from inside and is an inside corner,
    // which no amount of sharpness makes into a needle.
    worst = Math.min(worst, V.cross(V.sub(v, p), V.sub(q, v)) > 0 ? theta : 360 - theta);
  }
  return worst;
}

describe('building shapes', () => {
  for (const layout of layouts) {
    for (const seed of seeds) {
      it(`no footprint ends in a needle (${layout}, ${seed})`, () => {
        const { plan } = town(seed, layout);
        expect(plan.buildings.length).toBeGreaterThan(50);

        let worst = { angle: 360, id: -1 };
        for (const b of plan.buildings) {
          const angle = sharpestCorner(b.footprint.outline);
          if (angle < worst.angle) worst = { angle, id: b.lot.id };
        }
        // `trimSharpCorners` cuts every convex corner below 45° back to where the
        // plan is two modules across, so nothing sharper than that survives. The
        // margin is for the cleaning that follows the cut.
        expect(
          worst.angle,
          `lot ${worst.id} has a ${worst.angle.toFixed(1)}° corner — a needle, not a building`,
        ).toBeGreaterThan(40);
      }, 60000);

      it(`no footprint is a corridor (${layout}, ${seed})`, () => {
        const { plan, params } = town(seed, layout);
        // The floor `finishOutline` enforces, less the 0.25 m at which the
        // inscribed circle is searched.
        const floor = params.buildings.module * 2.7 - 0.25;

        let worst = { width: Infinity, id: -1, area: 0 };
        for (const b of plan.buildings) {
          const width = maxInscribedCircle(b.footprint.outline, 0.2).radius * 2;
          if (width < worst.width) worst = { width, id: b.lot.id, area: b.footprint.area };
        }
        expect(
          worst.width,
          `lot ${worst.id}: a ${worst.area.toFixed(0)} m² plan that fits nothing wider than ` +
            `${worst.width.toFixed(2)} m is a corridor — it should have been left empty as too-narrow`,
        ).toBeGreaterThan(floor);
      }, 60000);

      it(`every house has one front door, facing the street or the car (${layout}, ${seed})`, () => {
        const { plan, params } = town(seed, layout);
        const module = params.buildings.module;
        const houses = plan.buildings.filter((b) => b.spec.kind === 'house');
        expect(houses.length).toBeGreaterThan(30);

        const noDoor: number[] = [];
        const extra: number[] = [];
        const misaimed: string[] = [];
        const behind: string[] = [];

        for (const b of houses) {
          const walls = b.mass.floors[0]!.walls;
          const entrances = walls.filter((w) => w.isEntrance);
          if (entrances.length > 1) extra.push(b.lot.id);
          // A 910 mm door needs 910 mm of wall; the façade narrows its corner
          // returns on this wall alone to make that fit.
          const usable = entrances.filter((w) => w.len >= module);
          if (usable.length === 0) {
            noDoor.push(b.lot.id);
            continue;
          }

          const w = usable[0]!;
          const mid = V.lerp(w.a, w.b, 0.5);
          let aim = V.dot(w.normal, b.lot.faceDir);
          if (b.spec.carPadAt) {
            const toPad = V.sub(b.spec.carPadAt, mid);
            if (V.len(toPad) > 0.5) aim = Math.max(aim, V.dot(w.normal, V.normalize(toPad)));
          }
          const off = Math.acos(Math.min(1, aim)) / DEG;
          if (off > 60) misaimed.push(`lot ${b.lot.id} ${off.toFixed(0)}°`);

          const f = b.lot.frontages[0];
          if (f) {
            const depth = (p: Vec2) => V.dot(V.sub(p, f.mid), f.outward);
            const gap = Math.max(...walls.map((x) => depth(V.lerp(x.a, x.b, 0.5)))) - depth(mid);
            if (gap > 3) behind.push(`lot ${b.lot.id} ${gap.toFixed(1)} m`);
          }
        }

        // One wall per building, by construction — this is the assertion that
        // the two-and-three-door houses cannot come back.
        expect(extra, `houses with more than one entrance wall: ${extra.slice(0, 5).join(', ')}`).toEqual([]);
        expect(
          noDoor.length / houses.length,
          `${noDoor.length}/${houses.length} houses have no way in: ${noDoor.slice(0, 5).join(', ')}`,
        ).toBeLessThan(0.01);
        expect(
          misaimed.length / houses.length,
          `entrances facing neither the street nor the car: ${misaimed.slice(0, 5).join(', ')}`,
        ).toBeLessThan(0.01);
        expect(
          behind.length / houses.length,
          `entrances set back behind the street-most wall: ${behind.slice(0, 5).join(', ')}`,
        ).toBeLessThan(0.02);
      }, 60000);
    }
  }
});
