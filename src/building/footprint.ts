import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import { SOUTH } from '../core/types.js';
import * as V from '../geom/vec2.js';
import { area, centroid, edges as polyEdges, ensureCCW, maxInscribedCircle } from '../geom/polygon.js';
import { clipHalfPlane, insetEdgeHalfPlane } from '../geom/halfplane.js';
import { differencePoly, intersectPoly, largest, multiArea, unionPoly } from '../geom/boolean.js';
import { cleanPolygon } from '../geom/simplify.js';
import { offsetInward, offsetInwardVariable } from '../geom/offset.js';
import { bestInscribedRect } from '../geom/inscribedRect.js';
import {
  extentsIn,
  localRectPolygon,
  minAreaObb,
  polyToWorld,
  toLocal,
  type Frame,
  type LocalRect,
} from '../geom/obb.js';
import { projectionRoom } from './mass.js';
import type { Lot } from '../city/Lots.js';
import type { BuildEnvelope, BuildingSpec, Footprint, SlantPlane, Wall, WallRole } from './types.js';

/**
 * Buildable envelope and footprint fitting.
 *
 * This module is the answer to "buildings must sit naturally on non-rectangular
 * lots", and it takes two different routes depending on how odd the parcel is.
 *
 * **Mildly odd — compose and clip.** Design a near-rectangular mass on the
 * module grid, then clip it against the buildable area. What comes out is a
 * mostly-rectangular building with one corner sliced off at the lot's odd angle —
 * exactly what the real ones look like — and "fits an arbitrary polygon" becomes
 * a single boolean intersection instead of a research problem.
 *
 * **Genuinely irregular — follow the boundary.** On a wedge left where two
 * streets meet at an angle, compose-and-clip breaks down: the inscribed
 * rectangle is half the parcel, growing it only reaches the frame's bounding
 * box, and the clip takes the growth straight back off. Below
 * `conformFillThreshold` the outline is therefore built *from the buildable area
 * itself* — chamfer the acute corners (隅切り), then push the non-street walls in
 * until the coverage limit is met. Every wall then runs parallel to the boundary
 * it came from, which is what a real 変形地 house looks like, and the parcel gets
 * a building at all rather than being written off as unbuildable.
 */

/** Snap to the 910 mm half-ken module — the dimensional grid Japanese houses use. */
const snapModule = (v: number, module: number): number => Math.max(module, Math.round(v / module) * module);

