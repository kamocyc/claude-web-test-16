import type { Polygon, Vec2 } from '../core/types.js';
import * as V from './vec2.js';
import { area, bbox, isConvex } from './polygon.js';
import { intersectPoly, unionPoly } from './boolean.js';
import { cleanPolygon } from './simplify.js';

/**
 * Half-plane clipping — the workhorse of lot subdivision and setback
 * computation.
 *
 * Setbacks and road rights-of-way are *not* uniform offsets: each edge is
 * pushed in by its own distance. That is exactly an intersection of half-planes,
 * which is both cheaper and more exact than calling an offsetter.
 *
 * Sutherland–Hodgman is used for convex subjects, where it is exact. Concave
 * subjects would come back as a degenerate ring with zero-width bridges, so
 * those go through a boolean intersection with a large rectangle instead.
 */

/** The half-plane `{ p : dot(p - origin, normal) >= 0 }`. */
export interface HalfPlane {
  origin: Vec2;
  normal: Vec2;
}

export const halfPlane = (origin: Vec2, normal: Vec2): HalfPlane => ({
  origin,
  normal: V.normalize(normal),
});

/**
 * The half-plane that keeps everything on the inward side of a polygon edge
 * pushed inward by `inset`. `edgeNormal` must point into the interior.
 */
export function insetEdgeHalfPlane(edgeA: Vec2, edgeNormal: Vec2, inset: number): HalfPlane {
  const n = V.normalize(edgeNormal);
  return { origin: V.addScaled(edgeA, n, inset), normal: n };
}

function sutherlandHodgman(poly: Polygon, hp: HalfPlane): Polygon {
  const out: Polygon = [];
  const n = poly.length;
  const side = (p: Vec2) => V.dot(V.sub(p, hp.origin), hp.normal);
  for (let i = 0; i < n; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % n]!;
    const dc = side(cur);
    const dn = side(nxt);
    if (dc >= 0) out.push(cur);
    if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) {
      const t = dc / (dc - dn);
      out.push(V.lerp(cur, nxt, t));
    }
  }
  return out;
}

/** A rectangle covering the half-plane over the extent of `reference`, with margin. */
function halfPlaneRect(hp: HalfPlane, reference: Polygon): Polygon {
  const bb = bbox(reference);
  const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y) + 10;
  const n = hp.normal;
  const t = V.perp(n);
  const o = hp.origin;
  return [
    V.addScaled(V.addScaled(o, t, -diag), n, 0),
    V.addScaled(V.addScaled(o, t, diag), n, 0),
    V.addScaled(V.addScaled(o, t, diag), n, diag * 2),
    V.addScaled(V.addScaled(o, t, -diag), n, diag * 2),
  ];
}

/**
 * Clip `poly` to a half-plane. Returns zero or more simple components — a
 * concave polygon can genuinely be cut into several pieces.
 */
export function clipHalfPlane(poly: Polygon, hp: HalfPlane): Polygon[] {
  if (poly.length < 3) return [];

  // Trivial accept / reject before doing any work.
  let allIn = true;
  let allOut = true;
  for (const p of poly) {
    const d = V.dot(V.sub(p, hp.origin), hp.normal);
    if (d < -1e-9) allIn = false;
    if (d > 1e-9) allOut = false;
  }
  if (allIn) return [poly];
  if (allOut) return [];

  if (isConvex(poly)) {
    const clipped = sutherlandHodgman(poly, hp);
    const c = cleanPolygon(clipped);
    return c ? [c] : [];
  }
  return intersectPoly([poly], [halfPlaneRect(hp, poly)]);
}

/** Clip against several half-planes in sequence. */
export function clipHalfPlanes(polys: Polygon[], planes: HalfPlane[]): Polygon[] {
  let cur = polys;
  for (const hp of planes) {
    if (cur.length === 0) return [];
    const next: Polygon[] = [];
    for (const p of cur) next.push(...clipHalfPlane(p, hp));
    cur = next;
  }
  return cur;
}

/**
 * Split `poly` by the infinite line through `origin` with direction `dir`.
 * Returns `[left, right]` relative to `dir` — `left` is the side the left-hand
 * perpendicular points to.
 */
export function splitPolygonByLine(
  poly: Polygon,
  origin: Vec2,
  dir: Vec2,
): [Polygon[], Polygon[]] {
  const n = V.perp(V.normalize(dir));
  const left = clipHalfPlane(poly, { origin, normal: n });
  const right = clipHalfPlane(poly, { origin, normal: V.neg(n) });
  return [left, right];
}

/**
 * Cut a strip of depth `depth` measured inward from an edge, plus the remainder.
 * `edgeNormal` points into the polygon. This is the primitive the ring/core
 * split in `city/Lots.ts` is built from.
 */
export function sliceStrip(
  poly: Polygon,
  edgeA: Vec2,
  edgeNormal: Vec2,
  depth: number,
): { strip: Polygon[]; rest: Polygon[] } {
  const n = V.normalize(edgeNormal);
  const cutOrigin = V.addScaled(edgeA, n, depth);
  return {
    strip: clipHalfPlane(poly, { origin: cutOrigin, normal: V.neg(n) }),
    rest: clipHalfPlane(poly, { origin: cutOrigin, normal: n }),
  };
}

/** Sanity helper: total area is preserved by a split, within `eps`. */
export function splitPreservesArea(
  original: Polygon,
  left: Polygon[],
  right: Polygon[],
  eps = 1e-4,
): boolean {
  const a = area(original);
  const b = left.reduce((s, p) => s + area(p), 0) + right.reduce((s, p) => s + area(p), 0);
  return Math.abs(a - b) <= eps * Math.max(1, a);
}

/** Merge a set of polygons that should be contiguous back into as few rings as possible. */
export const mergeAdjacent = (polys: Polygon[]): Polygon[] => unionPoly(polys);
