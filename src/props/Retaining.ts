import type { Polygon, Vec2 } from '../core/types.js';
import type { PlatformParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { ChunkedMeshBuilder } from '../build/MeshMerger.js';
import type { City } from '../city/City.js';
import type { Lot } from '../city/Lots.js';

/**
 * 擁壁 — the walls that hold a levelled lot up, and the steps up to it.
 *
 * This is what makes a house on a slope look like a house on a slope rather
 * than a house hovering over one. A Japanese hill suburb is *made* of these:
 * every parcel is a level platform, every platform is retained by a concrete
 * block wall on its low side and cut into the bank on its high side, and the
 * aluminium fence stands on top of the wall rather than on the ground. Leave
 * them out and the whole hillside reads as a model with the buildings pressed
 * into clay.
 *
 * Drawn for every lot, built or not. An empty parcel was still cut and filled
 * when the estate was laid out, and skipping it leaves a notch in the terrace
 * with its neighbours' walls hanging in the air on either side.
 */

const CONCRETE_BLOCK = { r: 0.7, g: 0.69, b: 0.66 };
const CONCRETE_CAST = { r: 0.63, g: 0.63, b: 0.61 };
const EARTH = { r: 0.44, g: 0.42, b: 0.35 };

export function buildRetaining(chunks: ChunkedMeshBuilder, city: City, p: PlatformParams): void {
  if (!p.enabled || !city.terrain.field) return;

  for (const lot of city.lots) {
    const platform = lot.platform;
    if (platform.edges.length === 0) continue;

    const concrete = new GeometryBuffer();
    const ground = new GeometryBuffer();

    // The pad itself: a level cap over the parcel. Without it the levelled
    // ground is only implied by the walls around it, and the terrain mesh shows
    // through in the middle of every garden.
    ground.setColor(EARTH);
    ground.pushCap(inset(lot.polygon, 0.02), platform.padY - 0.02, true);

    const n = lot.polygon.length;
    for (const edge of platform.edges) {
      if (edge.kind === 'flush') continue;
      const a = lot.polygon[edge.i]!;
      const b = lot.polygon[(edge.i + 1) % n]!;
      const len = V.dist(a, b);
      if (len < 0.4) continue;

      // Inward normal: the polygon is CCW, so the left of a→b is the interior.
      const dir = V.normalize(V.sub(b, a));
      const inward = V.perp(dir);

      if (edge.kind === 'wall') {
        addWall(concrete, city, a, b, inward, platform.padY, p);
      } else {
        addBatter(ground, city, a, b, inward, platform.padY, p);
      }
    }

    if (platform.steps > 0) addSteps(concrete, lot, platform.padY, platform.streetY, p);

    chunks.add(lot.centroid, { concrete, ground });
  }
}

/**
 * A concrete face along one boundary, from below the ground up to the pad.
 *
 * The base runs 0.4 m *below* the terrain rather than to it. The ground mesh is
 * sampled at 4 m and the wall at every metre, so the two disagree by a few
 * centimetres wherever the land is curved — and a wall that stops exactly at the
 * sampled ground shows a thread of daylight under it on about a third of its
 * length. Burying the toe is also what real ones do.
 */
function addWall(
  buf: GeometryBuffer,
  city: City,
  a: Vec2,
  b: Vec2,
  inward: Vec2,
  padY: number,
  p: PlatformParams,
): void {
  const terrain = city.terrain;
  const len = V.dist(a, b);
  const steps = Math.max(1, Math.round(len));
  const face = p.wallInset;
  const back = p.wallInset + p.wallThickness;

  // A wall retaining fill is a block wall seen from outside; one cut into the
  // bank is a cast face seen from inside. They read differently and it is worth
  // the two colours.
  const fill = padY > terrain.heightAt(V.lerp(a, b, 0.5));
  buf.setColor(fill ? CONCRETE_BLOCK : CONCRETE_CAST);

  for (let i = 0; i < steps; i++) {
    const q0 = V.lerp(a, b, i / steps);
    const q1 = V.lerp(a, b, (i + 1) / steps);
    const g0 = terrain.heightAt(q0);
    const g1 = terrain.heightAt(q1);
    const base = Math.min(g0, g1) - 0.4;
    const top = padY + 0.05;
    if (top <= base) continue;

    const o0 = V.addScaled(q0, inward, face);
    const o1 = V.addScaled(q1, inward, face);
    const i0 = V.addScaled(q0, inward, back);
    const i1 = V.addScaled(q1, inward, back);
    buf.pushPrism([o0, o1, i1, i0], base, top, true, false);
  }
}

/**
 * An earth batter: the low-cost version, for a step too small to be worth
 * concrete. Runs out at `batterSlope`:1 to meet the ground.
 */
function addBatter(
  buf: GeometryBuffer,
  city: City,
  a: Vec2,
  b: Vec2,
  inward: Vec2,
  padY: number,
  p: PlatformParams,
): void {
  const terrain = city.terrain;
  const steps = Math.max(1, Math.round(V.dist(a, b) / 2));
  buf.setColor(EARTH);
  for (let i = 0; i < steps; i++) {
    const q0 = V.lerp(a, b, i / steps);
    const q1 = V.lerp(a, b, (i + 1) / steps);
    const g0 = terrain.heightAt(q0);
    const g1 = terrain.heightAt(q1);
    const d = padY - (g0 + g1) / 2;
    if (Math.abs(d) < 0.1) continue;
    // Fill slopes away from the pad, cut slopes into it.
    const run = Math.abs(d) * p.batterSlope * (d > 0 ? -1 : 1);
    const r0 = V.addScaled(q0, inward, run);
    const r1 = V.addScaled(q1, inward, run);
    buf.pushWorldTriangle(
      { x: q0.x, y: padY, z: q0.y },
      { x: q1.x, y: padY, z: q1.y },
      { x: r1.x, y: g1, z: r1.y },
    );
    buf.pushWorldTriangle(
      { x: q0.x, y: padY, z: q0.y },
      { x: r1.x, y: g1, z: r1.y },
      { x: r0.x, y: g0, z: r0.y },
    );
  }
}

/**
 * The flight up from the street to the pad, at the gate.
 *
 * Placed on the primary frontage at the same fraction along it that
 * `SiteProps.buildGate` uses, so the steps and the gate posts agree instead of
 * standing a metre apart looking foolish.
 */
function addSteps(
  buf: GeometryBuffer,
  lot: Lot,
  padY: number,
  streetY: number,
  p: PlatformParams,
): void {
  const f = lot.frontages[0];
  if (!f) return;
  const rise = padY - streetY;
  const n = Math.max(1, Math.round(Math.abs(rise) / p.stepRiser));
  if (n > 40) return; // Something has gone wrong upstream; do not draw a ladder.

  const width = Math.min(1.4, f.len * 0.4);
  const inward = V.neg(f.outward);
  const centre = V.addScaled(f.a, f.dir, f.len * 0.5);
  const tread = 0.29;

  buf.setColor(CONCRETE_CAST);
  for (let i = 0; i < n; i++) {
    // Each tread is a slab from the street edge inward, stacked so the flight
    // climbs into the lot rather than out over the pavement.
    const from = V.addScaled(centre, inward, i * tread);
    const to = V.addScaled(centre, inward, (i + 1) * tread + 0.1);
    const side = V.scale(f.dir, width / 2);
    const poly: Polygon = [
      { x: from.x - side.x, y: from.y - side.y },
      { x: to.x - side.x, y: to.y - side.y },
      { x: to.x + side.x, y: to.y + side.y },
      { x: from.x + side.x, y: from.y + side.y },
    ];
    const top = streetY + (rise * (i + 1)) / n;
    buf.pushPrism(poly, streetY - 0.5, top, true, false);
  }
}

/** Shrink a ring toward its centroid by a small amount. Good enough for a cap. */
function inset(poly: Polygon, d: number): Polygon {
  let cx = 0;
  let cy = 0;
  for (const q of poly) {
    cx += q.x;
    cy += q.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map((q) => {
    const dx = cx - q.x;
    const dy = cy - q.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: q.x + (dx / l) * d, y: q.y + (dy / l) * d };
  });
}
