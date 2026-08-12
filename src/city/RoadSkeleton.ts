import type { Vec2 } from '../core/types.js';
import { DEG, type RoadClass, type RoadParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import type { Terrain } from '../terrain/Terrain.js';
import type { ObstacleField } from '../terrain/Obstacles.js';

/**
 * Tier-1: the roads that decide the shape of the town.
 *
 * A real 幹線道路 is straight for hundreds of metres and then turns once,
 * decisively. The old generator built one from six control points each carrying
 * an independent 22 m Gaussian and smoothed the result — which is a random
 * walk, not a road, and it is the whole reason the street directions read as
 * wrong. Here a Tier-1 road is a polyline with two or three vertices and a hard
 * cap on how far it may turn at each.
 *
 * The skeleton also has to be *self-consistent* before anything is built on it:
 * two arterials that graze each other, or cross at 20°, produce overlapping
 * asphalt and sliver blocks that no downstream stage can repair. Both are
 * rejected here by construction rather than cleaned up later.
 */

export interface SkeletonLine {
  pts: Vec2[];
  cls: RoadClass;
  /**
   * Which growth step laid this road. Always 0 from the one-shot generator
   * below — a planned 区画整理 town has no history, which is exactly what makes
   * it a planned town.
   */
  gen: number;
}

export interface Skeleton {
  lines: SkeletonLine[];
  station: Vec2;
  /** The town's base direction. Districts are variations on it. */
  townAxis: number;
}

/** Split a polyline into the runs that lie inside the square [-e, e]^2. */
export function clipToSquare(line: Vec2[], e: number): Vec2[][] {
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];

  const inside = (p: Vec2) => Math.abs(p.x) <= e + 1e-9 && Math.abs(p.y) <= e + 1e-9;
  /** Where segment a–b crosses the boundary, walking from `a`. */
  const crossing = (a: Vec2, b: Vec2): Vec2 | null => {
    let bestT = Infinity;
    for (const [axis, lim] of [
      ['x', -e],
      ['x', e],
      ['y', -e],
      ['y', e],
    ] as const) {
      const da = a[axis];
      const db = b[axis];
      if (Math.abs(db - da) < 1e-12) continue;
      const t = (lim - da) / (db - da);
      if (t <= 1e-9 || t > 1 + 1e-9) continue;
      const p = V.lerp(a, b, t);
      if (!inside(p)) continue;
      if (t < bestT) bestT = t;
    }
    return bestT === Infinity ? null : V.lerp(a, b, bestT);
  };

  for (let i = 0; i < line.length; i++) {
    const p = line[i]!;
    if (inside(p)) {
      // Entering: start the run on the boundary, not at the first inside
      // sample, so a Tier-1 road actually reaches the town edge and closes the
      // outermost faces.
      if (cur.length === 0 && i > 0) {
        const x = crossing(p, line[i - 1]!);
        if (x) cur.push(x);
      }
      cur.push(p);
    } else {
      if (cur.length > 0) {
        const x = crossing(cur[cur.length - 1]!, p);
        if (x) cur.push(x);
        if (cur.length > 1) runs.push(cur);
        cur = [];
      }
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

/**
 * A long road as a handful of vertices: a base direction, a perpendicular
 * offset, and `bends` turns of at most `maxBend` each.
 *
 * Built well past the town so that after clipping it spans edge to edge — a
 * Tier-1 road that stops short becomes a spur, gets pruned from the face walk,
 * and its district silently merges with its neighbour.
 */
function bentLine(rng: Rng, angle: number, offset: number, reach: number, p: RoadParams): Vec2[] {
  const dir0 = V.fromAngle(angle);
  const start = V.addScaled(V.scale(dir0, -reach), V.perp(dir0), offset);

  const ts = Array.from({ length: p.tier1BendCount }, () => rng.range(0.28, 0.72)).sort(
    (a, b) => a - b,
  );

  const pts: Vec2[] = [start];
  let dir = dir0;
  let at = start;
  let travelled = 0;
  for (const t of ts) {
    const target = t * reach * 2;
    if (target - travelled < reach * 0.15) continue;
    at = V.addScaled(at, dir, target - travelled);
    travelled = target;
    pts.push(at);
    const turn = rng.gaussClamped(0, p.tier1MaxBend / 2.5, -p.tier1MaxBend, p.tier1MaxBend);
    dir = V.rotate(dir, turn * DEG);
  }
  pts.push(V.addScaled(at, dir, reach * 2 - travelled));
  return pts;
}

/** Smallest gap between two polylines, ignoring the fact that they may cross. */
function polylineGap(a: Vec2[], b: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const d = V.segmentDistance(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Sharpest angle at which two polylines cross, in radians; PI if they never do. */
function sharpestCrossing(a: Vec2[], b: Vec2[]): number {
  let sharpest = Math.PI;
  for (let i = 0; i + 1 < a.length; i++) {
    const da = V.sub(a[i + 1]!, a[i]!);
    for (let j = 0; j + 1 < b.length; j++) {
      const db = V.sub(b[j + 1]!, b[j]!);
      if (!V.segmentIntersection(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!, 1e-9)) continue;
      const ang = V.angleBetween(da, db);
      // Direction is arbitrary, so 170° between the stored directions is a 10°
      // crossing.
      sharpest = Math.min(sharpest, Math.min(ang, Math.PI - ang));
    }
  }
  return sharpest;
}

/**
 * Would this line sit badly against the ones already placed?
 *
 * Two rules, and they are the ones the old generator had no equivalent of:
 * never run alongside an existing Tier-1 road, and never cross one at a sliver
 * angle. Where two lines legitimately cross the gap is zero, so the spacing
 * test only applies away from a crossing.
 */
function acceptable(line: Vec2[], placed: SkeletonLine[], p: RoadParams): boolean {
  const minAngle = p.minJunctionAngle * DEG;
  for (const other of placed) {
    const cross = sharpestCrossing(line, other.pts);
    if (cross < minAngle) return false;
    // Lines that cross are allowed to touch; lines that do not must keep apart.
    if (cross >= Math.PI - 1e-9 && polylineGap(line, other.pts) < p.tier1MinSpacing) return false;
  }
  return true;
}

/** How far a Tier-1 road runs past the perimeter so their crossing is real. */
export const PERIMETER_OVERSHOOT = 4;

export function generateSkeleton(
  seed: string,
  p: RoadParams,
  terrain: Terrain,
  obstacles: ObstacleField,
): Skeleton {
  void terrain;
  void obstacles;
  const rng = makeRng(subSeed(seed, 'roads', 'skeleton'));
  const E = p.extent;
  const reach = E * 1.6;
  const townAxis = rng.jitter(p.townAxisJitter * DEG);
  const lines: SkeletonLine[] = [];

  // The perimeter. `extractFaces` throws away the single clockwise outer cycle,
  // so without a ring the outermost region is not a face at all and there are
  // no boundary districts — the town ends in a ragged fringe of half-blocks.
  if (p.perimeterRoad) {
    const c: Vec2[] = [
      { x: -E, y: -E },
      { x: E, y: -E },
      { x: E, y: E },
      { x: -E, y: E },
    ];
    for (let i = 0; i < 4; i++) {
      lines.push({ pts: [c[i]!, c[(i + 1) % 4]!], cls: p.perimeterClass, gen: 0 });
    }
  }

  /** Try `tries` placements of a line and keep the first that fits. */
  const place = (make: (r: Rng) => Vec2[], cls: RoadClass, tries: number): Vec2[] | null => {
    for (let k = 0; k < tries; k++) {
      const candidate = make(rng);
      if (!acceptable(candidate, lines, p)) continue;
      lines.push({ pts: candidate, cls, gen: 0 });
      return candidate;
    }
    return null;
  };

  // --- Arterials -----------------------------------------------------------
  const arterials: Vec2[][] = [];
  for (let i = 0; i < p.arterialCount; i++) {
    const angle = townAxis + (i % 2) * (Math.PI / 2);
    const line = place(
      (r) => bentLine(r, angle, r.range(-0.42, 0.42) * E * 2, reach, p),
      'arterial',
      40,
    );
    if (line) arterials.push(line);
  }

  // --- Collectors ----------------------------------------------------------
  // Enough to break the town into districts of roughly `collectorSpacing`.
  const nCollectors = Math.max(0, Math.round((E * 2) / p.collectorSpacing) - 1);
  for (let i = 0; i < nCollectors; i++) {
    const angle = townAxis + (i % 2) * (Math.PI / 2);
    place((r) => bentLine(r, angle, r.range(-0.44, 0.44) * E * 2, reach, p), 'collector', 40);
  }

  // --- Diagonals -----------------------------------------------------------
  // The older road the grid was laid out around. As Tier-1 it *cuts* districts,
  // so their grids terminate on it; drawn over a finished grid instead — which
  // is what used to happen — it slices every block it crosses into slivers.
  const flip = rng.chance(0.5) ? 1 : -1;
  for (let i = 0; i < p.diagonalCount; i++) {
    const sign = i % 2 === 0 ? flip : -flip;
    place(
      (r) =>
        bentLine(r, townAxis + r.range(32, 58) * DEG * sign, r.range(-0.4, 0.4) * E * 2, reach, p),
      'collector',
      40,
    );
  }

  // --- Station -------------------------------------------------------------
  // On an arterial, biased toward the middle of the town.
  const host = arterials[0];
  let station: Vec2 = { x: 0, y: 0 };
  if (host) {
    const inside = clipToSquare(host, E)[0];
    if (inside && inside.length > 0) {
      station = inside[Math.min(inside.length - 1, Math.floor(inside.length * rng.range(0.35, 0.65)))]!;
    }
  }

  // Clip everything to the town square — but a hair *outside* it, because
  // `makePlanar` deliberately ignores an intersection landing on an endpoint.
  // A road stopping exactly on the perimeter would therefore never split it,
  // its end node would have degree 1, and `findSpurs` would prune the whole
  // road out of the face walk: the districts either side of it would silently
  // merge. Overshooting makes it a real crossing; `generateRoads` discards the
  // stubs left outside.
  const clipped: SkeletonLine[] = [];
  for (const line of lines) {
    const isPerimeter = line.pts.length === 2 && line.pts.every((q) => Math.abs(Math.abs(q.x) - E) < 1e-6 || Math.abs(Math.abs(q.y) - E) < 1e-6);
    for (const run of clipToSquare(line.pts, isPerimeter ? E : E + PERIMETER_OVERSHOOT)) {
      if (run.length > 1) clipped.push({ pts: run, cls: line.cls, gen: line.gen });
    }
  }

  return { lines: clipped, station, townAxis };
}
