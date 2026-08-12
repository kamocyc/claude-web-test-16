import type { Polygon, Vec2 } from '../core/types.js';
import type { GrowthParams, RoadClass } from '../core/params.js';
import { DEG } from '../core/params.js';
import * as V from '../geom/vec2.js';
import type { Terrain } from './Terrain.js';

/**
 * What the land refuses.
 *
 * Deliberately only the *terrain-derived* obstacles: water, scarps and steep
 * ground. Road-versus-road is `city/RoadClearance.ts` and stays there — it
 * already works, `test/roads.test.ts` is written against its detectors rather
 * than against the generator, and folding the two together would put a terrain
 * dependency inside the one module the road tests trust.
 *
 * Everything here is a *measurement*, not a decision. The growth loop decides
 * whether a road is worth building; this only reports what it would have to
 * cross to get there.
 */

export interface GradientReport {
  /** Steepest rise over run found along the segment. */
  max: number;
  /** Mean absolute gradient. */
  mean: number;
  /** Net height gained end to end. */
  rise: number;
}

export interface WaterCrossing {
  /** Parameters along the segment where it enters and leaves the water. */
  t0: number;
  t1: number;
  span: number;
  /** Angle between the road and the bank, radians. A square crossing is π/2. */
  angle: number;
}

export interface TerraceCrossing {
  at: Vec2;
  angle: number;
  step: number;
}

export type CrossVerdict =
  | { ok: true; bridge: WaterCrossing | null }
  | { ok: false; reason: 'water' | 'gradient' | 'span' | 'angle' };

export interface ObstacleField {
  readonly terrain: Terrain;
  gradient(a: Vec2, b: Vec2, cls?: RoadClass): GradientReport;
  waterCrossing(a: Vec2, b: Vec2): WaterCrossing | null;
  terraceCrossing(a: Vec2, b: Vec2): TerraceCrossing | null;
  /** Would a road of this class be buildable along this segment? */
  probe(a: Vec2, b: Vec2, cls: RoadClass): CrossVerdict;
  /** May a lot or a building stand here? */
  buildable(p: Vec2): boolean;
  /**
   * The parts of a segment that are clear of the water and its margin.
   *
   * A local street cannot bridge a river — building one is a public works
   * decision a suburb makes for its arterials, not for the lane behind
   * someone's house — so a Tier-2 grid laid across a district the river runs
   * through has to be *cut* at the bank rather than drawn over it.
   */
  dryRuns(a: Vec2, b: Vec2): [Vec2, Vec2][];
  /** Water surfaces, for the ground mesh. */
  readonly water: readonly Polygon[];
  /** Water plus its margin. Nothing may be built inside. */
  readonly banks: readonly Polygon[];
  /** Scarp faces. Nothing may be built inside. */
  readonly cliffBands: readonly Polygon[];
  readonly maxGradient: Record<RoadClass, number>;
}

/** How finely a segment is sampled when measuring gradient. */
const PROBE_STEP = 5;

