import type { Polygon, Vec2 } from '../core/types.js';
import * as V from './vec2.js';
import { convexHull, edges } from './polygon.js';

/** A local frame: `world = origin + xAxis * u + perp(xAxis) * v`. */
export interface Frame {
  origin: Vec2;
  xAxis: Vec2;
}

export const makeFrame = (origin: Vec2, angle: number): Frame => ({
  origin,
  xAxis: V.fromAngle(angle),
});

export const frameAngle = (f: Frame): number => V.angleOf(f.xAxis);

export function toLocal(p: Vec2, f: Frame): Vec2 {
  const d = V.sub(p, f.origin);
  const y = V.perp(f.xAxis);
  return { x: V.dot(d, f.xAxis), y: V.dot(d, y) };
}

export function toWorld(p: Vec2, f: Frame): Vec2 {
  const y = V.perp(f.xAxis);
  return {
    x: f.origin.x + f.xAxis.x * p.x + y.x * p.y,
    y: f.origin.y + f.xAxis.y * p.x + y.y * p.y,
  };
}

export const polyToLocal = (poly: Polygon, f: Frame): Polygon => poly.map((p) => toLocal(p, f));
export const polyToWorld = (poly: Polygon, f: Frame): Polygon => poly.map((p) => toWorld(p, f));

/** An axis-aligned rectangle in some local frame. */
export interface LocalRect {
  cx: number;
  cy: number;
  w: number;
  d: number;
}

export function localRectPolygon(r: LocalRect): Polygon {
  const hw = r.w / 2;
  const hd = r.d / 2;
  return [
    { x: r.cx - hw, y: r.cy - hd },
    { x: r.cx + hw, y: r.cy - hd },
    { x: r.cx + hw, y: r.cy + hd },
    { x: r.cx - hw, y: r.cy + hd },
  ];
}

export const localRectArea = (r: LocalRect): number => r.w * r.d;

export function expandRect(r: LocalRect, by: number): LocalRect {
  return { cx: r.cx, cy: r.cy, w: r.w + by * 2, d: r.d + by * 2 };
}

export interface Obb {
  frame: Frame;
  rect: LocalRect;
  angle: number;
  area: number;
}

/**
 * Minimum-area oriented bounding box by rotating calipers over the convex hull.
 * The minimum-area box always has a side flush with a hull edge.
 */
export function minAreaObb(poly: Polygon): Obb {
  const hull = convexHull(poly);
  if (hull.length < 3) {
    return {
      frame: { origin: poly[0] ?? { x: 0, y: 0 }, xAxis: { x: 1, y: 0 } },
      rect: { cx: 0, cy: 0, w: 0, d: 0 },
      angle: 0,
      area: 0,
    };
  }

  let best: Obb | null = null;
  for (const e of edges(hull)) {
    const f: Frame = { origin: e.a, xAxis: e.dir };
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const l = toLocal(p, f);
      if (l.x < minU) minU = l.x;
      if (l.x > maxU) maxU = l.x;
      if (l.y < minV) minV = l.y;
      if (l.y > maxV) maxV = l.y;
    }
    const w = maxU - minU;
    const d = maxV - minV;
    const a = w * d;
    if (!best || a < best.area) {
      best = {
        frame: f,
        rect: { cx: (minU + maxU) / 2, cy: (minV + maxV) / 2, w, d },
        angle: V.angleOf(e.dir),
        area: a,
      };
    }
  }
  return best!;
}

/** Extent of a polygon in a given frame, as a local rect. */
export function extentsIn(poly: Polygon, f: Frame): LocalRect {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of poly) {
    const l = toLocal(p, f);
    if (l.x < minU) minU = l.x;
    if (l.x > maxU) maxU = l.x;
    if (l.y < minV) minV = l.y;
    if (l.y > maxV) maxV = l.y;
  }
  return { cx: (minU + maxU) / 2, cy: (minV + maxV) / 2, w: maxU - minU, d: maxV - minV };
}
