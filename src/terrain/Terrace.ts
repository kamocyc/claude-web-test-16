import type { Polygon, Vec2 } from '../core/types.js';
import type { TerraceParams } from '../core/params.js';
import { makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { ribbonPolygon } from './River.js';

/**
 * 段丘崖 — the scarps between river terraces.
 *
 * A 河岸段丘 is the abandoned floors of the same valley, so the scarps run
 * *parallel to the river*, one on each side, each a few metres high. Generated
 * any other way — as free-standing walls placed by noise — they read as
 * quarrying rather than as geology, and the town built on them makes no sense.
 *
 * The band is one grid cell wide on purpose. Four metres of rise over four
 * metres of ground is 45°: no road will cross it except very obliquely, no lot
 * will straddle it without a 擁壁, and the bilinear sampler can still represent
 * it. A narrower band would be smoothed into the same 45° anyway, so claiming
 * one would be a lie.
 */

export interface TerraceLine {
  /** Polyline crossing the whole town, oriented so `step` raises its left side. */
  pts: Vec2[];
  /** Height gained crossing from the right side to the left, metres. */
  step: number;
  width: number;
  /** The scarp face itself, as a polygon — nothing may be built inside it. */
  band: Polygon;
}

export interface TerraceHit {
  line: TerraceLine;
  /** Perpendicular distance to the scarp centreline. */
  distance: number;
  step: number;
}

/**
 * Signed perpendicular distance to a scarp: positive on its left.
 *
 * "Left" is well defined because every terrace line crosses the whole town, so
 * the plane really is cut in two — which is the property that lets the step be a
 * piecewise-constant offset rather than a field that has to be integrated.
 */
function signedDistance(line: TerraceLine, x: number, y: number): number {
  const p = { x, y };
  const pts = line.pts;
  let bestD = Infinity;
  let bestSign = 1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const c = V.closestOnSegment(p, a, b);
    const d = V.dist(p, c.point);
    if (d < bestD) {
      bestD = d;
      bestSign = V.cross(V.sub(b, a), V.sub(p, a)) >= 0 ? 1 : -1;
    }
  }
  return bestD * bestSign;
}

/**
 * Offset a polyline sideways and give it two or three decisive bends.
 *
 * The bends are the same idea `RoadSkeleton.bentLine` uses for a 幹線道路, and
 * for the same reason: a scarp built from an independent random offset per
 * vertex is a random walk, and reads as a crumpled sheet rather than as an edge
 * the river left behind.
 */
function offsetAndBend(source: Vec2[], offset: number, bend: number, seed: string): Vec2[] {
  const rng = makeRng(seed);
  const n = source.length;
  const bends = [rng.range(0.25, 0.45), rng.range(0.55, 0.8)];
  // The bend always pushes *away* from the source line, never back across it.
  // A symmetric wander would let a scarp swing over the river it is supposed to
  // flank, which is both geological nonsense and a step through the water.
  const away = Math.sign(offset) * Math.abs(bend);
  return source.map((q, i) => {
    const a = source[Math.max(0, i - 1)]!;
    const b = source[Math.min(n - 1, i + 1)]!;
    const nrm = V.perp(V.normalize(V.sub(b, a)));
    const t = i / (n - 1);
    // A piecewise-linear wander with two knees, scaled by `bend`.
    let extra = 0;
    for (const k of bends) extra += Math.max(0, 1 - Math.abs(t - k) * 3.2);
    return V.addScaled(q, nrm, offset + extra * away);
  });
}

export function makeTerraces(
  seed: string,
  extent: number,
  p: TerraceParams,
  riverCentre: Vec2[] | null,
  /** Minimum lateral offset from the source line — the width of the floodplain. */
  keepClear = 0,
): TerraceLine[] {
  if (p.count <= 0) return [];
  const rng = makeRng(subSeed(seed, 'terraces'));

  // Without a river there is nothing for a river terrace to be a terrace of, so
  // fall back to a straight line across the town in a random direction. It is
  // no longer geology, but it is still a scarp, and turning the river off should
  // not silently turn the cliffs off too.
  const source =
    riverCentre ??
    (() => {
      const dir = V.fromAngle(rng.range(0, Math.PI));
      const reach = extent * 1.6;
      const out: Vec2[] = [];
      for (let i = 0; i <= 24; i++) {
        out.push(V.scale(dir, -reach + (i / 24) * reach * 2));
      }
      return out;
    })();

  const lines: TerraceLine[] = [];
  for (let i = 0; i < p.count; i++) {
    // Alternate sides, so the valley is flanked rather than stepped one way.
    const side = i % 2 === 0 ? 1 : -1;
    const rank = Math.floor(i / 2);
    const frac = p.minOffset + (p.maxOffset - p.minOffset) * (rank / Math.max(1, p.count / 2));
    const offset = side * Math.max(keepClear, frac * extent + rng.range(-24, 24));
    const pts = offsetAndBend(source, offset, rng.range(30, 70), subSeed(seed, 'terrace', i));
    const step = Math.max(1.2, p.step + rng.jitter(p.stepVariation)) * side;
    lines.push({ pts, step, width: p.width, band: ribbonPolygon(pts, p.width / 2) });
  }
  return lines;
}

/**
 * Height contributed by one scarp at a point: 0 on its low side, `step` on its
 * high side, and a smoothstep across the band between.
 */
export function terraceStep(line: TerraceLine, x: number, y: number): number {
  const sd = signedDistance(line, x, y);
  const half = line.width / 2;
  if (sd <= -half) return line.step < 0 ? Math.abs(line.step) : 0;
  if (sd >= half) return line.step > 0 ? line.step : 0;
  const t = (sd + half) / line.width;
  const s = t * t * (3 - 2 * t);
  return line.step > 0 ? line.step * s : Math.abs(line.step) * (1 - s);
}

/** The nearest scarp within `within` metres, or null. */
export function nearestTerrace(
  lines: readonly TerraceLine[],
  x: number,
  y: number,
  within: number,
): TerraceHit | null {
  let best: TerraceHit | null = null;
  for (const line of lines) {
    const d = Math.abs(signedDistance(line, x, y));
    if (d > within) continue;
    if (!best || d < best.distance) best = { line, distance: d, step: Math.abs(line.step) };
  }
  return best;
}
