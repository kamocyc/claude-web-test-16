import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  applyRoadLayout,
  cloneParams,
  type RoadLayout,
} from '../src/core/params.js';
import { generateCity, type City } from '../src/city/City.js';
import type { Polygon, Vec2 } from '../src/core/types.js';
import * as V from '../src/geom/vec2.js';
import { drawnRoadSurfaces, junctionPlate, planJunctions } from '../src/city/RoadSurface.js';
import { buildRetaining } from '../src/props/Retaining.js';
import { gradeGround } from '../src/terrain/Graded.js';
import { GeometryBuffer } from '../src/build/GeometryBuffer.js';

/**
 * What the earthworks are allowed to do — the junctions, the 擁壁 and the steps.
 *
 * Every assertion here is the machine-readable form of something that was
 * plainly visible on screen and that nothing measured: a notch of bare ground in
 * the corner of an intersection, a retaining wall with six metres of daylight
 * under its toe, a cut bank held up by nothing, a staircase that went out of the
 * parcel and rendered inside out. All four are geometry, so all four can be
 * counted rather than looked at.
 */

const LAYOUTS: RoadLayout[] = ['district', 'grid'];
const SEEDS = ['ew-1', 'ew-2'];

function town(seed: string, layout: RoadLayout): City {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  params.roads.extent = 190;
  return generateCity(params);
}

function pointInPolygon(poly: Polygon, p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** How far outside `poly` the point lies; zero when it is inside. */
function outsideBy(poly: Polygon, p: Vec2): number {
  if (pointInPolygon(poly, p)) return 0;
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    best = Math.min(best, V.distToSegment(p, poly[i]!, poly[(i + 1) % n]!));
  }
  return best;
}

describe('junctions', () => {
  for (const layout of LAYOUTS) {
    for (const seed of SEEDS) {
      /**
       * The carriageway now stops short of a junction and the plate fills what
       * is left, so the seam between the two is the thing that can go wrong: an
       * arm trimmed further back than the plate reaches leaves a band of bare
       * hillside straight across the road.
       *
       * Sampled either side of every arm's trim line and right across its width,
       * which is also what pins the mitre down — a plate that merely chamfered
       * between one arm's corner and the next would cut the outer quarter off
       * every road that turns a corner, and this is where that shows up.
       */
      it(`the asphalt closes at every junction (${layout}, ${seed})`, () => {
        const city = town(seed, layout);
        const { junctions } = planJunctions(city.roads);
        const surfaces = drawnRoadSurfaces(city.roads, city.laneHeights.profiles);

        const bad: string[] = [];
        for (const j of junctions) {
          for (const arm of j.arms) {
            const n = V.perp(arm.dir);
            for (const across of [-0.9, -0.5, 0, 0.5, 0.9]) {
              // Inside the plate, and just inside the ribbon beyond it.
              for (const along of [arm.trim * 0.5, arm.trim + 0.05]) {
                const q = V.addScaled(
                  V.addScaled(j.p, arm.dir, along),
                  n,
                  arm.half * across,
                );
                if (!surfaces.some((s) => pointInPolygon(s, q))) {
                  bad.push(`node ${j.node}: (${q.x.toFixed(1)}, ${q.y.toFixed(1)}) is not paved`);
                }
              }
            }
          }
        }
        expect(bad.slice(0, 5), `${bad.length} holes at junctions`).toEqual([]);
      }, 60000);

      /**
       * And the other half of the same claim: the plate is the convex chamfer
       * through the arms' own corners, so it can never reach further from the
       * node than an arm's own corner does. That is what stops an arterial
       * ending at a lane from laying asphalt over the garden behind it.
       */
      it(`a junction stays inside its arms (${layout}, ${seed})`, () => {
        const city = town(seed, layout);
        const { junctions } = planJunctions(city.roads);
        const bad: string[] = [];
        for (const j of junctions) {
          const plate = junctionPlate(j);
          if (!plate) continue;
          let reach = 0;
          for (const arm of j.arms) reach = Math.max(reach, arm.half);
          // Corner of the widest arm's end edge: the furthest point the plate is
          // allowed to have, plus the half metre `plateReach` floors a trim at.
          // A mitre may reach further than a corner — that is what rounding the
          // outside of a bend costs — but never past what the arms themselves
          // bound, which is the limit `MITRE_LIMIT` puts on it.
          const limit = Math.max(reach + 0.5, reach) * 2.2 + 1e-6;
          for (const q of plate.ring) {
            const d = V.dist(q, j.p);
            if (d > limit) bad.push(`node ${j.node}: plate reaches ${d.toFixed(1)} m > ${limit.toFixed(1)}`);
          }
        }
        expect(bad.slice(0, 5), `${bad.length} oversized junctions`).toEqual([]);
      }, 60000);
    }
  }
});

