import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import { SOUTH } from '../core/types.js';
import * as V from '../geom/vec2.js';
import { area, centroid, edges as polyEdges, ensureCCW } from '../geom/polygon.js';
import { clipHalfPlane } from '../geom/halfplane.js';
import { differencePoly, intersectPoly, largest, multiArea, unionPoly } from '../geom/boolean.js';
import { cleanPolygon } from '../geom/simplify.js';
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
import type { Lot } from '../city/Lots.js';
import type { BuildEnvelope, BuildingSpec, Footprint, SlantPlane, Wall, WallRole } from './types.js';

/**
 * Buildable envelope and footprint fitting.
 *
 * This module is the answer to "buildings must sit naturally on non-rectangular
 * lots". The approach is the one real Japanese architects use on odd parcels:
 * design a near-rectangular mass on the module grid, then **clip it against the
 * buildable area**. What comes out is a mostly-rectangular building with one
 * corner sliced off at the lot's odd angle — exactly what the real ones look
 * like — and "fits an arbitrary polygon" becomes a single boolean intersection
 * instead of a research problem.
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
  let buildableParts: Polygon[] = [lot.polygon];

  for (const e of polyEdges(lot.polygon)) {
    let inset: number;
    if (frontIdx.has(e.i)) {
      // The front setback exists so the car pad has somewhere to go.
      inset = params.frontSetback + (wantsPad ? params.carPadDepth : 0);
    } else if (e.i === rearIdx) {
      inset = params.rearSetback;
    } else {
      inset = params.sideSetback; // 民法234条: 50 cm from the boundary
    }
    const hp = { origin: V.addScaled(e.a, e.normal, inset), normal: e.normal };
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
  if (!best) return null;

  const workFrame = best.frame;
  let candidateRect = best.rect;
  const inscribedArea = candidateRect.w * candidateRect.d;

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
  return null;
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
      role: r.role,
      sunFacing: r.sun > 0.4,
      isCorridorSide: spec.hasExteriorCorridor && i === corridorIdx && r.e.len > 4,
    });
  }
  return walls;
}

/** Local-frame coordinates of a world point, for callers that need them. */
export const footprintLocal = (fp: Footprint, p: Vec2): Vec2 => toLocal(p, fp.frame);
