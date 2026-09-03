import type { Polygon, Vec2 } from '../core/types.js';
import type { PlatformParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { ChunkedMeshBuilder } from '../build/MeshMerger.js';
import type { City } from '../city/City.js';
import type { Lot } from '../city/Lots.js';
import type { GradedGround } from '../terrain/Graded.js';

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
 *
 * **Everything here measures against the ground that is drawn, not the ground
 * that was found.** `terrain/Graded.ts` lowers the mesh wherever the town dug,
 * and it digs a good deal wider than a lot boundary: a parcel beside a street in
 * cut has the hillside taken out from under it for a couple of grid cells
 * inside its own edge. Building the wall against the natural heightfield left
 * two fifths of every wall in the town standing on nothing — up to six metres of
 * daylight under its toe — which is the one thing a retaining wall must never
 * look like.
 */

const CONCRETE_BLOCK = { r: 0.7, g: 0.69, b: 0.66 };
const CONCRETE_CAST = { r: 0.63, g: 0.63, b: 0.61 };
const EARTH = { r: 0.44, g: 0.42, b: 0.35 };

/** The drawn ground: the graded surface where there is one, the land otherwise. */
type GroundAt = (p: Vec2) => number;

export function buildRetaining(
  chunks: ChunkedMeshBuilder,
  city: City,
  p: PlatformParams,
  graded?: GradedGround | null,
): void {
  if (!p.enabled || !city.terrain.field) return;

  const groundAt: GroundAt = graded
    ? (q) => Math.min(graded.heightAt(q), city.terrain.heightAt(q))
    : (q) => city.terrain.heightAt(q);

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

    // The flight up from the street, and the gap it needs in the wall it comes
    // through. Planned before the walls are drawn, because a staircase behind an
    // unbroken 2 m 擁壁 is a staircase nobody can see or use.
    const flight = platform.steps > 0 ? planSteps(lot, platform.padY, platform.streetY, p) : null;

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
      const gap = flight && flight.edge === edge.i ? flight.gap : null;

      if (edge.kind === 'wall') {
        addWall(concrete, groundAt, a, b, inward, platform.padY, p, gap);
      } else {
        addBatter(ground, groundAt, a, b, inward, platform.padY, p);
      }
    }

    if (flight) addSteps(concrete, flight);

    chunks.add(lot.centroid, { concrete, ground });
  }
}

/**
 * A concrete face along one boundary, from below the ground up to the pad — or,
 * where the lot was cut into the hill, from the pad up to the bank it holds
 * back.
 *
 * Both directions, and that is the point. A wall used to be drawn from the
 * ground up to `padY` whichever way round the two were, so on a cut edge — the
 * high side of every hillside parcel, two fifths of the walls in the town — the
 * top came out *below* the base and the whole thing was skipped. The bank
 * behind those lots was retained by nothing at all.
 *
 * The base runs 0.4 m *below* whichever of the two is lower. The ground mesh is
 * sampled at 4 m and the wall at every metre, so the two disagree by a few
 * centimetres wherever the land is curved — and a wall that stops exactly at the
 * sampled ground shows a thread of daylight under it on about a third of its
 * length. Burying the toe is also what real ones do.
 */
