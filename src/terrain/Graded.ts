import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import type { City } from '../city/City.js';

/**
 * The ground after the earthworks.
 *
 * The natural heightfield is what the land *was*; this is what it is once the
 * town has been cut into it. The two differ in one direction that matters
 * enormously: a road in cut sits below the hillside beside it, and a lot
 * levelled into a slope has half its area below the ground it occupies. Draw the
 * natural surface and the asphalt, the garden and the lower storey of every
 * house on a slope are simply buried in it — the spoil is still sitting there.
 *
 * So this lowers the mesh wherever the town dug. It never *raises* it: fill is
 * already drawn, by the platform cap and the road embankment, and raising the
 * ground to meet them would bury the 擁壁 that is supposed to be holding them
 * up. Clamping downward only is what makes this safe to apply everywhere —
 * whatever it gets wrong, it cannot hide anything.
 *
 * Deliberately *not* fed back into `Terrain`. Everything upstream — where a road
 * may go, how a lot is levelled, what a wall has to retain — reasons about the
 * land as it was found, and would be circular if it read the result of its own
 * decisions.
 */

export interface GradedGround {
  at(ix: number, iy: number): number;
}

/** How far beyond the kerb the cut reaches, metres. */
const ROAD_MARGIN = 2.0;
/**
 * How far inside a lot boundary the excavation is applied.
 *
 * Not to the boundary itself. The grid is 4 m and a lot is a dozen across, so
 * stamping right up to the edge makes a blocky pit whose corners stick out past
 * the parcel; eroding by a metre and a half keeps the cut under the pad, where
 * the boundary walls cover the step.
 */
const LOT_EROSION = 1.5;

export function gradeGround(city: City): GradedGround | null {
  const field = city.terrain.field;
  if (!field) return null;

  const data = new Float32Array(field.data);
  const { nx, ny, cell, x0, y0 } = field;

  const lower = (x: number, y: number, to: number): void => {
    const ix = Math.round((x - x0) / cell);
    const iy = Math.round((y - y0) / cell);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return;
    const i = iy * nx + ix;
    if (to < data[i]!) data[i] = to;
  };

  // --- Roads ---------------------------------------------------------------
  // Sampled along and across rather than rasterised from a polygon: a
  // carriageway is a few grid cells wide, so a handful of probes covers it, and
  // the design height varies along the edge.
  for (const e of city.roads.edges) {
    const a = city.roads.graph.node(e.a).p;
    const b = city.roads.graph.node(e.b).p;
    const len = V.dist(a, b);
    if (len < 0.5) continue;
    const dir = V.scale(V.sub(b, a), 1 / len);
    const nrm = V.perp(dir);
    const half = e.width / 2 + ROAD_MARGIN;
    const along = Math.max(1, Math.ceil(len / (cell * 0.5)));
    const across = Math.max(1, Math.ceil((half * 2) / (cell * 0.5)));

    for (let i = 0; i <= along; i++) {
      const t = i / along;
      const centre = V.lerp(a, b, t);
      const y = city.roadHeights.alongEdge(e, t);
      for (let j = 0; j <= across; j++) {
        const off = -half + (j / across) * half * 2;
        const q = V.addScaled(centre, nrm, off);
        lower(q.x, q.y, y - 0.05);
      }
    }
  }

  // --- Lots ----------------------------------------------------------------
  for (const lot of city.lots) {
    const pad = lot.platform.padY;
    const eroded = shrink(lot.polygon, LOT_EROSION);
    if (!eroded) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of eroded) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    for (let y = Math.floor(minY / cell) * cell; y <= maxY + cell; y += cell) {
      for (let x = Math.floor(minX / cell) * cell; x <= maxX + cell; x += cell) {
        if (!contains(eroded, x, y)) continue;
        lower(x, y, pad - 0.05);
      }
    }
  }

  return {
    at(ix, iy) {
      const cx = ix < 0 ? 0 : ix >= nx ? nx - 1 : ix;
      const cy = iy < 0 ? 0 : iy >= ny ? ny - 1 : iy;
      return data[cy * nx + cx]!;
    },
  };
}

/** Pull a ring toward its centroid by `d`. Crude, and adequate for a stamp. */
function shrink(poly: Polygon, d: number): Polygon | null {
  if (poly.length < 3) return null;
  let cx = 0;
  let cy = 0;
  for (const q of poly) {
    cx += q.x;
    cy += q.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  const out: Vec2[] = [];
  for (const q of poly) {
    const dx = cx - q.x;
    const dy = cy - q.y;
    const l = Math.hypot(dx, dy);
    // A parcel smaller than the erosion collapses; leave it to the natural mesh.
    if (l <= d * 1.2) return null;
    out.push({ x: q.x + (dx / l) * d, y: q.y + (dy / l) * d });
  }
  return out;
}

function contains(poly: Polygon, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
