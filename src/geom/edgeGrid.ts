import type { Vec2 } from '../core/types.js';
import * as V from './vec2.js';

/**
 * A uniform-grid index over line segments.
 *
 * The third of its kind in this codebase — `Zoning.PointGrid` indexes points and
 * `Controls.ObstacleGrid` indexes polygons — and it exists for the same reason
 * they do: several stages need "what is near here?" in an inner loop, and a
 * linear scan over a few thousand segments inside a loop over a few thousand
 * queries is the difference between a generator that runs in a second and one
 * that runs in a minute.
 *
 * The ring search returns the *true* nearest, not an approximation: it keeps
 * expanding for one ring past the first hit, because a segment two cells away
 * diagonally can still be closer than one in the neighbouring cell.
 */
export class EdgeGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly a: Vec2[] = [];
  private readonly b: Vec2[] = [];
  private nx = 1;
  private ny = 1;

  constructor(private readonly cell: number) {}

  /** Index every span of a polyline. */
  addPolyline(pts: readonly Vec2[]): void {
    for (let i = 0; i + 1 < pts.length; i++) this.add(pts[i]!, pts[i + 1]!);
  }

  add(a: Vec2, b: Vec2): void {
    const id = this.a.length;
    this.a.push(a);
    this.b.push(b);

    // No origin is tracked: the key function tolerates negative indices and the
    // map is sparse, so the index never has to be rebuilt as it grows outward.
    // That matters for the growth loop, which adds roads to a live index.
    const ix0 = Math.floor(Math.min(a.x, b.x) / this.cell);
    const ix1 = Math.floor(Math.max(a.x, b.x) / this.cell);
    const iy0 = Math.floor(Math.min(a.y, b.y) / this.cell);
    const iy1 = Math.floor(Math.max(a.y, b.y) / this.cell);
    this.nx = Math.max(this.nx, ix1 - ix0 + 1);
    this.ny = Math.max(this.ny, iy1 - iy0 + 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const key = EdgeGrid.key(ix, iy);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(id);
      }
    }
  }

  private static key(ix: number, iy: number): number {
    // Interleave-free packing: 20 bits each, offset so negatives work.
    return ((ix + 524288) << 20) | (iy + 524288);
  }

  get size(): number {
    return this.a.length;
  }

  /**
   * The nearest segment to `p`, as its index, the closest point on it and the
   * distance. Returns null only when the index is empty.
   */
  nearest(p: Vec2, maxDistance = Infinity): { i: number; point: Vec2; distance: number } | null {
    if (this.a.length === 0) return null;

    let bestI = -1;
    let bestD = Infinity;
    let bestX = 0;
    let bestY = 0;
    const ix = Math.floor(p.x / this.cell);
    const iy = Math.floor(p.y / this.cell);
    const maxRing = Math.max(this.nx, this.ny) + Math.ceil(Math.min(maxDistance, 1e6) / this.cell) + 2;

    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only the shell of the ring; the interior was covered already.
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const list = this.cells.get(EdgeGrid.key(ix + dx, iy + dy));
          if (!list) continue;
          for (const i of list) {
            const c = V.closestOnSegment(p, this.a[i]!, this.b[i]!);
            const d = V.dist(p, c.point);
            if (d < bestD) {
              bestD = d;
              bestI = i;
              bestX = c.point.x;
              bestY = c.point.y;
            }
          }
        }
      }
      // Keep going for one ring past the first hit: a segment two cells away on
      // the diagonal can still be nearer than one in the cell next door, so
      // stopping at the first non-empty ring returns the wrong answer often
      // enough to see.
      if (bestI >= 0 && bestD + this.cell < ring * this.cell) break;
    }
    if (bestI < 0 || bestD > maxDistance) return null;
    return { i: bestI, point: { x: bestX, y: bestY }, distance: bestD };
  }

  /** Endpoints of an indexed segment. */
  segment(i: number): { a: Vec2; b: Vec2 } {
    return { a: this.a[i]!, b: this.b[i]! };
  }

  /** Every segment whose bounding cell is within `radius` of `p`. */
  near(p: Vec2, radius: number): number[] {
    const out = new Set<number>();
    const r = Math.ceil(radius / this.cell);
    const ix = Math.floor(p.x / this.cell);
    const iy = Math.floor(p.y / this.cell);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.cells.get(EdgeGrid.key(ix + dx, iy + dy));
        if (list) for (const i of list) out.add(i);
      }
    }
    return [...out];
  }
}
