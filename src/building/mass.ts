import type { Polygon, Vec2 } from '../core/types.js';
import type { BuildingParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { area, clipSegmentToPolygon, edges as polyEdges, isCCW } from '../geom/polygon.js';
import { clipHalfPlane, splitPolygonByLine, type HalfPlane } from '../geom/halfplane.js';
import { differencePoly, largest, multiArea } from '../geom/boolean.js';
import {
  extentsIn,
  localRectArea,
  localRectPolygon,
  minAreaObb,
  polyToWorld,
  type Frame,
  type LocalRect,
} from '../geom/obb.js';
import { intersectPoly, unionPoly } from '../geom/boolean.js';
import type {
  BuildEnvelope,
  BuildingMass,
  BuildingSpec,
  Floor,
  Footprint,
  SlantPlane,
  Stack,
  Wall,
} from './types.js';

/**
 * Massing: 斜線制限 expressed as *parts of the building having different floor
 * counts*, not as a chamfered floor plate.
 *
 * The old approach clipped every floor polygon by the slant planes. That
 * produced arbitrary upper-floor shapes, and — because the roof was built from
 * the base footprint — a roof several times larger than the top floor it sat on,
 * floating in the air. Real buildings answer a north-side height limit by
 * dropping a *storey* off the restricted part and making its top a roof terrace,
 * which is what this produces.
 *
 * The structural invariant that makes it safe: the tall region is found by
 * clipping, and every lower region by `differencePoly(before, after)`. So even
 * when `largest()` discards a disconnected piece of the tall region, that piece
 * lands in the low band instead of vanishing, and the stacks always partition
 * the footprint exactly.
 */

/** Below this removed fraction the plane does not bite enough to be worth a step. */
const MIN_STEP_FRACTION = 0.08;
/** A band shallower than this reads as an accident rather than a design. */
const MIN_BAND_MODULES = 2;
/** The tall stack must keep at least this much of the plan. */
const MIN_TALL_FRACTION = 0.45;
/** Never drop more than this many storeys in one step. */
const MAX_STEP_FLOORS = 2;
/** At most this many cuts, so at most three stacks. */
const MAX_CUTS = 2;
/** A second plane must bite this hard on its own to earn a cut. */
const SECOND_CUT_FRACTION = 0.15;
/**
 * How much more plan than the walls a pitched roof's rectangles may cover.
 * Past this the overhang is a cantilever rather than an eave, and the plan gets
 * a mono-pitch instead — which needs no rectangles and is exact on any polygon.
 */
const MAX_ROOF_COVER = 1.3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Snap a direction to the nearest building-frame axis.
 *
 * Cutting on the true slant direction would leave a step edge parallel to
 * nothing. Snapping it to the frame means the step runs parallel to a wall — the
 * difference between reading as a designed setback and reading as an artefact —
 * and it makes the intersection of an axis-aligned `LocalRect` with the cut
 * exactly another axis-aligned rect, which is what lets the roof refit below be
 * exact rather than approximate.
 */
function nearestFrameAxis(n: Vec2, frame: Frame): Vec2 {
  const ax = frame.xAxis;
  const ay = V.perp(ax);
  let best = ax;
  let bestDot = -Infinity;
  for (const c of [ax, V.neg(ax), ay, V.neg(ay)]) {
    const d = V.dot(c, n);
    if (d > bestDot) {
      bestDot = d;
      best = c;
    }
  }
  return best;
}

/**
 * How far a wall may project outward before crossing the lot boundary, sampled
 * along its length and taking the worst case. A small clearance is subtracted so
 * two neighbouring buildings' projections cannot touch.
 */
export function projectionRoom(a: Vec2, b: Vec2, outward: Vec2, lot: Polygon): number {
  const CLEARANCE = 0.15;
  const MAX = 3;
  let worst = MAX;
  for (let i = 0; i <= 4; i++) {
    const p = V.lerp(a, b, 0.1 + 0.2 * i);
    const hit = clipSegmentToPolygon(lot, p, V.addScaled(p, outward, MAX));
    // No inside run at all means the wall is already on (or past) the boundary.
    const d = hit ? V.dist(p, hit[1]) : 0;
    if (d < worst) worst = d;
  }
  return Math.max(0, worst - CLEARANCE);
}

/** The half-plane `dot(p, axis) >= c`, for a unit `axis`. */
const axisHalfPlane = (axis: Vec2, c: number): HalfPlane => ({
  origin: V.scale(axis, c),
  normal: axis,
});

interface CutCandidate {
  hp: HalfPlane;
  axis: Vec2;
  removedArea: number;
  /** Floor count for the stepped-down band. */
  lowFloors: number;
}

function candidateCut(
  base: Polygon,
  baseArea: number,
  frame: Frame,
  plane: SlantPlane,
  floorCount: number,
  floorHeight: number,
  module: number,
): CutCandidate | null {
  // Inward distance at which the envelope first admits the full height.
  const required = (floorCount * floorHeight - plane.baseHeight) / plane.slope;
  if (required <= 0) return null;

  const cutOrigin = V.addScaled(plane.origin, plane.inwardNormal, required);
  const removed = clipHalfPlane(base, {
    origin: cutOrigin,
    normal: V.neg(plane.inwardNormal),
  });
  if (removed.length === 0) return null;
  const removedArea = multiArea(removed);
  if (removedArea < baseArea * MIN_STEP_FRACTION) return null;

  const axis = nearestFrameAxis(plane.inwardNormal, frame);
  let lo = Infinity;
  for (const p of base) lo = Math.min(lo, V.dot(p, axis));
  let deepest = -Infinity;
  for (const ring of removed) for (const p of ring) deepest = Math.max(deepest, V.dot(p, axis));

  // Snap the band depth to whole modules, then pull it back a module at a time
  // until the tall part still keeps enough plan to be a building.
  let depth = Math.round((deepest - lo) / module) * module;
  let hp: HalfPlane | null = null;
  let tall: Polygon | null = null;
  while (depth >= MIN_BAND_MODULES * module) {
    const candidate = axisHalfPlane(axis, lo + depth);
    const kept = largest(clipHalfPlane(base, candidate));
    if (kept && area(kept) >= baseArea * MIN_TALL_FRACTION) {
      hp = candidate;
      tall = kept;
      break;
    }
    depth -= module;
  }
  if (!hp || !tall) return null;

  // How many floors the band can legally carry, taken at its worst point.
  const band = differencePoly([base], [tall]);
  if (band.length === 0) return null;
  let worst = Infinity;
  for (const ring of band) {
    for (const p of ring) worst = Math.min(worst, V.dot(V.sub(p, plane.origin), plane.inwardNormal));
  }
  let lowFloors = Math.floor((plane.baseHeight + Math.max(0, worst) * plane.slope) / floorHeight);
  lowFloors = clamp(lowFloors, 1, floorCount - 1);
  // A 5F block stepping straight down to 1F beside another 5F block reads as a
  // bug even where it is legal. This module is explicitly heuristic.
  lowFloors = Math.max(lowFloors, floorCount - MAX_STEP_FLOORS);

  return { hp, axis, removedArea, lowFloors };
}

function planCuts(
  base: Polygon,
  baseArea: number,
  frame: Frame,
  planes: SlantPlane[],
  floorCount: number,
  floorHeight: number,
  module: number,
): CutCandidate[] {
  const all = planes
    .map((p) => candidateCut(base, baseArea, frame, p, floorCount, floorHeight, module))
    .filter((c): c is CutCandidate => c !== null)
    .sort((a, b) => b.removedArea - a.removedArea);

  const chosen: CutCandidate[] = [];
  for (const c of all) {
    if (chosen.length >= MAX_CUTS) break;
    if (chosen.length === 0) {
      chosen.push(c);
      continue;
    }
    // Two cuts on the same axis and the same side: the deeper one already won.
    const sameSide = chosen.some((k) => V.dot(k.axis, c.axis) > 0.9);
    if (sameSide) continue;
    if (c.removedArea < baseArea * SECOND_CUT_FRACTION) continue;
    chosen.push(c);
  }
  return chosen;
}

export function buildMass(
  footprint: Footprint,
  envelope: BuildEnvelope,
  spec: BuildingSpec,
  lot: { polygon: Polygon; area: number },
  params: BuildingParams,
): BuildingMass {
  const lotArea = lot.area;
  const base = footprint.outline;
  const baseArea = footprint.area;
  const h = spec.floorHeight;

  const farFloors = Math.floor((envelope.maxFAR * lotArea) / Math.max(1, baseArea));
  const heightFloors = Math.floor(envelope.absoluteHeightLimit / h);
  const floorCount = Math.max(1, Math.min(spec.floors, farFloors, heightFloors));

  const cuts =
    floorCount < 2
      ? []
      : planCuts(base, baseArea, footprint.frame, envelope.slantPlanes, floorCount, h, params.module);
  cuts.sort((a, b) => a.lowFloors - b.lowFloors);

  const stacks: Stack[] = [];
  const floors: Floor[] = [];
  // Deliberately the same reference as `footprint.outline` while uncut: rebuilding
  // it through a boolean can rotate the vertex order, which shifts every wall
  // index and therefore moves every window on the building.
  let cur: Polygon = base;

  for (let f = 0; f < floorCount; f++) {
    const here = cuts.filter((c) => c.lowFloors === f);
    if (here.length > 0) {
      const before = cur;
      let next = cur;
      for (const c of here) next = largest(clipHalfPlane(next, c.hp)) ?? next;

      // Slivers are not worth a stack of their own, but they must not simply
      // vanish either: dropping them would take that plan area off the building
      // altogether. If the band cannot be represented, abandon the cut and
      // leave the storey full-size — the stacks then still partition the
      // footprint exactly, which everything downstream relies on.
      const minRing = Math.max(1.5, baseArea * 0.03);
      const rings = differencePoly([before], [next]).filter((r) => area(r) >= minRing);
      const bandArea = rings.reduce((t, r) => t + area(r), 0);
      const removed = area(before) - area(next);

      if (rings.length > 0 && bandArea >= removed * 0.9) {
        for (const ring of rings) stacks.push(makeStack(ring, f, true, footprint, spec, params));
        cur = next;
      }
    }
    floors.push({ polygon: cur, walls: [], y0: f * h, y1: (f + 1) * h, index: f });
  }

  stacks.unshift(makeStack(cur, floorCount, false, footprint, spec, params));
  stacks.forEach((s, i) => {
    s.index = i;
  });
  for (const fl of floors) fl.walls = wallsForPolygon(footprint, fl.polygon);

  return { floors, stacks, height: floorCount * h };
}

function makeStack(
  polygon: Polygon,
  floors: number,
  stepped: boolean,
  footprint: Footprint,
  spec: BuildingSpec,
  params: BuildingParams,
): Stack {
  const y1 = floors * spec.floorHeight;
  const walls = wallsForPolygon(footprint, polygon);
  if (stepped) {
    // A stepped-down part is a roof terrace: flat, with a guarding parapet.
    return {
      polygon,
      walls,
      floors,
      y0: 0,
      y1,
      roofType: 'flat',
      parts: [],
      frame: footprint.frame,
      cut: true,
      stepped: true,
      index: 0,
    };
  }
  const fit = refitParts(polygon, footprint, params.module);
  return {
    polygon,
    walls,
    floors,
    y0: 0,
    y1,
    roofType: spec.roofType,
    parts: fit.rects,
    frame: fit.frame,
    cut: fit.cut,
    stepped: false,
    index: 0,
  };
}

/**
 * Rebuild the roof rectangles from a stack's actual plan.
 *
 * The pitched-roof builder used to take `footprint.parts` — the *unclipped*
 * composed rectangles — so both the eave line and the ridge height came from the
 * base footprint no matter how much the walls above had shrunk.
 */
function refitParts(
  polygon: Polygon,
  footprint: Footprint,
  module: number,
): { rects: LocalRect[]; frame: Frame; cut: boolean } {
  const frame = footprint.frame;
  const world = footprint.parts.map((r) => polyToWorld(localRectPolygon(r), frame));
  const composed = multiArea(unionPoly(world));
  const cut = composed > 0 && area(polygon) < composed * 0.985;

  // Untouched: behave exactly as before, `parts` identity included.
  if (!cut) return { rects: footprint.parts, frame, cut: footprint.clippedFraction > 0.015 };

  const rects: LocalRect[] = [];
  for (let i = 0; i < footprint.parts.length; i++) {
    const part = footprint.parts[i]!;
    for (const piece of intersectPoly([world[i]!], [polygon])) {
      if (area(piece) < Math.max(4, localRectArea(part) * 0.12)) continue;
      rects.push(...describeAsRects(piece, frame, module));
    }
  }
  const cover = (rs: LocalRect[]) =>
    rs.length === 0 ? Infinity : rs.reduce((t, r) => t + localRectArea(r), 0) / area(polygon);
  if (cover(rects) <= 1.25) return { rects, frame, cut: true };

  // The building's own frame describes this plan badly — an oblique lot cut, so
  // the walls do not run along the frame's axes at all. Try again in the plan's
  // own minimum-area frame, which is why the frame travels with the rectangles.
  const obb = minAreaObb(polygon);
  const viaObb = describeAsRects(polygon, obb.frame, module);
  if (cover(viaObb) < cover(rects)) {
    if (cover(viaObb) <= MAX_ROOF_COVER) return { rects: viaObb, frame: obb.frame, cut: true };
  } else if (cover(rects) <= MAX_ROOF_COVER) {
    return { rects, frame, cut: true };
  }

  // No set of rectangles describes this plan without hanging a lot of roof over
  // nothing. Report none: `buildRoof` reads that as "there is no span for a
  // ridge to sit over" and lays a 片流れ on the plan itself, which is exact.
  return { rects: [], frame, cut: true };
}

/**
 * Describe a plan piece as frame-aligned rectangles for the roof to sit on.
 *
 * One bounding box is right for a piece that is nearly rectangular and badly
 * wrong for one that is not. The parking space notches the plan into an L, and
 * roofing that L's bounding box hangs four metres of roof over the car with no
 * wall under it — the same floating-roof failure the stack massing exists to
 * prevent. Cutting through the inside corner describes the L properly instead.
 */
function describeAsRects(piece: Polygon, frame: Frame, module: number, depth = 0): LocalRect[] {
  const box = extentsIn(piece, frame);
  const fits = box.w >= module * 2 && box.d >= module * 2;
  const boxArea = localRectArea(box);
  // Near-rectangular, or out of splits: take the box if it describes the piece
  // at all, and otherwise nothing — an oblique lot cut is not a roof rectangle.
  if (area(piece) >= boxArea * 0.85 || depth >= 2) {
    return fits && area(piece) >= boxArea * 0.6 ? [box] : [];
  }

  const reflex = reflexVertex(piece);
  if (!reflex) return fits && area(piece) >= boxArea * 0.6 ? [box] : [];

  let best: LocalRect[] | null = null;
  let bestWaste = Infinity;
  for (const axis of [frame.xAxis, V.perp(frame.xAxis)]) {
    const [left, right] = splitPolygonByLine(piece, reflex, axis);
    const halves = [...left, ...right].filter((h) => area(h) >= 4);
    if (halves.length < 2) continue;
    const rects = halves.flatMap((h) => describeAsRects(h, frame, module, depth + 1));
    if (rects.length === 0) continue;
    const waste = rects.reduce((t, r) => t + localRectArea(r), 0) - area(piece);
    if (waste < bestWaste) {
      bestWaste = waste;
      best = rects;
    }
  }
  // A split that wastes more than the plain box is not worth the extra roof.
  if (best && bestWaste < boxArea - area(piece)) return best;
  return fits && area(piece) >= boxArea * 0.6 ? [box] : [];
}

/** The deepest inside corner of a plan, or null when it is convex. */
function reflexVertex(poly: Polygon): Vec2 | null {
  const n = poly.length;
  if (n < 4) return null;
  const sign = isCCW(poly) ? 1 : -1;
  let worst: Vec2 | null = null;
  let worstTurn = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n]!;
    const v = poly[i]!;
    const q = poly[(i + 1) % n]!;
    const turn = V.cross(V.sub(v, p), V.sub(q, v)) * sign;
    if (turn < worstTurn) {
      worstTurn = turn;
      worst = v;
    }
  }
  return worst;
}

