import type { Vec2 } from '../core/types.js';

export const v2 = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });

/** `a + b * s` — the fused form, since it shows up constantly. */
export const addScaled = (a: Vec2, b: Vec2, s: number): Vec2 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
});

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D cross product (z component of the 3D cross). Positive when b is left of a. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const lenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

/** Left-hand perpendicular. For a CCW ring's edge direction, this points inward. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export function rotate(a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (radians: number, r = 1): Vec2 => ({
  x: Math.cos(radians) * r,
  y: Math.sin(radians) * r,
});

export const equals = (a: Vec2, b: Vec2, eps = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/** Closest point to `p` on segment `a`–`b`, and the parameter t in [0, 1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub(b, a);
  const l2 = lenSq(ab);
  if (l2 < 1e-18) return { point: a, t: 0 };
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  return { point: addScaled(a, ab, t), t };
}

export const distToSegment = (p: Vec2, a: Vec2, b: Vec2): number =>
  dist(p, closestOnSegment(p, a, b).point);

/**
 * Intersection of segments a1–a2 and b1–b2, or null when they are parallel or
 * do not overlap. `eps` lets callers decide whether shared endpoints count.
 */
export function segmentIntersection(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2,
  eps = 1e-9,
): { point: Vec2; ta: number; tb: number } | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-14) return null;
  const qp = sub(b1, a1);
  const ta = cross(qp, s) / denom;
  const tb = cross(qp, r) / denom;
  if (ta < -eps || ta > 1 + eps || tb < -eps || tb > 1 + eps) return null;
  return { point: addScaled(a1, r, ta), ta, tb };
}

/** Intersection of two infinite lines given as point + direction. */
export function lineIntersection(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const denom = cross(d1, d2);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(p2, p1), d2) / denom;
  return addScaled(p1, d1, t);
}

/** Smallest absolute angle between two directions, in radians, in [0, PI]. */
export function angleBetween(a: Vec2, b: Vec2): number {
  const na = normalize(a);
  const nb = normalize(b);
  return Math.acos(Math.min(1, Math.max(-1, dot(na, nb))));
}