export function computeEnvelope(
  lot: Lot,
  spec: BuildingSpec,
  params: BuildingParams,
): BuildEnvelope {
  const frontIdx = new Set(lot.frontages.map((f) => f.i));
  // The rear edge is the one whose outward normal most opposes the primary
  // frontage; everything else is a side.
  let rearIdx = -1;
  let worst = 1;
  for (const e of polyEdges(lot.polygon)) {
    if (frontIdx.has(e.i)) continue;
    const outward = V.neg(e.normal);
    const d = V.dot(outward, lot.faceDir);
    if (d < worst) {
      worst = d;
      rearIdx = e.i;
    }
  }

  const wantsPad = spec.wantsCarPad;
  const setbackOf = (i: number): number =>
    frontIdx.has(i)
      ? // The front setback exists so the car pad has somewhere to go.
        params.frontSetback + (wantsPad ? params.carPadDepth : 0)
      : i === rearIdx
        ? params.rearSetback
        : params.sideSetback; // 民法234条: 50 cm from the boundary

  let buildableParts: Polygon[] = [lot.polygon];
  for (const e of polyEdges(lot.polygon)) {
    const hp = { origin: V.addScaled(e.a, e.normal, setbackOf(e.i)), normal: e.normal };
    const next: Polygon[] = [];
    for (const p of buildableParts) next.push(...clipHalfPlane(p, hp));
    buildableParts = next;
    if (buildableParts.length === 0) break;
  }

  // A flag lot's pole is the driveway, never the building.
  if (lot.poleCorridor && buildableParts.length > 0) {
    buildableParts = differencePoly(buildableParts, [lot.poleCorridor]);
  }

  let buildable = largest(buildableParts);

  // If the car pad made the lot unbuildable, drop the pad rather than the house.
  if ((!buildable || area(buildable) < params.minFloorArea) && wantsPad) {
    spec.wantsCarPad = false;
    return computeEnvelope(lot, spec, params);
  }

  // The half-plane intersection above is exact on a convex parcel and cheap, but
  // on a concave one — an L-shaped remainder, a flag lot's yard — the plane of
  // an edge behind a reflex corner cuts right across the parcel. Twenty-eight
  // parcels a town, several over 300 m², were coming out with *no* buildable
  // area at all and standing empty. Fall back to a band subtraction, which is
  // correct on a concave ring; only parcels the fast path has already given up
  // on reach it, so nothing that works today changes.
  if (!buildable || area(buildable) < params.minFloorArea) {
    let rescued: Polygon[] = offsetInwardVariable(lot.polygon, setbackOf);
    if (lot.poleCorridor && rescued.length > 0) rescued = differencePoly(rescued, [lot.poleCorridor]);
    const best = largest(rescued);
    if (best && (!buildable || area(best) > area(buildable))) buildable = best;
  }

  if (buildable) buildable = cleanPolygon(buildable, { tolerance: 0.05, minEdge: 0.25, minArea: 4 });

  // The strip between the front setback line and the street: the car pad.
  let carPad: Polygon | null = null;
  if (wantsPad && buildable) {
    const pad = differencePoly([lot.polygon], [buildable]);
    const primary = lot.frontages[0]!;
    // Keep only the piece adjacent to the primary frontage.
    let best: Polygon | null = null;
    let bestD = Infinity;
    for (const p of pad) {
      if (area(p) < 8) continue;
      const d = V.dist(centroid(p), primary.mid);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    carPad = best;
  }

  return {
    buildable,
    maxCoverage: spec.coverage,
    maxFAR: spec.far,
    absoluteHeightLimit: spec.heightLimit,
    slantPlanes: computeSlantPlanes(lot, spec, params),
    carPad,
  };
}

/**
 * 斜線制限 — the highest-payoff twenty lines in the project.
 *
 * Applied per floor these produce the chamfered, stepped-back tops that read
 * unmistakably as Japanese mid-rise. No attempt is made at legal accuracy
 * (緩和 rules, 天空率); this is a plausibility heuristic.
 */
function computeSlantPlanes(lot: Lot, spec: BuildingSpec, params: BuildingParams): SlantPlane[] {
  const planes: SlantPlane[] = [];

  // 北側斜線: from the lot's northern boundary. North is -Z in plan coordinates.
  let northMost: { p: Vec2; y: number } | null = null;
  for (const p of lot.polygon) {
    if (!northMost || p.y < northMost.y) northMost = { p, y: p.y };
  }
  if (northMost) {
    planes.push({
      origin: northMost.p,
      inwardNormal: SOUTH,
      baseHeight: spec.kind === 'mansion' ? params.northSlantBaseMid : params.northSlantBaseLow,
      slope: params.northSlantSlope,
    });
  }

  // 道路斜線: measured from the far side of the fronting road.
  for (const f of lot.frontages) {
    planes.push({
      origin: V.addScaled(f.mid, f.outward, f.roadWidth),
      inwardNormal: V.neg(f.outward),
      baseHeight: 0,
      slope: params.roadSlantSlope,
    });
  }
  return planes;
}

/** Compose the archetype shape from one to three module-snapped rectangles. */
function composeShape(
  shape: BuildingSpec['footprintShape'],
  seed: LocalRect,
  module: number,
  rng: Rng,
): LocalRect[] {
  const w = snapModule(seed.w, module);
  const d = snapModule(seed.d, module);
  const base: LocalRect = { cx: seed.cx, cy: seed.cy, w, d };

  switch (shape) {
    case 'rect':
      return [base];

    case 'L': {
      // A corner notch. On the street side it becomes the parking space; at the
      // rear it becomes a small courtyard.
      const nw = snapModule(w * rng.range(0.3, 0.45), module);
      const nd = snapModule(d * rng.range(0.35, 0.5), module);
      if (w - nw < module * 2 || d - nd < module * 2) return [base];
      const sx = rng.chance(0.5) ? 1 : -1;
      const sy = rng.chance(0.5) ? 1 : -1;
      return [
        { cx: base.cx, cy: base.cy - (sy * nd) / 2, w, d: d - nd },
        { cx: base.cx + (sx * nw) / 2, cy: base.cy + (sy * (d - nd)) / 2, w: w - nw, d: nd },
      ];
    }

    case 'T': {
      // Main range plus a rear wing (下屋).
      const wingW = snapModule(w * rng.range(0.4, 0.6), module);
      const wingD = snapModule(d * rng.range(0.3, 0.45), module);
      if (d - wingD < module * 2) return [base];
      return [
        { cx: base.cx, cy: base.cy - wingD / 2, w, d: d - wingD },
        { cx: base.cx + rng.jitter(w * 0.08), cy: base.cy + (d - wingD) / 2, w: wingW, d: wingD },
      ];
    }

    case 'U': {
      // Two wings and a connecting bar — apartments and mansions only.
      const barD = snapModule(d * rng.range(0.3, 0.42), module);
      const wingW = snapModule(w * rng.range(0.26, 0.34), module);
      if (d - barD < module * 2 || w - wingW * 2 < module * 2) return [base];
      return [
        { cx: base.cx, cy: base.cy - (d - barD) / 2, w, d: barD },
        { cx: base.cx - (w - wingW) / 2, cy: base.cy + barD / 2, w: wingW, d: d - barD },
        { cx: base.cx + (w - wingW) / 2, cy: base.cy + barD / 2, w: wingW, d: d - barD },
      ];
    }
  }
}

export function fitFootprint(
  lot: Lot,
  envelope: BuildEnvelope,
  spec: BuildingSpec,
  params: BuildingParams,
): Footprint | null {
  const buildable = envelope.buildable;
  if (!buildable) return null;
  const rng = makeRng(subSeed(lot.seed, 'footprint'));

  // 1. Orientation. Buildings face the street; only the jitter is random.
  //    Randomising rotation outright would destroy the streetscape.
  const primary = lot.frontages[0]!;
  const facing = V.angleOf(primary.outward) + rng.gauss(0, params.orientationJitter) * DEG;
  spec.facingAngle = facing;
  // Local x runs along the street, local +y runs into the lot.
  const frame: Frame = { origin: centroid(buildable), xAxis: V.perp(primary.outward) };
  const frameRotated: Frame = { origin: frame.origin, xAxis: V.rotate(frame.xAxis, facing - V.angleOf(V.perp(primary.outward))) };

  // 2. Target area from coverage, capped by what the envelope can hold.
  const buildableArea = area(buildable);
  const targetArea = Math.min(
    lot.area * envelope.maxCoverage,
    buildableArea * rng.range(0.72, 0.95),
  );

  // 3. Seed rectangle: the largest inscribed axis-aligned rect, searched over
  //    several orientations. Searching only the street-aligned frame lost
  //    20–40% of the area on any lot whose sides are not square to the street —
  //    which, given the cut-angle jitter and the warped grid, is most of them.
  //    The bonus keeps the building facing the street rather than merely
  //    filling the most area.
  const candidateFrames: Frame[] = [frameRotated];
  const lotObb = minAreaObb(buildable);
  for (const axis of [lotObb.frame.xAxis, V.perp(lotObb.frame.xAxis)]) {
    // Only consider a lot-aligned frame if it still roughly faces the street.
    if (Math.abs(V.dot(axis, frameRotated.xAxis)) > 0.55) {
      candidateFrames.push({ origin: frame.origin, xAxis: axis });
    }
  }
  const best = bestInscribedRect(
    buildable,
    candidateFrames,
    (r, i) => r.w * r.d * (i === 0 ? 1.08 : 1),
    0.2,
  );

  const workFrame = best?.frame ?? frameRotated;
  let conformTried = false;
  const conform = (): Footprint | null => {
    if (conformTried || !params.conformIrregular) return null;
    conformTried = true;
    return conformFootprint(buildable, lot, spec, params, workFrame, rng);
  };

  // No rectangle fits at all — a sliver barely wider than the raster cell.
  if (!best) return conform();

  let candidateRect = best.rect;
  const inscribedArea = candidateRect.w * candidateRect.d;

  // How much of the buildable area a rectangle can actually claim. A rectangular
  // parcel scores near 1, a trapezoid around 0.8, a triangle about 0.5 — so this
  // separates "odd enough to clip a corner off" from "odd enough that a
  // rectangle is the wrong idea entirely".
  if (inscribedArea < buildableArea * params.conformFillThreshold) {
    const conformed = conform();
    if (conformed) return conformed;
  }

  if (inscribedArea > targetArea) {
    // Trim toward the target, keeping the street-facing edge fixed so the
    // setback stays constant.
    const k = Math.sqrt(targetArea / inscribedArea);
    const newW = Math.max(params.module * 3, candidateRect.w * Math.max(k, 0.55));
    const newD = Math.max(params.module * 3, candidateRect.d * Math.max(k, 0.55));
    const frontEdge = candidateRect.cy - candidateRect.d / 2;
    candidateRect = { cx: candidateRect.cx, cy: frontEdge + newD / 2, w: newW, d: newD };
  } else {
    // `targetArea` used to be a ceiling only, so a building never grew to meet
    // it and coverage came out at roughly half the nominal 建ぺい率. Grow the
    // rect outward instead: the composed mass is clipped to the buildable area
    // anyway, so a rectangle that overhangs simply becomes a near-rectangular
    // mass cut by the lot — which is exactly the intended shape.
    const ext = extentsIn(buildable, workFrame);
    const grow = Math.sqrt(targetArea / Math.max(1, inscribedArea));
    candidateRect = {
      cx: candidateRect.cx,
      cy: candidateRect.cy,
      w: Math.min(ext.w, candidateRect.w * grow),
      d: Math.min(ext.d, candidateRect.d * grow),
    };
  }

  // 4–6. Compose, clip, and shrink until it fits.
  let shape = spec.footprintShape;
  let scale = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const rect: LocalRect = {
      cx: candidateRect.cx,
      cy: candidateRect.cy,
      w: candidateRect.w * scale,
      d: candidateRect.d * scale,
    };
    const parts = composeShape(shape, rect, params.module, makeRng(subSeed(lot.seed, 'shape', attempt)));
    const worldParts = parts.map((r) => polyToWorld(localRectPolygon(r), workFrame));
    const composed = unionPoly(worldParts);
    if (composed.length === 0) break;
    const composedArea = multiArea(composed);

    // ★ The key step: clip the composed mass to the buildable area.
    const clippedParts = intersectPoly(composed, [buildable]);
    const outline = largest(clippedParts);
    if (outline) {
      const outArea = area(outline);
      if (outArea >= params.minFloorArea) {
        const cleaned = cleanFootprint(outline, params);
        if (cleaned && area(cleaned) >= params.minFloorArea) {
          const clippedFraction = composedArea > 0 ? 1 - outArea / composedArea : 0;
          return {
            outline: cleaned,
            parts,
            frame: workFrame,
            clipped: clippedFraction > 0.005,
            clippedFraction,
            conform: false,
            walls: classifyWalls(cleaned, lot, spec),
            area: area(cleaned),
          };
        }
      }
    }

    scale *= 0.92;
    // Relax to a plain rectangle before giving up entirely.
    if (attempt === 4 && shape !== 'rect') {
      shape = 'rect';
      scale = 1;
    }
  }

  // Nothing rectangular fits. Before writing the parcel off as unbuildable —
  // which leaves a visible hole in the block — try following its shape.
  return conform();
}

