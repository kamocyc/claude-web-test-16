import type { Polygon, Vec2 } from '../core/types.js';
import * as V from './vec2.js';

/** Ring access with wraparound. `poly[i+1]` off the end is the classic bug here. */
export function at(poly: Polygon, i: number): Vec2 {
  const n = poly.length;
  return poly[((i % n) + n) % n]!;
}

/** Positive for counter-clockwise rings. */
export function signedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const area = (poly: Polygon): number => Math.abs(signedArea(poly));
export const isCCW = (poly: Polygon): boolean => signedArea(poly) > 0;

export function ensureCCW(poly: Polygon): Polygon {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function perimeter(poly: Polygon): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) s += V.dist(poly[i]!, poly[(i + 1) % n]!);
  return s;
}

export function centroid(poly: Polygon): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-12) {
    // Degenerate ring: fall back to the vertex average so callers still get a point.
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p.x;
      sy += p.y;
    }
    const n = Math.max(1, poly.length);
    return { x: sx / n, y: sy / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export interface Bbox {
  min: Vec2;
  max: Vec2;
}

export function bbox(poly: Polygon): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

export const bboxOfMany = (polys: Polygon[]): Bbox => bbox(polys.flat());

/** Even-odd ray cast. Points exactly on the boundary are not guaranteed either way. */
export function contains(poly: Polygon, p: Vec2): boolean {
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

/** Signed distance from `p` to the ring boundary, positive inside. */
export function signedDistance(poly: Polygon, p: Vec2): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = V.distToSegment(p, poly[i]!, poly[(i + 1) % n]!);
    if (d < best) best = d;
  }
  return contains(poly, p) ? best : -best;
}

export function isConvex(poly: Polygon): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const c = poly[(i + 2) % n]!;
    const z = V.cross(V.sub(b, a), V.sub(c, b));
    if (Math.abs(z) < 1e-10) continue;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** True when no two non-adjacent edges cross. O(n^2) — n is small here. */
export function isSimple(poly: Polygon): boolean {
  const n = poly.length;
  if (n < 3) return false;
  // A spike first: a vertex where the ring turns through exactly 180° and goes
  // back the way it came. The boundary touches itself there, so the ring is not
  // simple — but the two segments involved are *adjacent*, which the crossing
  // test below skips, and they are collinear, which it would not report anyway.
  //
  // These are not hypothetical. A flag lot unioned with a pole whose tip lands
  // on the frontage line comes back as a body with a zero-width whisker of
  // exactly the pole's width, and `intersectPoly` fills such a ring by its own
  // rule rather than by the one the eye uses — two of them were reported as
  // lots overlapping by 13 m² when neither had any land in common.
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n]!;
    const cur = poly[i]!;
    const next = poly[(i + 1) % n]!;
    const a = V.normalize(V.sub(cur, prev));
    const b = V.normalize(V.sub(next, cur));
    if (V.dot(a, b) < -0.999999) return false;
  }
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]!;
    const a2 = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = poly[j]!;
      const b2 = poly[(j + 1) % n]!;
      if (V.segmentIntersection(a1, a2, b1, b2, -1e-9)) return false;
    }
  }
  return true;
}

export interface Edge {
  a: Vec2;
  b: Vec2;
  /** Index of `a` in the ring. */
  i: number;
  dir: Vec2;
  len: number;
  /** Inward normal (points into the polygon interior for a CCW ring). */
  normal: Vec2;
}

export function edges(poly: Polygon): Edge[] {
  const out: Edge[] = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const d = V.sub(b, a);
    const l = V.len(d);
    if (l < 1e-9) continue;
    const dir = { x: d.x / l, y: d.y / l };
    out.push({ a, b, i, dir, len: l, normal: V.perp(dir) });
  }
  return out;
}

export function edgeAt(poly: Polygon, i: number): Edge {
  const a = at(poly, i);
  const b = at(poly, i + 1);
  const d = V.sub(b, a);
  const l = Math.max(1e-9, V.len(d));
  const dir = { x: d.x / l, y: d.y / l };
  return { a, b, i, dir, len: l, normal: V.perp(dir) };
}

export function longestEdge(poly: Polygon): Edge {
  const es = edges(poly);
  let best = es[0]!;
  for (const e of es) if (e.len > best.len) best = e;
  return best;
}

export const translate = (poly: Polygon, d: Vec2): Polygon => poly.map((p) => V.add(p, d));

export function rotateAbout(poly: Polygon, origin: Vec2, radians: number): Polygon {
  return poly.map((p) => V.add(origin, V.rotate(V.sub(p, origin), radians)));
}

export function scaleAbout(poly: Polygon, origin: Vec2, s: number | Vec2): Polygon {
  const sx = typeof s === 'number' ? s : s.x;
  const sy = typeof s === 'number' ? s : s.y;
  return poly.map((p) => ({ x: origin.x + (p.x - origin.x) * sx, y: origin.y + (p.y - origin.y) * sy }));
}

