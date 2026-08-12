import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type LandUseParams, type RoadClass, type RoadParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { clipSegmentToPolygonAll } from '../geom/polygon.js';
import { makeFrame, toWorld, extentsIn, type Frame } from '../geom/obb.js';
import { centroid } from '../geom/polygon.js';
import type { District, DistrictBoundary } from './RoadDistricts.js';
import { roadWidth } from './Roads.js';

/**
 * Tier-2: the residential grid inside one district.
 *
 * Everything here happens in the district's own frame, so the grid is exactly
 * orthogonal and exactly regular by construction — no warp field, no
 * accumulated drift. The town's irregularity comes from districts pointing
 * different ways, not from bending the streets inside them, which is why the
 * houses can line up and the town can still look organic.
 *
 * The three Japanese habits worth keeping — 食い違い staggers, dead ends, and
 * streets that bend once — are applied in ways that preserve that: a stagger
 * moves a whole street line, and a bend sits *on* a junction, so every block
 * edge stays straight and every lot along a run keeps one exact frontage
 * direction.
 */

export interface StreetLine {
  pts: Vec2[];
  cls: RoadClass;
}

/** A polyline with cumulative arclength, so spans can be addressed by distance. */
interface Path {
  pts: Vec2[];
  cum: number[];
  total: number;
}

function makePath(pts: Vec2[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + V.dist(pts[i - 1]!, pts[i]!));
  return { pts, cum, total: cum[cum.length - 1]! };
}

function pointAtS(path: Path, s: number): Vec2 {
  const t = Math.min(path.total, Math.max(0, s));
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i]! < t) i++;
  const s0 = path.cum[i - 1]!;
  const s1 = path.cum[i]!;
  const f = s1 - s0 < 1e-9 ? 0 : (t - s0) / (s1 - s0);
  return V.lerp(path.pts[i - 1]!, path.pts[i]!, f);
}

/** Direction of the path at arclength `s`. */
function dirAtS(path: Path, s: number): Vec2 {
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i]! < s) i++;
  return V.normalize(V.sub(path.pts[i]!, path.pts[i - 1]!));
}

/** Arclengths at which two paths cross. */
function crossings(a: Path, b: Path): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < a.pts.length; i++) {
    for (let j = 0; j + 1 < b.pts.length; j++) {
      const x = V.segmentIntersection(a.pts[i]!, a.pts[i + 1]!, b.pts[j]!, b.pts[j + 1]!, 1e-9);
      if (!x) continue;
      out.push(a.cum[i]! + x.ta * (a.cum[i + 1]! - a.cum[i]!));
    }
  }
  return out;
}

/** The arclength intervals of `path` that lie inside `poly`. */
function insideRuns(path: Path, poly: Polygon): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i + 1 < path.pts.length; i++) {
    const a = path.pts[i]!;
    const b = path.pts[i + 1]!;
    const segLen = path.cum[i + 1]! - path.cum[i]!;
    if (segLen < 1e-9) continue;
    for (const [p, q] of clipSegmentToPolygonAll(poly, a, b)) {
      const s0 = path.cum[i]! + (V.dist(a, p) / segLen) * segLen;
      const s1 = path.cum[i]! + (V.dist(a, q) / segLen) * segLen;
      runs.push([Math.min(s0, s1), Math.max(s0, s1)]);
    }
  }
  runs.sort((x, y) => x[0] - y[0]);

  // A run ending where the next begins is one run that happened to span a
  // vertex of the path.
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 0.05) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * Positions of the grid lines along one axis, spanning `[-half, half]`, with
 * every gap drawn independently within ±`variation` of `spacing`.
 *
 * The gaps are rescaled to land exactly on both ends, which keeps the
 * *relative* variation between neighbouring streets — what reads as "a grid
 * fitted to the parcels it replaced" — without letting accumulated error decide
 * where the last street lands. The floor is applied after the rescale as well
 * as before, because the rescale can push a gap back under it.
 */
export function gridLines(
  rng: Rng,
  half: number,
  spacing: number,
  variation: number,
  minSpacing: number,
): number[] {
  const span = half * 2;
  const n = Math.max(1, Math.round(span / spacing));
  const floor = Math.min(minSpacing, span / n);
  const gaps = Array.from({ length: n }, () =>
    Math.max(floor, spacing * (1 + rng.range(-variation, variation))),
  );
  const scale = span / gaps.reduce((s, g) => s + g, 0);
  const scaled = gaps.map((g) => Math.max(floor, g * scale));

  const pos: number[] = [-half];
  for (let i = 0; i < n; i++) pos.push(pos[i]! + scaled[i]!);
  pos[n] = half;
  return pos;
}

/**
 * Assign a road class to each grid line: collectors roughly every
 * `collectorSpacing`, the rest local. In a planned layout the hierarchy has to
 * live *on* the grid lines — a separately drawn collector would slice every
 * block it crossed into slivers.
 */