/**
 * An outline taken from the buildable area itself: the answer to a triangular
 * parcel, where every rectangle is either too small to build on or too big to
 * fit.
 */
function conformFootprint(
  buildable: Polygon,
  lot: Lot,
  spec: BuildingSpec,
  params: BuildingParams,
  frame: Frame,
  rng: Rng,
): Footprint | null {
  // The half-plane clipping in `computeEnvelope` leaves fans of near-collinear
  // 10 cm edges behind. Merge them into single walls, or the façade grammar
  // divides an 8 cm panel into bays.
  const simplified = cleanPolygon(buildable, {
    tolerance: 0.2,
    minEdge: 0.6,
    maxTurn: 6 * DEG,
    minArea: params.minFloorArea * 0.5,
  });
  if (!simplified) return null;

  const chamfered = chamferAcuteCorners(
    simplified,
    params.conformCornerAngle * DEG,
    params.conformCornerCut,
  );

  // Fuller than the rectangle path allows: using the whole buildable area is the
  // point of a 変形地 house, and the setbacks have already reserved the garden.
  // The floor keeps a parcel with barely more than the minimum buildable area
  // from being shrunk below it and thrown away — 建ぺい率 on a 55 m² parcel is
  // 34 m², so the floor can never breach the coverage limit.
  const target = Math.max(
    params.minFloorArea,
    Math.min(lot.area * spec.coverage, area(buildable) * rng.range(0.82, 0.97)),
  );
  const sized = shrinkToArea(chamfered, target, lot.faceDir);

  const cleaned = cleanFootprint(sized, params);
  if (!cleaned || area(cleaned) < params.minFloorArea) return null;
  // A long enough ribbon clears the minimum floor area while being a metre
  // wide — a wall, not a building. The rectangle path can't produce one because
  // it floors both sides at three modules; this is the equivalent guard, and a
  // parcel that fails it is better left empty than built on.
  if (maxInscribedCircle(cleaned, 0.25).radius < params.module * 1.35) return null;

  // This outline was not composed from rectangles, so there is no span for a
  // ridge to sit over. 片流れ is exact on any polygon — as is 陸屋根 — and both
  // are what actually gets built on a narrow irregular site.
  if (spec.roofType === 'gable' || spec.roofType === 'hip') {
    spec.roofType = 'shed';
    // A 瓦 pitch of 0.45–0.6 run one way across a 10 m wedge is a 5 m rise.
    spec.roofPitch = Math.min(spec.roofPitch, 0.28);
    if (spec.roofFamily === 'roofKawara') spec.roofFamily = 'roofMetal';
  }

  return {
    outline: cleaned,
    // Deliberately empty: there is no rectangle here to drive a pitched roof,
    // and `buildRoof` reads this to know it must not try.
    parts: [],
    frame,
    clipped: true,
    clippedFraction: 0,
    conform: true,
    walls: classifyWalls(cleaned, lot, spec),
    area: area(cleaned),
  };
}