/** Reflect across the line through `origin` with direction `axis`. Reverses winding. */
export function mirrorAbout(poly: Polygon, origin: Vec2, axis: Vec2): Polygon {
  const a = V.normalize(axis);
  const reflected = poly.map((p) => {
    const d = V.sub(p, origin);
    const along = V.dot(d, a);
    const perpComp = V.sub(d, V.scale(a, along));
    return V.add(origin, V.sub(V.scale(a, along), perpComp));
  });
  return ensureCCW(reflected);
}

/** Axis-aligned rectangle as a CCW ring. */
export function rectPolygon(cx: number, cy: number, w: number, h: number): Polygon {
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ];
}

/** Regular n-gon, CCW. Used as the round join in the boolean offsetter. */
export function circlePolygon(c: Vec2, r: number, segments = 12): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

/**
 * The largest circle centred inside the polygon that fits — approximated by
 * grid sampling plus local refinement. Used to reject unbuildable slivers.
 */
export function maxInscribedCircle(poly: Polygon, precision = 0.25): { center: Vec2; radius: number } {
  const bb = bbox(poly);
  const w = bb.max.x - bb.min.x;
  const h = bb.max.y - bb.min.y;
  if (w <= 0 || h <= 0) return { center: centroid(poly), radius: 0 };

  let best = { center: centroid(poly), radius: -Infinity };
  const step0 = Math.max(precision, Math.min(w, h) / 16);
  for (let y = bb.min.y; y <= bb.max.y; y += step0) {
    for (let x = bb.min.x; x <= bb.max.x; x += step0) {
      const p = { x, y };
      const d = signedDistance(poly, p);
      if (d > best.radius) best = { center: p, radius: d };
    }
  }
  // Local hill climb to sharpen the estimate.
  let step = step0;
  while (step > precision) {
    step *= 0.5;
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dx, dy] of [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
        [step, step],
        [-step, -step],
        [step, -step],
        [-step, step],
      ] as const) {
        const p = { x: best.center.x + dx, y: best.center.y + dy };
        const d = signedDistance(poly, p);
        if (d > best.radius) {
          best = { center: p, radius: d };
          improved = true;
        }
      }
    }
  }
  return { center: best.center, radius: Math.max(0, best.radius) };
}

/** Andrew's monotone chain. */
export function convexHull(points: Vec2[]): Polygon {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const half = (src: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of src) {
      while (out.length >= 2 && V.cross(V.sub(out[out.length - 1]!, out[out.length - 2]!), V.sub(p, out[out.length - 1]!)) <= 0) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.slice().reverse())];
}

/** Uniformly resample a closed ring at approximately `spacing` intervals. */
export function resample(poly: Polygon, spacing: number): Polygon {
  const out: Polygon = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const l = V.dist(a, b);
    const steps = Math.max(1, Math.round(l / spacing));
    for (let s = 0; s < steps; s++) out.push(V.lerp(a, b, s / steps));
  }
  return out;
}

/** Sample points on the ring boundary at roughly `spacing`; keeps every vertex. */
export function samplePoints(poly: Polygon, spacing: number): Vec2[] {
  return resample(poly, spacing);
}

/**
 * Trim a segment to the part of it that lies inside the polygon, returning the
 * longest contiguous run, or null when none of it is inside.
 *
 * Roads registered from a construction line have to be clipped to the block they
 * belong to. Skipping this is what let generated lanes run out across the
 * neighbouring blocks.
 */
export function clipSegmentToPolygon(
  poly: Polygon,
  a: Vec2,
  b: Vec2,
): [Vec2, Vec2] | null {
  let best: [Vec2, Vec2] | null = null;
  let bestLen = 0;
  for (const run of clipSegmentToPolygonAll(poly, a, b)) {
    const l = V.dist(run[0], run[1]);
    if (!best || l > bestLen) {
      best = run;
      bestLen = l;
    }
  }
  return best;
}

/**
 * Every run of a–b that lies inside `poly`, in order along the segment.
 *
 * A concave polygon — an L-shaped district, a block with a notch — can contain
 * two or more disjoint stretches of the same line. `clipSegmentToPolygon`
 * returns only the longest, which silently drops half a street; callers laying
 * out a grid want all of them.
 */
export function clipSegmentToPolygonAll(poly: Polygon, a: Vec2, b: Vec2): [Vec2, Vec2][] {
  const d = V.sub(b, a);
  const total = V.len(d);
  if (total < 1e-6) return [];

  // Every crossing parameter along the segment, plus the two endpoints.
  const ts: number[] = [0, 1];
  for (let i = 0, n = poly.length; i < n; i++) {
    const x = V.segmentIntersection(a, b, poly[i]!, poly[(i + 1) % n]!, 1e-9);
    if (x) ts.push(x.ta);
  }
  ts.sort((p, q) => p - q);

  const runs: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i]!;
    const t1 = ts[i + 1]!;
    if (t1 - t0 < 1e-6) continue;
    if ((t1 - t0) * total < 1e-3) continue;
    if (!contains(poly, V.addScaled(a, d, (t0 + t1) / 2))) continue;
    runs.push([V.addScaled(a, d, t0), V.addScaled(a, d, t1)]);
  }
  return runs;
}