export function makeObstacles(terrain: Terrain, g: GrowthParams): ObstacleField {
  const cliffBands = terrain.terraces.map((t) => t.band);
  const banks = terrain.bankPolygons;

  const gradient = (a: Vec2, b: Vec2): GradientReport => {
    const len = V.dist(a, b);
    if (len < 1e-6) return { max: 0, mean: 0, rise: 0 };
    const n = Math.max(2, Math.ceil(len / PROBE_STEP));
    let prev = terrain.heightAtXY(a.x, a.y);
    const first = prev;
    let worst = 0;
    let sum = 0;
    for (let i = 1; i <= n; i++) {
      const p = V.lerp(a, b, i / n);
      const h = terrain.heightAtXY(p.x, p.y);
      const grade = Math.abs(h - prev) / (len / n);
      if (grade > worst) worst = grade;
      sum += grade;
      prev = h;
    }
    return { max: worst, mean: sum / n, rise: prev - first };
  };

  const waterCrossing = (a: Vec2, b: Vec2): WaterCrossing | null => {
    if (!terrain.river) return null;
    const len = V.dist(a, b);
    if (len < 1e-6) return null;
    const n = Math.max(2, Math.ceil(len / PROBE_STEP));
    let t0 = -1;
    let t1 = -1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = V.lerp(a, b, t);
      // The margin, not the water itself: a road that stops 2 m from the bank
      // has still failed to be a road, it just has not got its feet wet yet.
      if (terrain.waterDistance(p) > terrain.params.river.bankMargin) continue;
      if (t0 < 0) t0 = t;
      t1 = t;
    }
    if (t0 < 0) return null;

    // The angle the road makes with the river, from the nearest span of the
    // centreline. A square crossing is a short bridge; an oblique one is a long
    // and expensive causeway, and it is what growth should be discouraged from.
    const mid = V.lerp(a, b, (t0 + t1) / 2);
    const centre = terrain.river.centre;
    let bankDir = V.sub(b, a);
    let best = Infinity;
    for (let i = 0; i + 1 < centre.length; i++) {
      const d = V.distToSegment(mid, centre[i]!, centre[i + 1]!);
      if (d < best) {
        best = d;
        bankDir = V.sub(centre[i + 1]!, centre[i]!);
      }
    }
    const raw = V.angleBetween(V.sub(b, a), bankDir);
    return {
      t0,
      t1,
      span: (t1 - t0) * len,
      angle: Math.min(raw, Math.PI - raw),
    };
  };

  const terraceCrossing = (a: Vec2, b: Vec2): TerraceCrossing | null => {
    for (const line of terrain.terraces) {
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const x = V.segmentIntersection(a, b, line.pts[i]!, line.pts[i + 1]!, 1e-9);
        if (!x) continue;
        const raw = V.angleBetween(V.sub(b, a), V.sub(line.pts[i + 1]!, line.pts[i]!));
        return {
          at: V.lerp(a, b, x.ta),
          angle: Math.min(raw, Math.PI - raw),
          step: Math.abs(line.step),
        };
      }
    }
    return null;
  };

  return {
    terrain,
    gradient,
    waterCrossing,
    terraceCrossing,
    maxGradient: g.maxGradient,

    probe(a, b, cls) {
      // End to end, not the worst 5 m of ground along the way.
      //
      // A road is a *graded* surface: it cuts the hump and fills the dip, and
      // `city/RoadProfile.ts` then solves it to a smooth profile within this
      // same limit. Testing the raw ground's local maximum asks the land to
      // already be a road, and on 26 m of relief essentially nothing passes —
      // the first version of this rejected all but a handful of arterial
      // candidates in the whole town, and the generator produced two districts
      // covering ninety per cent of it.
      //
      // What the local maximum *is* good for is cost, and it is used that way
      // by the growth scorer: a line that needs a big cutting is expensive, but
      // it is not impossible.
      const len = V.dist(a, b);
      const report = gradient(a, b);
      if (len > 1e-6 && Math.abs(report.rise) / len > g.maxGradient[cls]) {
        return { ok: false, reason: 'gradient' };
      }

      const water = waterCrossing(a, b);
      if (!water) return { ok: true, bridge: null };
      // A local street does not get a bridge. Building one is a public works
      // decision, and a suburb makes it for its arterials, not for the lane
      // behind someone's house.
      if (cls === 'local' || cls === 'private') return { ok: false, reason: 'water' };
      if (water.span > g.maxBridgeSpan) return { ok: false, reason: 'span' };
      if (water.angle < g.minRiverCrossAngle * DEG) return { ok: false, reason: 'angle' };
      return { ok: true, bridge: water };
    },

    dryRuns(a, b) {
      if (!terrain.river) return [[a, b]];
      const len = V.dist(a, b);
      if (len < 1e-6) return [];
      const margin = terrain.params.river.bankMargin;
      const n = Math.max(4, Math.ceil(len / 4));
      const out: [Vec2, Vec2][] = [];
      let runStart: number | null = 0;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const wet = terrain.waterDistance(V.lerp(a, b, t)) <= margin;
        if (wet && runStart !== null) {
          if (t - runStart > 0.02) out.push([V.lerp(a, b, runStart), V.lerp(a, b, t)]);
          runStart = null;
        } else if (!wet && runStart === null) {
          runStart = t;
        }
      }
      if (runStart !== null && 1 - runStart > 0.02) out.push([V.lerp(a, b, runStart), b]);
      return out;
    },

    buildable(p) {
      if (terrain.waterDistance(p) < terrain.params.river.bankMargin) return false;
      // Half a band's width either side of a scarp: the face itself plus the
      // rounding the bilinear sampler puts on its lip.
      const scarp = terrain.nearestTerrace(p, terrain.params.terrace.width);
      if (scarp) return false;
      return terrain.slopeAt(p) <= terrain.params.maxBuildSlope;
    },

    water: terrain.waterPolygons,
    banks,
    cliffBands,
  };
}