/**
 * 隅切り: cut the sharp corners off.
 *
 * A parcel where two streets meet at 25° ends in a needle. Left alone it becomes
 * a pair of walls a few centimetres apart, which the façade grammar cannot
 * divide and the eaves offsetter cannot round. Chamfering is also what the law
 * requires of a real corner lot, so the fix and the reference agree.
 */
function chamferAcuteCorners(poly: Polygon, minAngle: number, cut: number): Polygon {
  if (cut <= 0) return poly;
  let out = poly;

  // One cut per pass, rescanning afterwards: a clip renumbers the vertices, and
  // a chamfered corner is no longer acute, so this terminates.
  for (let pass = 0; pass < 4; pass++) {
    const n = out.length;
    let cutOne = false;

    for (let i = 0; i < n; i++) {
      const v = out[i]!;
      const prev = out[(i - 1 + n) % n]!;
      const next = out[(i + 1) % n]!;
      // Rings are CCW, so a convex vertex turns left.
      if (V.cross(V.sub(v, prev), V.sub(next, v)) <= 0) continue;

      const a = V.sub(prev, v);
      const b = V.sub(next, v);
      const la = V.len(a);
      const lb = V.len(b);
      if (la < 1e-6 || lb < 1e-6) continue;
      const theta = V.angleBetween(a, b);
      if (theta >= minAngle) continue;

      // Cutting perpendicular to the bisector at distance t from the apex leaves
      // a face of length 2·t·tan(θ/2).
      const t = cut / (2 * Math.tan(theta / 2));
      // A chamfer that eats a whole neighbouring wall means the shape is a
      // needle end to end; cutting it would replace the building, not its corner.
      if (t > 0.35 * Math.min(la, lb)) continue;

      const bisector = V.normalize(V.add(V.scale(a, 1 / la), V.scale(b, 1 / lb)));
      const clipped = largest(
        clipHalfPlane(out, { origin: V.addScaled(v, bisector, t), normal: bisector }),
      );
      if (!clipped) continue;
      out = clipped;
      cutOne = true;
      break;
    }
    if (!cutOne) break;
  }
  return out;
}