function addWall(
  buf: GeometryBuffer,
  groundAt: GroundAt,
  a: Vec2,
  b: Vec2,
  inward: Vec2,
  padY: number,
  p: PlatformParams,
  gap: { from: number; to: number } | null,
): void {
  const len = V.dist(a, b);
  const steps = Math.max(1, Math.round(len));
  const face = p.wallInset;
  const back = p.wallInset + p.wallThickness;

  // A wall retaining fill is a block wall seen from outside; one cut into the
  // bank is a cast face seen from inside. They read differently and it is worth
  // the two colours.
  const fill = padY > groundAt(V.lerp(a, b, 0.5));
  buf.setColor(fill ? CONCRETE_BLOCK : CONCRETE_CAST);

  for (let i = 0; i < steps; i++) {
    // The station's span along the edge, in metres from `a` — what the step
    // opening is measured in.
    const u0 = (i / steps) * len;
    const u1 = ((i + 1) / steps) * len;
    if (gap && u1 > gap.from && u0 < gap.to) continue;

    const q0 = V.lerp(a, b, i / steps);
    const q1 = V.lerp(a, b, (i + 1) / steps);
    const g0 = groundAt(q0);
    const g1 = groundAt(q1);
    // Down past the lower of pad and ground, up past the higher of them: a fill
    // wall stands from the hillside up to the pad, a cut wall from the pad up to
    // the hillside, and the same two lines say both.
    const base = Math.min(padY, g0, g1) - 0.4;
    const top = Math.max(padY + 0.05, g0, g1);
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
  groundAt: GroundAt,
  a: Vec2,
  b: Vec2,
  inward: Vec2,
  padY: number,
  p: PlatformParams,
): void {
  const steps = Math.max(1, Math.round(V.dist(a, b) / 2));
  buf.setColor(EARTH);
  for (let i = 0; i < steps; i++) {
    const q0 = V.lerp(a, b, i / steps);
    const q1 = V.lerp(a, b, (i + 1) / steps);
    const g0 = groundAt(q0);
    const g1 = groundAt(q1);
    const d = padY - (g0 + g1) / 2;
    if (Math.abs(d) < 0.1) continue;
    // Fill slopes away from the pad, cut slopes into it — but never further than
    // a batter is allowed to be in the first place. The edge was classed as a
    // batter because the *land* was within `wallMin` of the pad; where the town
    // has since dug a street out from under it the drawn ground can be metres
    // lower, and 1.5:1 on metres of it walks the slope out into the road.
    const reach = Math.min(Math.abs(d), p.wallMin) * p.batterSlope;
    const run = reach * (d > 0 ? -1 : 1);
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

/** A planned flight of steps, and the hole it needs in the boundary wall. */
interface Flight {
  /** Index of the frontage edge in `lot.polygon`, so the wall can leave a gap. */
  edge: number;
  /** The middle of the bottom tread, on the boundary. */
  base: Vec2;
  /** Into the lot, perpendicular to the frontage. */
  inward: Vec2;
  /** Along the frontage. */
  along: Vec2;
  width: number;
  tread: number;
  risers: number;
  streetY: number;
  padY: number;
  /** The span along the frontage edge, in metres from its start, to leave open. */
  gap: { from: number; to: number };
}

/**
 * Where the flight up from the street goes, and how big it can be.
 *
 * Three things used to be wrong with it, and all three are visible from the
 * pavement:
 *
 * - **It ran down through the floor.** The slabs were stacked from a fixed
 *   `streetY − 0.5` up to each tread, which for a lot cut *below* its street —
 *   near a third of them, and nine in ten of those by more than half a metre —
 *   is a prism whose top is under its bottom. `pushPrism` winds a box like that
 *   inside out, so the whole flight rendered back-to-front.
 * - **It walked out of the parcel.** The run is `1.8 ×` the rise, which at the
 *   2.5 m a pad may stand above its street is four and a half metres straight
 *   into the lot — off the far side of a shallow one, and off the side of any
 *   L-shaped one, because "inward" is perpendicular to one edge and a lot is not
 *   a rectangle. The tread is squeezed to whatever depth the parcel actually
 *   has, and below the width of a foot there are no steps at all.
 * - **It was behind the wall.** The 擁壁 runs the whole frontage, so the flight
 *   stood in the dark on the far side of it. It now comes through a gap.
 */
function planSteps(lot: Lot, padY: number, streetY: number, p: PlatformParams): Flight | null {
  const f = lot.frontages[0];
  if (!f) return null;
  const rise = padY - streetY;
  const risers = Math.max(1, Math.round(Math.abs(rise) / p.stepRiser));
  if (risers > 40) return null; // Something has gone wrong upstream; do not draw a ladder.

  const width = Math.min(1.4, f.len * 0.4);
  if (width < 0.6) return null;
  const inward = V.neg(f.outward);
  const along = f.dir;
  // The middle of the range `SiteProps.buildGate` draws the 門柱 from, so the
  // steps and the gate posts land within half a metre of each other instead of
  // at opposite ends of the frontage.
  const at = f.len * 0.485;
  const base = V.addScaled(f.a, along, at);

  const halfW = width / 2;
  // How deep the lot is in front of the gate. A flight cannot be longer than the
  // ground it is cut into — and it is measured at both flanks as well as at the
  // middle, because a flight is 1.4 m wide and a boundary is rarely square to it.
  const room =
    Math.min(
      depthInto(lot.polygon, base, inward),
      depthInto(lot.polygon, V.addScaled(base, along, -halfW), inward),
      depthInto(lot.polygon, V.addScaled(base, along, halfW), inward),
    ) - 0.3;
  if (room < 0.6) return null;
  const tread = Math.min(0.29, room / risers);
  if (tread < 0.12) return null;

  return {
    edge: f.i,
    base,
    inward,
    along,
    width,
    tread,
    risers,
    streetY,
    padY,
    // A hand's width either side, so the wall does not clip the flight's flanks.
    gap: { from: at - halfW - 0.1, to: at + halfW + 0.1 },
  };
}

/**
 * The flight itself: one slab per riser, each from the street edge inward.
 *
 * Stacked from below the lower of street and pad, so a flight that *descends*
 * into a lot cut below its road is still a solid box rather than an inverted
 * one.
 */
function addSteps(buf: GeometryBuffer, s: Flight): void {
  const bottom = Math.min(s.streetY, s.padY) - 0.5;
  const side = V.scale(s.along, s.width / 2);
  buf.setColor(CONCRETE_CAST);
  for (let i = 0; i < s.risers; i++) {
    // Each tread is a slab from the street edge inward, stacked so the flight
    // climbs into the lot rather than out over the pavement. Consecutive slabs
    // overlap by a nose so no thread of daylight opens between them.
    const from = V.addScaled(s.base, s.inward, i * s.tread);
    const to = V.addScaled(s.base, s.inward, (i + 1) * s.tread + Math.min(0.1, s.tread * 0.34));
    const poly: Polygon = [
      { x: from.x - side.x, y: from.y - side.y },
      { x: to.x - side.x, y: to.y - side.y },
      { x: to.x + side.x, y: to.y + side.y },
      { x: from.x + side.x, y: from.y + side.y },
    ];
    const top = s.streetY + ((s.padY - s.streetY) * (i + 1)) / s.risers;
    if (top <= bottom) continue;
    buf.pushPrism(poly, bottom, top, true, false);
  }
}

/**
 * How far a ray from `p` in direction `d` runs before it leaves the polygon.
 *
 * The frontage midpoint sits *on* the boundary, so the first crossing is the
 * far side — which is the number wanted. Zero when the ray leaves immediately,
 * which is what a reflex corner does.
 */
function depthInto(poly: Polygon, p: Vec2, d: Vec2): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const e = V.sub(b, a);
    const denom = V.cross(d, e);
    if (Math.abs(denom) < 1e-9) continue;
    const qp = V.sub(a, p);
    const t = V.cross(qp, e) / denom;
    const u = V.cross(qp, d) / denom;
    if (t > 0.05 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best === Infinity ? 0 : best;
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