/**
 * Map a level's outline back onto the base footprint's wall classification.
 *
 * Lives here rather than in `facade.ts` because every detail builder needs it:
 * corridors, stairs, laundry and downspouts all have to follow the step instead
 * of staying at the base wall.
 */
export function wallsForPolygon(footprint: Footprint, poly: Polygon): Wall[] {
  const out: Wall[] = [];
  for (const e of polyEdges(poly)) {
    if (e.len < 0.15) continue;
    const normal = V.neg(e.normal);
    const mid = V.lerp(e.a, e.b, 0.5);

    let best: Wall | null = null;
    let bestScore = -Infinity;
    let bestDist = Infinity;
    for (const bw of footprint.walls) {
      const align = V.dot(bw.normal, normal);
      if (align < 0.7) continue;
      const dist = V.distToSegment(mid, bw.a, bw.b);
      const score = align - dist * 0.05;
      if (score > bestScore) {
        bestScore = score;
        bestDist = dist;
        best = bw;
      }
    }

    out.push({
      a: e.a,
      b: e.b,
      len: e.len,
      dir: e.dir,
      normal,
      // Inherited from the base wall rather than recomputed: a step-back wall
      // only ever has *more* room, so this is the conservative direction, and
      // measuring it per floor per stack cost several seconds a town.
      room: best?.room ?? Infinity,
      role: best?.role ?? 'side',
      sunFacing: best?.sunFacing ?? normal.y > 0.4,
      // A step-back wall has the same normal as the base wall it retreated from,
      // so without a proximity gate the corridor flag is inherited onto a wall
      // several metres inboard — unit doors floating over the terrace with no
      // deck beneath them.
      isCorridorSide: best?.isCorridorSide === true && bestDist < 0.75,
    });
  }
  return out;
}