export function classifyLines(rng: Rng, count: number, p: RoadParams, spacing = p.localSpacing): RoadClass[] {
  const cls: RoadClass[] = Array.from({ length: count }, () => 'local');
  const step = Math.max(2, Math.round(p.collectorSpacing / spacing));
  const phase = rng.int(step);
  for (let i = 0; i < count; i++) if ((i + phase) % step === 0) cls[i] = 'collector';
  return cls;
}

/**
 * Build one family of parallel streets in the district frame.
 *
 * `along` is the axis the streets run down (0 = local +u, 1 = local +v); the
 * lines are placed at intervals across the other axis.
 */
function buildFamily(
  rng: Rng,
  frame: Frame,
  positions: number[],
  runFrom: number,
  runTo: number,
  along: 0 | 1,
  classes: RoadClass[],
  p: RoadParams,
): { path: Path; cls: RoadClass }[] {
  const local = (across: number, down: number): Vec2 =>
    toWorld(along === 0 ? { x: down, y: across } : { x: across, y: down }, frame);

  const out: { path: Path; cls: RoadClass }[] = [];
  positions.forEach((across, i) => {
    const pts: Vec2[] = [local(across, runFrom)];
    let offset = 0;
    let slope = 0;

    // A 食い違い moves the whole line sideways from one junction onward, which
    // turns a crossroads into a pair of offset T-junctions without bending
    // anything. Displacing a single lattice node — which is what used to happen
    // — bends the four streets meeting there instead.
    const stagger = rng.chance(p.staggerFraction);
    // A single bend, also seated on a junction so every block edge stays
    // straight and the houses along each run stay aligned.
    const bend = rng.chance(p.localBendChance);

    if (stagger || bend) {
      const at = runFrom + (runTo - runFrom) * rng.range(0.3, 0.7);
      pts.push(local(across, at));
      if (stagger) offset = rng.range(0.5, 1) * p.staggerDistance * (rng.chance(0.5) ? 1 : -1);
      if (bend) slope = Math.tan(rng.jitter(p.localBendAngle * DEG));
      pts.push(local(across + offset, at));
      pts.push(local(across + offset + slope * (runTo - at), runTo));
    } else {
      pts.push(local(across, runTo));
    }

    // The stagger introduces a zero-length sideways jump in world space only if
    // `offset` is zero; drop the duplicate so the path stays well formed.
    const clean = pts.filter((q, k) => k === 0 || V.dist(q, pts[k - 1]!) > 1e-6);
    if (clean.length < 2) return;
    out.push({ path: makePath(clean), cls: classes[i] ?? 'local' });
  });
  return out;
}

/**
 * How a street line relates to one boundary road of its district.
 *
 * The distinction drives everything about how the grid meets the district edge,
 * and getting it wrong in either direction is visible: treat a crossing line as
 * parallel and the district loses its connection to the arterial; treat a
 * parallel line as a crossing and you get a 4 m ribbon of leftover ground
 * running the length of every main road.
 */
function boundaryVerdict(
  path: Path,
  boundary: DistrictBoundary[],
  p: RoadParams,
  spacing: number,
): { drop: boolean } {
  const minAngle = p.minJunctionAngle * DEG;
  for (const b of boundary) {
    const bPath = makePath([b.a, b.b]);
    if (crossings(path, bPath).length > 0) continue; // it meets this road; fine.

    // Running alongside. A street parallel to a main road has to be a block
    // away from it, not a clearance away: the gap between them is where the
    // lots go, and at 4 m there is no room for any.
    let gap = Infinity;
    for (let i = 0; i + 1 < path.pts.length; i++) {
      gap = Math.min(gap, V.segmentDistance(path.pts[i]!, path.pts[i + 1]!, b.a, b.b));
    }
    if (gap === Infinity) continue;
    const dir = V.normalize(V.sub(path.pts[path.pts.length - 1]!, path.pts[0]!));
    const ang = V.angleBetween(dir, b.dir);
    const parallel = Math.min(ang, Math.PI - ang) < minAngle;
    if (parallel && gap < b.width / 2 + spacing * 0.7) return { drop: true };
  }
  return { drop: false };
}

/**
 * How far past the district boundary a street has to run to make a junction.
 *
 * `makePlanar` deliberately ignores an intersection that lands on an endpoint,
 * so a street stopping exactly on the boundary road would never split it and
 * the two would never connect — the street would have no frontage on the road
 * it fronts. Overshooting the centreline makes it a genuine interior crossing
 * on both edges; the stub left on the far side is shorter than the 6 m
 * minimum-fragment filter in `generateRoads`, which removes it.
 */
const BOUNDARY_OVERSHOOT = 3;

/** Retraction needed for a street meeting a road at `alpha`, so ribbons clear. */
function acuteRetraction(alpha: number, boundaryWidth: number, localWidth: number, clearance: number): number {
  const s = Math.sin(alpha);
  const t = Math.tan(alpha);
  if (s < 1e-6 || t < 1e-6) return Infinity;
  return boundaryWidth / 2 / s + localWidth / 2 / t + clearance;
}

