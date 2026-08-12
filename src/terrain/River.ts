import type { Polygon, Vec2 } from '../core/types.js';
import type { RiverParams } from '../core/params.js';
import { makeRng, makeValueNoise, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';

/**
 * The river, and the valley it cut.
 *
 * Two things make a river read as a river rather than as a blue ribbon painted
 * on a hill:
 *
 * - **It runs downhill, all the way.** The bed profile is forced monotone with a
 *   minimum fall. Sampling an fBm field along a meandering line and calling that
 *   the bed gives water flowing up over every rise the line happens to cross,
 *   and the eye catches it instantly.
 * - **It sits in a valley it made.** The carve is the *difference* between the
 *   surrounding land and the bed, feathered out over `valleyWidth`, so the banks
 *   rise out of the water instead of the water lying in a trench.
 */

export interface River {
  /** Centreline, resampled to an even spacing. */
  centre: Vec2[];
  /** Cumulative arclength at each centreline vertex. */
  cum: number[];
  total: number;
  /** Bed height at each centreline vertex, monotone non-increasing. */
  bed: number[];
  /** Water surface at each centreline vertex. */
  water: number[];
  /** The water surface, as a polygon. */
  channel: Polygon;
  /** The channel plus `bankMargin` — nothing may be built inside this. */
  banks: Polygon;
  params: RiverParams;
}

const SAMPLE_SPACING = 22;

/**
 * Nearest point on the centreline, as a span index and a fraction into it.
 *
 * A flat scan, deliberately. `geom/edgeGrid.ts` exists and is the right answer
 * for the road network, but not here: the centreline is fifty spans and the
 * heightfield asks about points up to half a kilometre away from it, so the
 * grid spends its time walking empty rings outward and comes out three times
 * slower than just measuring all fifty.
 */
function nearestOn(river: River, p: Vec2): { i: number; t: number; d: number } {
  let best = { i: 0, t: 0, d: Infinity };
  for (let i = 0; i + 1 < river.centre.length; i++) {
    const c = V.closestOnSegment(p, river.centre[i]!, river.centre[i + 1]!);
    const d = V.dist(p, c.point);
    if (d < best.d) best = { i, t: c.t, d };
  }
  return best;
}

/** Interpolate a per-vertex quantity at a point found by `nearestOn`. */
function sampleAlong(values: number[], hit: { i: number; t: number }): number {
  const a = values[hit.i]!;
  const b = values[Math.min(values.length - 1, hit.i + 1)]!;
  return a + (b - a) * hit.t;
}

export const riverNearest = nearestOn;
export const riverSample = sampleAlong;

/**
 * Build the centreline: two points on opposite sides of the town square, joined
 * by a line that meanders sideways and is nudged downhill.
 *
 * The downhill nudge is what keeps the river in the low ground of the fBm field
 * instead of cutting across a hill — the valley then agrees with the hills
 * around it rather than contradicting them.
 */
function centreline(
  seed: string,
  extent: number,
  p: RiverParams,
  base: (x: number, y: number) => number,
): Vec2[] {
  const rng = makeRng(subSeed(seed, 'river'));
  const wander = makeValueNoise(subSeed(seed, 'river', 'meander'));
  const reach = extent * 1.5;

  // A through-line at a shallow angle to one axis, so the river crosses the
  // town rather than clipping a corner.
  const angle = rng.range(-0.45, 0.45) + (rng.chance(0.5) ? 0 : Math.PI / 2);
  const dir = V.fromAngle(angle);
  const nrm = V.perp(dir);
  const offset = rng.range(-0.3, 0.3) * extent;

  const n = Math.max(8, Math.round((reach * 2) / SAMPLE_SPACING));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const s = -reach + (i / n) * reach * 2;
    const straight = V.addScaled(V.scale(dir, s), nrm, offset);
    const lateral = wander(s / 190, 0) * p.meander;
    let at = V.addScaled(straight, nrm, lateral);

    // Nudge perpendicular toward lower ground. One step, small: the meander is
    // supposed to be the dominant shape, not the terrain.
    const probe = 26;
    const left = base(at.x - nrm.x * probe, at.y - nrm.y * probe);
    const right = base(at.x + nrm.x * probe, at.y + nrm.y * probe);
    at = V.addScaled(at, nrm, Math.max(-18, Math.min(18, (left - right) * 2.2)));
    pts.push(at);
  }
  return pts;
}

