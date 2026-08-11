import type { Polygon, Vec2 } from '../core/types.js';
import * as V from './vec2.js';
import { area, ensureCCW, isSimple } from './polygon.js';

/**
 * Polygon hygiene.
 *
 * Boolean and offset operations emit collinear vertices and millimetre slivers.
 * If those reach façade generation you get zero-length wall panels, NaN normals
 * and whole chunks disappearing — the single most common source of visual
 * glitches in this kind of pipeline. Everything that leaves `geom/` runs
 * through `cleanPolygon`.
 */

/** Drop vertices whose distance to the previous kept vertex is below `minLen`. */
export function removeShortEdges(poly: Polygon, minLen = 0.05): Polygon {
  if (poly.length < 3) return poly;
  const out: Polygon = [];
  for (const p of poly) {
    if (out.length === 0 || V.dist(out[out.length - 1]!, p) >= minLen) out.push(p);
  }
  // The closing edge may now be too short; drop the last vertex rather than the first,
  // which would shift the ring's start and make results order-dependent.
  while (out.length > 3 && V.dist(out[out.length - 1]!, out[0]!) < minLen) out.pop();
  return out.length >= 3 ? out : poly;
}

/** Merge consecutive edges whose turn angle is below `maxAngle` radians. */
export function mergeCollinear(poly: Polygon, maxAngle = 0.5 * (Math.PI / 180)): Polygon {
  if (poly.length < 4) return poly;
  const keep: boolean[] = new Array(poly.length).fill(true);
  let removed = 0;
  for (let i = 0; i < poly.length; i++) {
    // Compare against the nearest kept neighbours so a run of collinear points collapses.
    let prev = i - 1;
    while (prev !== i && !keep[((prev % poly.length) + poly.length) % poly.length]) prev--;
    let next = i + 1;
    while (next !== i && !keep[next % poly.length]) next++;
    const a = poly[((prev % poly.length) + poly.length) % poly.length]!;
    const b = poly[i]!;
    const c = poly[next % poly.length]!;
    if (poly.length - removed <= 3) break;
    const d1 = V.sub(b, a);
    const d2 = V.sub(c, b);
    if (V.len(d1) < 1e-9 || V.len(d2) < 1e-9) {
      keep[i] = false;
      removed++;
      continue;
    }
    if (V.angleBetween(d1, d2) <= maxAngle) {
      keep[i] = false;
      removed++;
    }
  }
  const out = poly.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : poly;
}

/** Douglas–Peucker applied to a closed ring, anchored at its two extreme vertices. */
export function simplifyPolygon(poly: Polygon, tolerance = 0.02): Polygon {
  if (poly.length < 5 || tolerance <= 0) return poly;

  // Anchor at the two mutually most distant vertices so the split is stable.
  let ai = 0;
  let bi = 0;
  let bestSq = -1;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const d = V.distSq(poly[i]!, poly[j]!);
      if (d > bestSq) {
        bestSq = d;
        ai = i;
        bi = j;
      }
    }
  }
  const chainA = sliceRing(poly, ai, bi);
  const chainB = sliceRing(poly, bi, ai);
  const outA = douglasPeucker(chainA, tolerance);
  const outB = douglasPeucker(chainB, tolerance);
  const out = [...outA.slice(0, -1), ...outB.slice(0, -1)];
  return out.length >= 3 ? out : poly;
}

function sliceRing(poly: Polygon, from: number, to: number): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  let i = from;
  for (;;) {
    out.push(poly[i]!);
    if (i === to) break;
    i = (i + 1) % n;
  }
  return out;
}

function douglasPeucker(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length < 3) return pts;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let maxD = -1;
  let idx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = V.distToSegment(pts[i]!, first, last);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tolerance || idx < 0) return [first, last];
  const left = douglasPeucker(pts.slice(0, idx + 1), tolerance);
  const right = douglasPeucker(pts.slice(idx), tolerance);
  return [...left.slice(0, -1), ...right];
}

export interface CleanOptions {
  /** Douglas–Peucker tolerance, metres. */
  tolerance?: number;
  /** Edges shorter than this are collapsed, metres. */
  minEdge?: number;
  /** Turn angles below this are merged away, radians. */
  maxTurn?: number;
  /** Polygons with less area than this are rejected entirely. */
  minArea?: number;
}

/**
 * The mandatory exit path for every polygon produced by a boolean or offset.
 * Returns `null` for anything degenerate so callers must handle it explicitly.
 */
export function cleanPolygon(poly: Polygon, opts: CleanOptions = {}): Polygon | null {
  const { tolerance = 0.02, minEdge = 0.05, maxTurn = 0.7 * (Math.PI / 180), minArea = 0.02 } = opts;
  if (!poly || poly.length < 3) return null;
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }
  let out = removeShortEdges(poly, minEdge);
  out = simplifyPolygon(out, tolerance);
  out = mergeCollinear(out, maxTurn);
  out = removeShortEdges(out, minEdge);
  if (out.length < 3) return null;
  if (area(out) < minArea) return null;
  return ensureCCW(out);
}

export function cleanAll(polys: Polygon[], opts: CleanOptions = {}): Polygon[] {
  const out: Polygon[] = [];
  for (const p of polys) {
    const c = cleanPolygon(p, opts);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Development-time assertion. Returns a problem description, or null when the
 * polygon is safe to hand to geometry builders.
 */
export function validatePolygon(poly: Polygon, label = 'polygon'): string | null {
  if (!poly || poly.length < 3) return `${label}: fewer than 3 vertices`;
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return `${label}: non-finite vertex`;
  }
  if (area(poly) < 1e-6) return `${label}: zero area`;
  if (!isSimple(poly)) return `${label}: self-intersecting`;
  for (let i = 0, n = poly.length; i < n; i++) {
    if (V.dist(poly[i]!, poly[(i + 1) % n]!) < 1e-6) return `${label}: zero-length edge at ${i}`;
  }
  return null;
}
