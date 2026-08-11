import type { Polygon, Vec2 } from '../core/types.js';
import * as V from './vec2.js';
import { area, circlePolygon, edges, isSimple, signedArea } from './polygon.js';
import { differencePoly, unionPoly } from './boolean.js';
import { cleanPolygon } from './simplify.js';

/**
 * Polygon offsetting.
 *
 * Naive miter offsetting is ~30 lines and exact on convex polygons, but it
 * self-intersects the moment the offset distance exceeds a local feature width —
 * which happens constantly (a 3 m flag-lot pole offset by 0.5 m per side is
 * already marginal). So: try the fast path, *verify it*, and fall back to a
 * boolean construction that handles self-intersection and region collapse for
 * free.
 *
 * The boolean construction is exact for round joins:
 *   the set of points within `d` of the boundary is the union, over edges, of
 *   the two-sided rectangle of half-width `d`, plus a disc of radius `d` at each
 *   vertex. Inward offset is the polygon minus that band; outward is the union.
 */

const DISC_SEGMENTS = 14;

function miterOffset(poly: Polygon, delta: number): Polygon | null {
  const es = edges(poly);
  if (es.length < 3) return null;
  const out: Polygon = [];
  for (let i = 0; i < es.length; i++) {
    const e0 = es[i]!;
    const e1 = es[(i + 1) % es.length]!;
    // Both edges shifted along their inward normals by `delta`.
    const p0 = V.addScaled(e0.a, e0.normal, delta);
    const p1 = V.addScaled(e1.a, e1.normal, delta);
    const x = V.lineIntersection(p0, e0.dir, p1, e1.dir);
    if (!x) return null;
    // Reject runaway miters at very sharp corners.
    if (V.dist(x, e0.b) > Math.abs(delta) * 8 + 1e-6) return null;
    out.push(x);
  }
  return out;
}

/** The band of points within `d` of the polygon boundary, as a multipolygon. */
function boundaryBand(poly: Polygon, d: number): Polygon[] {
  const parts: Polygon[] = [];
  for (const e of edges(poly)) {
    const n = e.normal;
    parts.push([
      V.addScaled(e.a, n, -d),
      V.addScaled(e.b, n, -d),
      V.addScaled(e.b, n, d),
      V.addScaled(e.a, n, d),
    ]);
  }
  for (const p of poly) parts.push(circlePolygon(p, d, DISC_SEGMENTS));
  return unionPoly(parts, { tolerance: 0.005, minEdge: 0.01, minArea: 1e-4 });
}

/**
 * Shrink a polygon inward by `d`. Returns zero or more components — an inward
 * offset can split a polygon in two, or eliminate it entirely.
 */
export function offsetInward(poly: Polygon, d: number): Polygon[] {
  if (d <= 1e-9) {
    const c = cleanPolygon(poly);
    return c ? [c] : [];
  }
  if (poly.length < 3) return [];

  const fast = miterOffset(poly, d);
  if (fast && fast.length >= 3 && signedArea(fast) > 0 && area(fast) < area(poly) && isSimple(fast)) {
    const c = cleanPolygon(fast);
    if (c) return [c];
  }
  return differencePoly([poly], boundaryBand(poly, d));
}

/** Grow a polygon outward by `d`. Round joins. */
export function offsetOutward(poly: Polygon, d: number): Polygon[] {
  if (d <= 1e-9) {
    const c = cleanPolygon(poly);
    return c ? [c] : [];
  }
  if (poly.length < 3) return [];

  const fast = miterOffset(poly, -d);
  if (fast && fast.length >= 3 && signedArea(fast) > 0 && area(fast) > area(poly) && isSimple(fast)) {
    const c = cleanPolygon(fast);
    if (c) return [c];
  }
  return unionPoly([poly, ...boundaryBand(poly, d)]);
}

/**
 * Inward offset with a different distance per edge — setbacks, which are never
 * uniform.
 *
 * Intersecting one half-plane per edge is the cheap way to do this and is exact
 * on a convex ring. On a concave one it is badly wrong: the plane of an edge
 * tucked behind a reflex corner runs right across the polygon, so with a dozen
 * edges the intersection collapses to nothing. Removing only the band actually
 * within `inset(i)` of edge `i` is correct either way.
 *
 * `inset` is indexed by the edge's `i`, i.e. the index of its first vertex.
 */
export function offsetInwardVariable(poly: Polygon, inset: (edgeIndex: number) => number): Polygon[] {
  const es = edges(poly);
  if (es.length < 3) return [];
  const band: Polygon[] = [];

  for (const e of es) {
    const d = inset(e.i);
    if (d <= 1e-9) continue;
    band.push([
      V.addScaled(e.a, e.normal, -d),
      V.addScaled(e.b, e.normal, -d),
      V.addScaled(e.b, e.normal, d),
      V.addScaled(e.a, e.normal, d),
    ]);
  }
  // Round joins close the band at the corners. A disc rather than an overshoot
  // along the edge, because an overshoot past a *reflex* vertex would eat into
  // the neighbouring wing of the polygon rather than into its own setback.
  for (let i = 0; i < es.length; i++) {
    const d = Math.max(inset(es[i]!.i), inset(es[(i - 1 + es.length) % es.length]!.i));
    if (d > 1e-9) band.push(circlePolygon(es[i]!.a, d, DISC_SEGMENTS));
  }

  if (band.length === 0) {
    const c = cleanPolygon(poly);
    return c ? [c] : [];
  }
  return differencePoly([poly], band);
}

/** Signed convenience wrapper: positive grows, negative shrinks. */
export const offsetPoly = (poly: Polygon, delta: number): Polygon[] =>
  delta >= 0 ? offsetOutward(poly, delta) : offsetInward(poly, -delta);

export function offsetMulti(polys: Polygon[], delta: number): Polygon[] {
  const out: Polygon[] = [];
  for (const p of polys) out.push(...offsetPoly(p, delta));
  return delta > 0 ? unionPoly(out) : out;
}

/**
 * A quad strip following the polygon boundary, from `inner` to `outer` offsets.
 * Used for parapets, curbs and kerb gutters where a full offset polygon would
 * just be thrown away.
 */
export interface BandQuad {
  inner: [Vec2, Vec2];
  outer: [Vec2, Vec2];
}

export function boundaryBandQuads(poly: Polygon, inset: number, outset: number): BandQuad[] {
  const es = edges(poly);
  const out: BandQuad[] = [];
  for (let i = 0; i < es.length; i++) {
    const e = es[i]!;
    const prev = es[(i - 1 + es.length) % es.length]!;
    const next = es[(i + 1) % es.length]!;
    const shift = (base: Vec2, dir: Vec2, other: { a: Vec2; dir: Vec2; normal: Vec2 }, dist: number, atStart: boolean): Vec2 => {
      const p0 = V.addScaled(base, e.normal, dist);
      const p1 = V.addScaled(other.a, other.normal, dist);
      const x = V.lineIntersection(p0, dir, p1, other.dir);
      // Fall back to the un-mitred point at pathological corners.
      return x && V.dist(x, atStart ? e.a : e.b) < Math.abs(dist) * 6 + 1e-6 ? x : p0;
    };
    out.push({
      inner: [
        shift(e.a, e.dir, prev, inset, true),
        shift(e.b, e.dir, next, inset, false),
      ],
      outer: [
        shift(e.a, e.dir, prev, -outset, true),
        shift(e.b, e.dir, next, -outset, false),
      ],
    });
  }
  return out;
}