describe('retaining walls', () => {
  for (const layout of LAYOUTS) {
    for (const seed of SEEDS) {
      /**
       * A wall is built against the surface that is *drawn*, and the drawn
       * surface is the graded one — `terrain/Graded.ts` digs a couple of grid
       * cells inside a lot boundary wherever the street beside it is in cut.
       * Measured against the natural heightfield instead, two fifths of the wall
       * stations in the default town stood on nothing.
       */
      it(`no wall stands on air (${layout}, ${seed})`, () => {
        const city = town(seed, layout);
        const graded = gradeGround(city);
        const ground = (q: Vec2): number =>
          Math.min(graded ? graded.heightAt(q) : Infinity, city.terrain.heightAt(q));

        let floating = 0;
        let worst = 0;
        for (const lot of city.lots) {
          const n = lot.polygon.length;
          for (const edge of lot.platform.edges) {
            if (edge.kind !== 'wall') continue;
            const a = lot.polygon[edge.i]!;
            const b = lot.polygon[(edge.i + 1) % n]!;
            const steps = Math.max(1, Math.round(V.dist(a, b)));
            for (let i = 0; i < steps; i++) {
              const q0 = V.lerp(a, b, i / steps);
              const q1 = V.lerp(a, b, (i + 1) / steps);
              // The toe, as `props/Retaining.ts` places it.
              const base = Math.min(lot.platform.padY, ground(q0), ground(q1)) - 0.4;
              const gap = base - ground(V.lerp(q0, q1, 0.5));
              if (gap > 0.05) {
                floating++;
                worst = Math.max(worst, gap);
              }
            }
          }
        }
        expect(floating, `worst gap ${worst.toFixed(2)} m under a wall`).toBe(0);
      }, 60000);

      /**
       * A cut edge is the high side of a hillside parcel and needs the taller
       * wall of the two. Drawn from the ground *up to* the pad — which is what
       * it used to say — its top came out below its base and it vanished.
       */
      it(`a cut bank is retained (${layout}, ${seed})`, () => {
        const city = town(seed, layout);
        const graded = gradeGround(city);
        const ground = (q: Vec2): number =>
          Math.min(graded ? graded.heightAt(q) : Infinity, city.terrain.heightAt(q));

        let cut = 0;
        let empty = 0;
        for (const lot of city.lots) {
          const n = lot.polygon.length;
          for (const edge of lot.platform.edges) {
            if (edge.kind !== 'wall' || edge.drop >= 0) continue;
            cut++;
            const a = lot.polygon[edge.i]!;
            const b = lot.polygon[(edge.i + 1) % n]!;
            const steps = Math.max(1, Math.round(V.dist(a, b)));
            let drawn = 0;
            for (let i = 0; i < steps; i++) {
              const g0 = ground(V.lerp(a, b, i / steps));
              const g1 = ground(V.lerp(a, b, (i + 1) / steps));
              const base = Math.min(lot.platform.padY, g0, g1) - 0.4;
              const top = Math.max(lot.platform.padY + 0.05, g0, g1);
              if (top > base) drawn++;
            }
            if (drawn === 0) empty++;
          }
        }
        expect(cut, 'no cut walls in this town at all — the test is not looking at anything').toBeGreaterThan(0);
        expect(empty, `${empty} of ${cut} cut edges retained by nothing`).toBe(0);
      }, 60000);

      /**
       * Walls, batters and the flight up from the street all belong to one
       * parcel. A batter leans out by design — that is what a fill slope is —
       * but only as far as `wallMin` at `batterSlope`, which is the widest slope
       * the classification ever meant to allow.
       */
      it(`the earthworks stay on their own lot (${layout}, ${seed})`, () => {
        const city = town(seed, layout);
        const graded = gradeGround(city);
        const p = city.params.platform;
        const limit = p.wallMin * p.batterSlope + 0.1;

        const bad: string[] = [];
        for (const lot of city.lots) {
          const captured: Partial<Record<string, GeometryBuffer>>[] = [];
          const sink = {
            add: (_at: Vec2, bufs: Partial<Record<string, GeometryBuffer>>) => captured.push(bufs),
          };
          buildRetaining(
            sink as never,
            { ...city, lots: [lot] } as City,
            p,
            graded,
          );
          for (const bufs of captured) {
            for (const buf of Object.values(bufs)) {
              if (!buf || buf.isEmpty) continue;
              const pos = buf.toGeometry().attributes.position!.array as ArrayLike<number>;
              for (let i = 0; i < pos.length; i += 3) {
                const d = outsideBy(lot.polygon, { x: pos[i]!, y: pos[i + 2]! });
                if (d > limit) bad.push(`lot ${lot.id}: ${d.toFixed(2)} m outside its boundary`);
              }
            }
          }
        }
        expect(bad.slice(0, 5), `${bad.length} vertices off their lot`).toEqual([]);
      }, 120000);

      /**
       * Every box the steps emit has to have its top above its bottom.
       * `pushPrism` winds a box the other way round inside out, so a flight down
       * into a lot below its street — near a third of them — rendered back to
       * front. Checked through the buffer rather than through the arithmetic,
       * because it is the triangles that were wrong.
       */
      it(`no flight of steps is inside out (${layout}, ${seed})`, () => {
        const city = town(seed, layout);
        const graded = gradeGround(city);
        const bad: string[] = [];
        for (const lot of city.lots) {
          if (lot.platform.steps === 0) continue;
          const captured: Partial<Record<string, GeometryBuffer>>[] = [];
          const sink = {
            add: (_at: Vec2, bufs: Partial<Record<string, GeometryBuffer>>) => captured.push(bufs),
          };
          buildRetaining(sink as never, { ...city, lots: [lot] } as City, city.params.platform, graded);
          for (const bufs of captured) {
            const buf = bufs.concrete;
            if (!buf || buf.isEmpty) continue;
            const g = buf.toGeometry();
            const pos = g.attributes.position!.array as ArrayLike<number>;
            const idx = g.getIndex()!;
            for (let t = 0; t < idx.count; t += 3) {
              const i0 = idx.getX(t) * 3;
              const i1 = idx.getX(t + 1) * 3;
              const i2 = idx.getX(t + 2) * 3;
              // Upward-facing triangles are the caps. A cap wound the other way
              // is a box turned inside out.
              const ux = pos[i1]! - pos[i0]!;
              const uy = pos[i1 + 1]! - pos[i0 + 1]!;
              const uz = pos[i1 + 2]! - pos[i0 + 2]!;
              const vx = pos[i2]! - pos[i0]!;
              const vy = pos[i2 + 1]! - pos[i0 + 1]!;
              const vz = pos[i2 + 2]! - pos[i0 + 2]!;
              const ny = uz * vx - ux * vz;
              const flat = Math.abs(uy) < 1e-6 && Math.abs(vy) < 1e-6;
              if (flat && ny < -1e-6) {
                bad.push(`lot ${lot.id}: a cap faces down at y=${pos[i0 + 1]!.toFixed(2)}`);
              }
            }
          }
        }
        expect(bad.slice(0, 5), `${bad.length} inverted boxes`).toEqual([]);
      }, 120000);
    }
  }
});