/**
 * Bring a conforming outline down to the coverage limit by pushing its walls
 * inward, which is the only shrink that keeps every wall parallel to the
 * boundary it came from.
 */
function shrinkToArea(poly: Polygon, target: number, faceDir: Vec2): Polygon {
  if (area(poly) <= target) return poly;

  // Hold the street-facing walls and push the rest back, so the front setback —
  // and with it the alignment of the streetscape — survives the shrink.
  const movable = polyEdges(poly).filter((e) => V.dot(V.neg(e.normal), faceDir) <= 0.55);
  let out = poly;
  if (movable.length >= 2) {
    const limit = maxInscribedCircle(poly, 0.3).radius * 1.6;
    out =
      searchInset(poly, target, limit, (p, d) => {
        let parts: Polygon[] = [p];
        for (const e of movable) {
          const hp = insetEdgeHalfPlane(e.a, e.normal, d);
          const next: Polygon[] = [];
          for (const q of parts) next.push(...clipHalfPlane(q, hp));
          parts = next;
          if (parts.length === 0) return null;
        }
        return largest(parts);
      }) ?? poly;
    if (area(out) <= target * 1.02) return out;
  }

  // A shape that is nearly all frontage cannot be shrunk that way. A uniform
  // inward offset always can, which is what makes the coverage cap a guarantee
  // rather than an attempt.
  const radius = maxInscribedCircle(out, 0.3).radius;
  return searchInset(out, target, radius, (p, d) => largest(offsetInward(p, d))) ?? out;
}