/** The boundary edge a point sits on, if any. */
function boundaryAt(boundary: DistrictBoundary[], p: Vec2, tol = 1.5): DistrictBoundary | null {
  let best: DistrictBoundary | null = null;
  let bestD = tol;
  for (const b of boundary) {
    const d = V.distToSegment(p, b.a, b.b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Lay out the local streets of one district. */
export function districtStreets(d: District, p: RoadParams, landUse: LandUseParams): StreetLine[] {
  if (d.area < p.minDistrictArea) return [];

  // 用途地域 reaches the street network here, and this is the only place it
  // does. A factory parcel is 3,000-4,000 m²; the ordinary 45 m grid yields
  // blocks of 1,500-2,000 m², and `Blocks.maxArea` would cut anything larger
  // anyway. No lot parameter can produce an industrial parcel behind a
  // residential street grid, so the zone has to coarsen the streets themselves.
  const spacing = d.zone === 'industrial' ? landUse.industrialLocalSpacing : p.localSpacing;

  const rng = makeRng(subSeed(d.seed, 'grid'));
  const frame = makeFrame(centroid(d.polygon), d.axis);
  const ext = extentsIn(d.polygon, frame);
  if (ext.w < p.minLocalSpacing || ext.d < p.minLocalSpacing) return [];

  // Streets down the district's long axis and across it. `gridLines` returns
  // both ends of the span too; those land on the boundary, where the boundary
  // road already is, so they are dropped.
  const us = gridLines(rng, ext.w / 2, spacing, p.gridSpacingVariation, p.minLocalSpacing)
    .map((u) => u + ext.cx)
    .slice(1, -1);
  const vs = gridLines(rng, ext.d / 2, spacing, p.gridSpacingVariation, p.minLocalSpacing)
    .map((v) => v + ext.cy)
    .slice(1, -1);

  const uCls = p.promoteGridLines
    ? classifyLines(rng, us.length, p, spacing)
    : (Array.from({ length: us.length }, () => 'local') as RoadClass[]);
  const vCls = p.promoteGridLines
    ? classifyLines(rng, vs.length, p, spacing)
    : (Array.from({ length: vs.length }, () => 'local') as RoadClass[]);

  // Run the lines well past the district so they always reach its boundary.
  const pad = spacing;
  const family = [
    ...buildFamily(rng, frame, us, ext.cy - ext.d / 2 - pad, ext.cy + ext.d / 2 + pad, 1, uCls, p),
    ...buildFamily(rng, frame, vs, ext.cx - ext.w / 2 - pad, ext.cx + ext.w / 2 + pad, 0, vCls, p),
  ];

  const kept = family.filter((line) => !boundaryVerdict(line.path, d.boundary, p, spacing).drop);

  // Every junction becomes an explicit shared node: cut each line at its
  // crossings with the others up front rather than leaving it to `makePlanar`.
  const out: StreetLine[] = [];
  for (const line of kept) {
    const cuts: number[] = [];
    for (const other of kept) {
      if (other === line) continue;
      cuts.push(...crossings(line.path, other.path));
    }

    for (const [runStart, runEnd] of insideRuns(line.path, d.polygon)) {
      // Where the run meets the district boundary, push through the centreline
      // so a real junction forms; where it meets it too sharply for the ribbons
      // to clear, pull back and dead-end instead.
      const ends = [runStart, runEnd].map((s, k) => {
        const outward = k === 0 ? -1 : 1;
        const b = boundaryAt(d.boundary, pointAtS(line.path, s));
        if (!b) return s;
        const alpha = (() => {
          const dir = dirAtS(line.path, s);
          const a = V.angleBetween(dir, b.dir);
          return Math.min(a, Math.PI - a);
        })();
        if (alpha < p.minJunctionAngle * DEG) {
          const back = acuteRetraction(alpha, b.width, roadWidth(line.cls, p), p.roadClearance);
          return s - outward * Math.min(back, (runEnd - runStart) * 0.45);
        }
        return s + outward * (b.width / 2 + BOUNDARY_OVERSHOOT);
      });
      const from = ends[0]!;
      const to = ends[1]!;
      if (to - from < p.minEdgeLength) continue;

      const stops = [from, ...cuts.filter((s) => s > from + 0.5 && s < to - 0.5).sort((a, b) => a - b), to];
      for (let i = 0; i + 1 < stops.length; i++) {
        const s0 = stops[i]!;
        const s1 = stops[i + 1]!;
        if (s1 - s0 < 1e-6) continue;

        // Thin the network a span at a time, and let terminal spans stop short
        // — a 行き止まり is a feature of these streets, not a defect.
        if (rng.chance(p.deleteFraction)) continue;
        const terminal = i === 0 || i + 2 === stops.length;
        let end = s1;
        let start = s0;
        if (terminal && rng.chance(p.deadEndFraction)) {
          const keep = (s1 - s0) * rng.range(0.55, 0.75);
          if (i === 0) start = s1 - keep;
          else end = s0 + keep;
        }
        if (end - start < p.minEdgeLength) continue;
        out.push({ pts: [pointAtS(line.path, start), pointAtS(line.path, end)], cls: line.cls });
      }
    }
  }
  return out;
}
