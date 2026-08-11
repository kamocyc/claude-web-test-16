/** Shared geometric value types. World units are metres; +X east, +Z south, +Y up. */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * A simple polygon ring, counter-clockwise, *open* (the closing vertex is not
 * repeated). Every polygon that leaves `geom/` is expected to satisfy this;
 * `cleanPolygon` in `geom/simplify.ts` is what enforces it.
 */
export type Polygon = Vec2[];

/** A set of disjoint simple polygons. Holes are not represented — see `geom/boolean.ts`. */
export type MultiPolygon = Polygon[];

/** Plan-view coordinates map to the XZ plane: `Vec2{x, y}` -> `Vector3(x, height, y)`. */
export const UP = { x: 0, y: 1, z: 0 } as const;

/** World compass directions in plan-view coordinates. */
export const NORTH: Vec2 = { x: 0, y: -1 };
export const SOUTH: Vec2 = { x: 0, y: 1 };
export const EAST: Vec2 = { x: 1, y: 0 };
export const WEST: Vec2 = { x: -1, y: 0 };