/** A ribbon polygon of half-width `half` around a polyline. */
export function ribbonPolygon(line: Vec2[], half: number): Polygon {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(line.length - 1, i + 1)]!;
    const t = V.normalize(V.sub(b, a));
    const nrm = V.perp(t);
    left.push(V.addScaled(line[i]!, nrm, half));
    right.push(V.addScaled(line[i]!, nrm, -half));
  }
  right.reverse();
  return [...left, ...right];
}

export function makeRiver(
  seed: string,
  extent: number,
  p: RiverParams,
  base: (x: number, y: number) => number,
): River {
  const centre = centreline(seed, extent, p, base);

  const cum = [0];
  for (let i = 1; i < centre.length; i++) cum.push(cum[i - 1]! + V.dist(centre[i - 1]!, centre[i]!));
  const total = cum[cum.length - 1]!;

  // Which way is downstream? Whichever end the land is lower at, so the river
  // agrees with the overall tilt.
  const raw = centre.map((q) => base(q.x, q.y));
  const flip = raw[0]! < raw[raw.length - 1]!;
  const order = flip ? centre.slice().reverse() : centre;
  const orderedRaw = flip ? raw.slice().reverse() : raw;

  const oCum = [0];
  for (let i = 1; i < order.length; i++) oCum.push(oCum[i - 1]! + V.dist(order[i - 1]!, order[i]!));

  // Force the bed monotone: never higher than the last vertex, and always at
  // least `bedGrade` lower. A river that flows uphill is the most obvious
  // possible failure, so this is a hard construction rather than a smoothing.
  const bed: number[] = [];
  let running = orderedRaw[0]! - 2;
  for (let i = 0; i < order.length; i++) {
    const span = i === 0 ? 0 : oCum[i]! - oCum[i - 1]!;
    running = Math.min(running - span * p.bedGrade, orderedRaw[i]! - 1.4);
    bed.push(running);
  }
  const water = bed.map((h) => h + p.waterDepth);

  const river: River = {
    centre: order,
    cum: oCum,
    total,
    bed,
    water,
    channel: ribbonPolygon(order, p.width / 2),
    banks: ribbonPolygon(order, p.width / 2 + p.bankMargin),
    params: p,
  };
  return river;
}

/**
 * How much the river has cut the land at `p`, in metres of depth to remove.
 *
 * Zero beyond `valleyWidth`; at the centreline it is exactly enough to bring the
 * surrounding land down to the bed. Squared smoothstep, so the valley floor is
 * flat-ish and the sides steepen — which is what a floodplain looks like, and
 * also what leaves room for the terraces to sit on.
 */
export function riverCarve(river: River, x: number, y: number, baseHeight: number): number {
  const hit = nearestOn(river, { x, y });
  const w = river.params.valleyWidth;
  if (hit.d >= w) return 0;
  const bed = sampleAlong(river.bed, hit);
  const depth = baseHeight - bed;
  if (depth <= 0) return 0;
  const t = hit.d / w;
  const fade = 1 - t * t * (3 - 2 * t);
  return depth * fade;
}

/** Water surface height at `p`, or null when `p` is outside the channel. */
export function riverWaterAt(river: River, x: number, y: number): number | null {
  const hit = nearestOn(river, { x, y });
  if (hit.d > river.params.width / 2) return null;
  return sampleAlong(river.water, hit);
}

/** Distance from the water's edge; negative inside the channel. */
export function riverDistance(river: River, x: number, y: number): number {
  return nearestOn(river, { x, y }).d - river.params.width / 2;
}