/**
 * Smallest inset distance in `[0, limit]` whose result is within the area
 * target. Area falls monotonically with the distance, so bisection converges;
 * seven steps put a 5 m bracket inside 4 cm.
 */
function searchInset(
  poly: Polygon,
  target: number,
  limit: number,
  apply: (p: Polygon, d: number) => Polygon | null,
): Polygon | null {
  if (limit <= 1e-3) return null;
  let lo = 0;
  let hi = limit;
  let out: Polygon | null = null;

  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const candidate = apply(poly, mid);
    if (candidate && area(candidate) > target) {
      lo = mid;
    } else {
      hi = mid;
      if (candidate) out = candidate;
    }
  }
  return out;
}

/**
 * Footprint hygiene. Skipping this produces 8 cm wall panels, and the façade
 * grammar then divides by a near-zero length.
 */
function cleanFootprint(poly: Polygon, params: BuildingParams): Polygon | null {
  const cleaned = cleanPolygon(poly, {
    tolerance: 0.15,
    minEdge: 0.3,
    // Merge walls that turn by less than 4 degrees into one.
    maxTurn: 4 * DEG,
    minArea: params.minFloorArea * 0.5,
  });
  return cleaned ? ensureCCW(cleaned) : null;
}

/**
 * Classify each wall. `sunFacing` matters a lot: in Japan balconies and large
 * windows go on the south side and exterior corridors on the north. Deriving
 * that from real world orientation rather than at random is a cheap, strong
 * authenticity signal.
 */
function classifyWalls(outline: Polygon, lot: Lot, spec: BuildingSpec): Wall[] {
  const walls: Wall[] = [];

  // The corridor goes on the wall that faces furthest from south, i.e. the one
  // that gets the least sun — which is where real 外廊下 are.
  let corridorIdx = -1;
  let corridorScore = Infinity;

  const raw = polyEdges(outline).map((e) => {
    const outward = V.neg(e.normal);
    const faceDot = V.dot(outward, lot.faceDir);
    const role: WallRole = faceDot > 0.55 ? 'front' : faceDot < -0.55 ? 'rear' : 'side';
    return { e, outward, role, sun: V.dot(outward, SOUTH) };
  });

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    if (r.role === 'front') continue;
    // Prefer a long wall that faces away from the sun.
    const score = r.sun - r.e.len * 0.02;
    if (score < corridorScore) {
      corridorScore = score;
      corridorIdx = i;
    }
  }

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    walls.push({
      a: r.e.a,
      b: r.e.b,
      len: r.e.len,
      normal: r.outward,
      dir: r.e.dir,
      room: projectionRoom(r.e.a, r.e.b, r.outward, lot.polygon),
      role: r.role,
      sunFacing: r.sun > 0.4,
      isCorridorSide: spec.hasExteriorCorridor && i === corridorIdx && r.e.len > 4,
    });
  }
  return walls;
}

/** Local-frame coordinates of a world point, for callers that need them. */
export const footprintLocal = (fp: Footprint, p: Vec2): Vec2 => toLocal(p, fp.frame);
