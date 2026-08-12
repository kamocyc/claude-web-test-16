import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import { NORTH, SOUTH } from '../core/types.js';
import * as V from '../geom/vec2.js';
import {
  area,
  centroid,
  edges as polyEdges,
  ensureCCW,
  isSimple,
  maxInscribedCircle,
} from '../geom/polygon.js';
import { clipHalfPlane, insetEdgeHalfPlane } from '../geom/halfplane.js';
import { differencePoly, intersectPoly, largest, multiArea, unionPoly } from '../geom/boolean.js';
import { cleanPolygon } from '../geom/simplify.js';
import { offsetInward, offsetInwardVariable } from '../geom/offset.js';
import { bestInscribedRect } from '../geom/inscribedRect.js';
import { CONCRETE, sampleColor } from '../material/palettes.js';
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
import { KIND_RULES } from './kinds.js';
import type {
  BuildEnvelope,
  BuildingSpec,
  Footprint,
  SlantPlane,
  VacancyReason,
  Wall,
  WallRole,
} from './types.js';

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

/**
 * A corner sharper than this is a wedge rather than a corner, and gets cut back.
 * Around one building in forty has one, so this touches very little.
 */
const SHARP_CORNER = 45 * DEG;

/**
 * Narrowest strip of plan worth keeping, in modules.
 *
 * A corner is cut back to where the building is two modules — one 1.82 m bay —
 * across, because below that there is no room behind the wall. And a plan that
 * never reaches 2.7 modules anywhere is a corridor rather than a house, so the
 * parcel is left empty on purpose and says `too-narrow`.
 *
 * 2.7 is not a new judgement: it is `module * 1.35` doubled, the radius the
 * conforming route has always demanded. What is new is that the *clip* route is
 * now held to it as well — it is the route that produces awkward shapes, and it
 * was the one with no width test at all. Tightening it further is tempting and
 * costs real houses: at three modules the town loses another nineteen parcels to
 * vacancy, and a 2.46 m house is narrow but it is a house.
 */
const MIN_CORNER_WIDTH_MODULES = 2;
const MIN_PLAN_WIDTH_MODULES = 2.7;

/**
 * Cut the needles off a plan.
 *
 * The composed mass is clipped against the buildable area, and the two meet at
 * whatever angle the parcel happens to have — so the clip regularly leaves a
 * hairline fin, in the worst case a ring that doubles back on itself at 1.4° and
 * draws as a razor blade sticking out of the house. `cleanPolygon` cannot see
 * these: both of a spike's edges are long, so `minEdge` keeps them, and the turn
 * at its tip is nearly 180°, so `maxTurn` keeps them too. They are only
 * recognisable as *sharp corners*, and the fix is to cut each one back to where
 * the plan is a room's width across.
 *
 * Done as vertex surgery rather than by clipping a half-plane off the corner —
 * which is what `chamferAcuteCorners` does and why it cannot handle the bad
 * cases. On a 1.4° corner the cutting plane lies 60 m from the apex and takes
 * the entire building with it, so that routine has to refuse the cut whenever it
 * would reach past a neighbouring wall; the needles are exactly the corners it
 * refuses. Moving the vertex instead is local by construction, and since it only
 * ever removes area the result cannot escape the buildable area it came from.
 */
function trimSharpCorners(poly: Polygon, minWidth: number): Polygon | null {
  let out = poly;
  // Corners whose surgery would make the ring cross itself. Abandoning the whole
  // trim over one of them would leave every *other* needle on the plan in place.
  const skip = new Set<string>();

  // One cut per pass, sharpest first, rescanning afterwards: a cut renumbers the
  // ring, and it leaves the corner blunter than the threshold, so this ends.
  for (let pass = 0; pass < 8; pass++) {
    const n = out.length;
    if (n < 3) return null;

    let idx = -1;
    let theta = SHARP_CORNER;
    for (let i = 0; i < n; i++) {
      const prev = out[(i - 1 + n) % n]!;
      const v = out[i]!;
      const next = out[(i + 1) % n]!;
      // Rings are CCW, so only a left turn is a convex corner. A reflex vertex
      // is an inside corner and has no needle behind it.
      if (V.cross(V.sub(v, prev), V.sub(next, v)) <= 0) continue;
      if (skip.has(key(v))) continue;
      const a = V.sub(prev, v);
      const b = V.sub(next, v);
      if (V.len(a) < 1e-6 || V.len(b) < 1e-6) continue;
      const t = V.angleBetween(a, b);
      if (t < theta) {
        theta = t;
        idx = i;
      }
    }
    if (idx < 0) return out;

    const prev = out[(idx - 1 + n) % n]!;
    const v = out[idx]!;
    const next = out[(idx + 1) % n]!;
    const a = V.sub(prev, v);
    const b = V.sub(next, v);
    // Distance from the apex at which the wedge first measures `minWidth` across.
    const t = minWidth / (2 * Math.tan(theta / 2));

    // Past the end of one of its own edges the corner is not a corner at all but
    // a fin doubling back on the wall behind it. Dropping the apex merges its two
    // edges into the one wall they were always pretending to be. Try both, so a
    // chamfer that would self-cross still gets the fin off the plan.
    const chamfer: Polygon = [
      ...out.slice(0, idx),
      V.addScaled(v, V.normalize(a), t),
      V.addScaled(v, V.normalize(b), t),
      ...out.slice(idx + 1),
    ];
    const drop: Polygon = out.filter((_, k) => k !== idx);
    const order = t >= V.len(a) * 0.98 || t >= V.len(b) * 0.98 ? [drop, chamfer] : [chamfer, drop];

    const ring = order.find((r) => r.length >= 3 && isSimple(r));
    if (!ring) {
      skip.add(key(v));
      continue;
    }
    out = ring;
  }
  return out;
}

/** Identity for a vertex across the re-indexing a cut causes, to a millimetre. */
const key = (p: Vec2): string => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

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
      ? params.frontSetback
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

  // The parking space, as a rectangle in one front corner rather than a band
  // across the whole frontage. Cars need 2.5 m of a frontage that is often three
  // times that, and setting the entire front elevation back by a car's length
  // threw away about 17% of a median lot — more the wider the lot.
  const carPad = wantsPad ? carPadRect(lot, params) : null;
  spec.carPadAt = carPad ? centroid(carPad) : null;
  if (carPad && buildableParts.length > 0) {
    buildableParts = differencePoly(buildableParts, [carPad]);
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

  // Say why there is nothing here, so the lot does not become an unexplained
  // hole in the block. `buildable-too-small` is deliberately distinguished from
  // `no-buildable-area`: the first is a scrap of land, the second means the
  // setbacks consumed a parcel that looked perfectly ordinary.
  const reason: VacancyReason | null = !buildable
    ? 'no-buildable-area'
    : area(buildable) < params.minFloorArea * 0.5
      ? 'buildable-too-small'
      : null;

  return {
    buildable,
    reason,
    maxCoverage: spec.coverage,
    maxFAR: spec.far,
    absoluteHeightLimit: spec.heightLimit,
    slantPlanes: computeSlantPlanes(lot, spec, params),
    carPad: buildable ? carPad : null,
  };
}

/**
 * The lateral direction along the street that points furthest north.
 *
 * Buildings are pushed this way and the parking space goes at the other end, so
 * the leftover land collects on the south side as one usable garden instead of
 * two unusable 80 cm strips. That is both what a Japanese developer builds and
 * what the balcony and 北側斜線 logic already assume about which way is which.
 */
function northwardAlongStreet(faceDir: Vec2): Vec2 {
  const along = V.perp(faceDir);
  return V.dot(along, NORTH) >= 0 ? along : V.neg(along);
}

/**
 * The parking space: a rectangle in the front corner of the lot, on the south
 * side of the primary frontage.
 *
 * It is deliberately laid hard against the boundary — parking has no setback
 * requirement — so it overlaps the side setback strip and only costs the
 * building the remainder.
 */
function carPadRect(lot: Lot, params: BuildingParams): Polygon | null {
  const f = lot.frontages[0];
  if (!f) return null;
  const inward = V.neg(f.outward);
  // The south end of the frontage, i.e. away from the side the building takes.
  const north = northwardAlongStreet(lot.faceDir);
  const corner = V.dot(V.sub(f.b, f.a), north) < 0 ? f.b : f.a;
  // From the southern end of the frontage, back northward by the pad's width.
  const along = V.scale(north, Math.min(params.carPadWidth, f.len));

  // Start just outside the frontage line so the pad reliably reaches the street
  // once it is clipped back to the lot.
  const base = V.addScaled(corner, inward, -0.3);
  const rect: Polygon = [
    base,
    V.add(base, along),
    V.addScaled(V.add(base, along), inward, params.carPadDepth),
    V.addScaled(base, inward, params.carPadDepth),
  ];
  return largest(intersectPoly([rect], [lot.polygon]));
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
  //
  // Only in 低層住専 and 中高層住専. A factory or a 雑居ビル is genuinely not
  // subject to it — which is also what keeps a 20 m shed from being sliced into
  // steps by a rule written for the sunlight of the house behind it.
  const slant = KIND_RULES[spec.kind].slantBase;
  if (slant !== 'none') {
    let northMost: { p: Vec2; y: number } | null = null;
    for (const p of lot.polygon) {
      if (!northMost || p.y < northMost.y) northMost = { p, y: p.y };
    }
    if (northMost) {
      planes.push({
        origin: northMost.p,
        inwardNormal: SOUTH,
        baseHeight: slant === 'mid' ? params.northSlantBaseMid : params.northSlantBaseLow,
        slope: params.northSlantSlope,
      });
    }
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

/**
 * The shallowest stretch of building behind any wall of a plan.
 *
 * A needle is a sharp corner and `trimSharpCorners` finds it by its angle, but
 * the other two ways a plan goes thin have no sharp corner to find. A wedge
 * truncated by a 70 cm edge — 27 m long, tapering from 4.3 m to nothing — turns
 * every corner at a decent angle. And the wall insets that bring a conforming
 * outline down to its coverage limit can leave two walls five centimetres apart,
 * which is a hairline crack down the side of the house. Both are only visible as
 * *how much building there is behind a wall*, which is what this measures: cast
 * inward from three points along each wall and take the worst first crossing.
 */
function wallDepth(poly: Polygon): number {
  const es = polyEdges(poly);
  let worst = Infinity;
  for (const e of es) {
    for (let s = 1; s <= 3; s++) {
      // Start just inside the wall, or the ray leaves through its own edge.
      const p = V.addScaled(V.lerp(e.a, e.b, s / 4), e.normal, 1e-4);
      const far = V.addScaled(p, e.normal, 200);
      let hit = Infinity;
      for (const o of es) {
        if (o.i === e.i) continue;
        const x = V.segmentIntersection(p, far, o.a, o.b);
        if (x) hit = Math.min(hit, V.dist(p, x.point));
      }
      worst = Math.min(worst, hit);
    }
  }
  return worst;
}

/**
 * Remove every part of a plan thinner than `2·r` — a morphological opening,
 * clipped back to the original so the result can only ever lose area.
 *
 * This is the general form of what `trimSharpCorners` does locally, and it is
 * reached only for the one plan in twenty that needs it.
 *
 * The dilation puts a *square* on each vertex of the core rather than a disc,
 * oriented to the building's own frame. A round join stops 0.41·r short of a
 * square corner, so opening an ordinary house with round joins files 37 cm off
 * each of its corners and leaves a fan of 40 cm wall panels behind — sixteen
 * walls on a plan that had six, several of them too short for the façade grammar
 * to put anything on, including the front door. A frame-aligned square reaches
 * the corner exactly, so a frame-aligned plan comes back byte for byte, and
 * anywhere it over-reaches the final clip against `poly` puts it back.
 *
 * Every boolean below fails *open* — `differencePoly` hands back its subject
 * unchanged and `intersectPoly` returns nothing — so the result is verified
 * against what an opening can possibly do rather than trusted.
 */
function openPlan(poly: Polygon, r: number, frame: Frame): Polygon | null {
  const core = offsetInward(poly, r);
  if (core.length === 0) return null;

  const ax = V.scale(frame.xAxis, r);
  const ay = V.scale(V.perp(frame.xAxis), r);
  const parts: Polygon[] = [];
  for (const c of core) {
    parts.push(c);
    for (const e of polyEdges(c)) {
      const out = V.neg(e.normal);
      parts.push([e.a, e.b, V.addScaled(e.b, out, r), V.addScaled(e.a, out, r)]);
    }
    for (const p of c) {
      parts.push([
        V.sub(V.sub(p, ax), ay),
        V.sub(V.add(p, ax), ay),
        V.add(V.add(p, ax), ay),
        V.add(V.sub(p, ax), ay),
      ]);
    }
  }

  const grown = unionPoly(parts);
  if (grown.length === 0) return null;
  const kept = largest(intersectPoly(grown, [poly]));
  if (!kept || area(kept) > area(poly) + 1e-6) return null;
  return kept;
}

/**
 * The last word on whether a plan is a building, shared by both routes so that
 * "too thin to be a room" means one thing rather than two.
 *
 * It used to mean two. The conforming route rejected a plan that held no circle
 * 2.5 m across — "a building here would be a corridor, not a house" — while the
 * compose-and-clip route had no width test whatever, so it was perfectly willing
 * to return a house 15.4 m long and 1.8 m deep. The clip is the route that
 * *produces* awkward shapes, so it was the one that needed the check.
 */
function finishOutline(
  poly: Polygon,
  within: Polygon,
  frame: Frame,
  params: BuildingParams,
): Polygon | null {
  // Wide enough to be rooms, and big enough to be a house. A plan that fails
  // either is not one, and the parcel is left empty saying `too-narrow`.
  const usable = (p: Polygon): boolean =>
    area(p) >= params.minFloorArea &&
    maxInscribedCircle(p, 0.25).radius >= (params.module * MIN_PLAN_WIDTH_MODULES) / 2;

  // Cleaned first, and only then trimmed. The other way round, the clip back
  // against the envelope that `cleanFootprintWithin` performs puts a chamfered
  // corner straight back — which is why the sharpest corner in the town stayed
  // at 7° with the trim apparently running on every plan.
  const base = cleanFootprintWithin(poly, within, params);
  if (!base) return null;
  const trimmed = trimSharpCorners(base, params.module * MIN_CORNER_WIDTH_MODULES);
  // The trim only ever removes area, so the result cannot escape the envelope
  // and needs no second clip — just the tidy-up for the edges the cuts leave.
  let out = (trimmed && trimmed !== base ? cleanFootprint(trimmed, params) : base) ?? base;
  if (!usable(out)) return null;

  // A wedge truncated by a short edge, or a hairline crack between two walls the
  // coverage inset pushed together — neither has a sharp corner to cut, and only
  // these pay for the opening. It runs *after* the judgement above rather than
  // before, because eroding a plan that was never wide enough empties it, and
  // reading that as "the repair failed" is how a cosmetic step ends up deciding
  // which parcels get a building. Here it can only ever improve one.
  if (wallDepth(out) < params.module * MIN_CORNER_WIDTH_MODULES) {
    // As much erosion as the plan can stand. A full module removes everything
    // narrower than 1.82 m, but on a plan barely over the width floor it removes
    // the plan — and a repair that empties its own input just declines, leaving
    // the thin part in place. Sizing it to the widest circle the plan holds means
    // the two smallest houses in the town still get the treatment, in proportion.
    const r = Math.min(params.module, maxInscribedCircle(out, 0.25).radius * 0.6);
    const opened = openPlan(out, r, frame);
    // Trimmed again on the way out: the square joins meet the original walls at
    // whatever angle they like, and left alone the repair reintroduced a 0.3°
    // needle of its own. Neither step ever adds area, so this needs no second
    // clip against the envelope — only the tidy-up.
    const trimmedOpen = opened ? (trimSharpCorners(opened, params.module * MIN_CORNER_WIDTH_MODULES) ?? opened) : null;
    const settled = trimmedOpen ? cleanFootprint(trimmedOpen, params) : null;
    if (settled && usable(settled)) out = settled;
  }

  // Last word: if a needle is still there, do not build.
  //
  // `trimSharpCorners` cuts one corner per pass and gives up on any whose
  // surgery would cross the ring, so a plan can come out the far end still
  // ending in a point — rare, and it took a parcel cut against a river bank to
  // produce one. Shipping it anyway draws a razor blade stuck to the side of a
  // house. Refusing is the answer this file already gives to a plan it cannot
  // make into a building: the parcel stays empty and says why.
  if (sharpestConvexCorner(out) < NEEDLE_FLOOR) return null;
  return out;
}

/** Below this a convex corner is a needle rather than a corner. */
const NEEDLE_FLOOR = 25 * (Math.PI / 180);

/**
 * The sharpest *convex* corner of a CCW ring, in radians.
 *
 * Convex only: a reflex vertex measures its angle from the outside and is an
 * inside corner, which no amount of sharpness turns into a needle.
 */
function sharpestConvexCorner(poly: Polygon): number {
  let worst = Math.PI;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n]!;
    const v = poly[i]!;
    const next = poly[(i + 1) % n]!;
    if (V.cross(V.sub(v, prev), V.sub(next, v)) <= 0) continue;
    const a = V.sub(prev, v);
    const b = V.sub(next, v);
    if (V.len(a) < 1e-6 || V.len(b) < 1e-6) continue;
    worst = Math.min(worst, V.angleBetween(a, b));
  }
  return worst;
}

/** Filled in when the fit fails, so the caller can say why the lot is empty. */
export interface FitDiagnostics {
  reason: VacancyReason | null;
}

export function fitFootprint(
  lot: Lot,
  envelope: BuildEnvelope,
  spec: BuildingSpec,
  params: BuildingParams,
  diag?: FitDiagnostics,
): Footprint | null {
  const buildable = envelope.buildable;
  if (!buildable) {
    if (diag) diag.reason = envelope.reason ?? 'no-buildable-area';
    return null;
  }
  if (diag) diag.reason = envelope.reason ?? 'no-footprint-fits';
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
  //    `footprintFill` is the term that actually decides how much garden is
  //    left: the setbacks usually take enough that the coverage limit never
  //    binds, so the 建ぺい率 on its own moves almost nothing.
  const buildableArea = area(buildable);
  const targetArea = Math.min(
    lot.area * envelope.maxCoverage,
    buildableArea * (params.footprintFill + rng.jitter(0.07)),
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
    // Only consider a lot-aligned frame if it still faces the street.
    //
    // This threshold is the single largest influence on whether a street reads
    // as a street. `workFrame` below — not `spec.facingAngle` — is what actually
    // orients the composed footprint, so admitting a frame here admits a house
    // rotated that far off the frontage. The old value of 0.55 allowed 56.6°,
    // which meant a lot whose side boundaries had been skewed by
    // `cutAngleJitter` could turn its house most of the way to sideways-on,
    // even on a perfectly square grid.
    if (Math.abs(V.dot(axis, frameRotated.xAxis)) > params.frameAlignMin) {
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
  // Memoised rather than single-shot. It used to refuse a second call outright,
  // which made the final fallback at the end of this function dead code for
  // exactly the lots that needed it most — any parcel odd enough to try
  // conforming early and fail was then denied the last-chance attempt.
  let conformed: Footprint | null | undefined;
  const conform = (): Footprint | null => {
    if (!params.conformIrregular) return null;
    // A shed or a shop is a catalogue rectangle put down in the middle of
    // whatever it is given, so it never follows the boundary. Letting one try
    // put a コンビニ on a triangular corner as a 25 m × 3 m ribbon: shrinking a
    // wedge to its coverage limit while holding the street wall can only be done
    // by pushing the back wall in until the building is a corridor.
    if (!KIND_RULES[spec.kind].conform) return null;
    if (conformed === undefined) {
      conformed = conformFootprint(buildable, lot, spec, params, workFrame, rng);
      if (!conformed && diag) diag.reason = 'too-narrow';
    }
    return conformed;
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

  // Which way along the street is north, in local-frame terms. Slack goes to the
  // south side so it collects as one usable garden rather than a pair of 80 cm
  // strips nobody can stand in.
  const northSide = V.dot(workFrame.xAxis, northwardAlongStreet(lot.faceDir)) >= 0 ? 1 : -1;

  if (inscribedArea > targetArea) {
    // Trim toward the target, keeping the street-facing edge fixed so the
    // setback stays constant and flushing the building to the north boundary.
    const k = Math.sqrt(targetArea / inscribedArea);
    const newW = Math.max(params.module * 3, candidateRect.w * Math.max(k, 0.55));
    const newD = Math.max(params.module * 3, candidateRect.d * Math.max(k, 0.55));
    const frontEdge = candidateRect.cy - candidateRect.d / 2;
    // Staying inside the inscribed rectangle keeps this inside the buildable
    // area, so flushing never needs a clip to make it legal.
    const shift = (Math.max(0, candidateRect.w - newW) / 2) * northSide;
    candidateRect = { cx: candidateRect.cx + shift, cy: frontEdge + newD / 2, w: newW, d: newD };
  } else {
    // `targetArea` used to be a ceiling only, so a building never grew to meet
    // it and coverage came out at roughly half the nominal 建ぺい率. Grow the
    // rect outward instead: the composed mass is clipped to the buildable area
    // anyway, so a rectangle that overhangs simply becomes a near-rectangular
    // mass cut by the lot — which is exactly the intended shape.
    const ext = extentsIn(buildable, workFrame);
    const grow = Math.sqrt(targetArea / Math.max(1, inscribedArea));
    const newW = Math.min(ext.w, candidateRect.w * grow);
    candidateRect = {
      // Flush north within the buildable's own extent. Any overhang past the
      // taper is removed by the clip below, which is the documented intent.
      cx: ext.cx + ((ext.w - newW) / 2) * northSide,
      cy: candidateRect.cy,
      w: newW,
      d: Math.min(ext.d, candidateRect.d * grow),
    };
  }

  // 4–6. Compose, clip, and shrink until it fits.
  //
  // The parking space already notches the plan into an L — the archetype's own
  // notch is documented as *being* the parking space, so composing one on top
  // takes a second bite out of the same building for the same reason, and costs
  // roughly 6% of the coverage across the town.
  let shape = envelope.carPad ? 'rect' : spec.footprintShape;
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
    let tooSmall = true;
    if (outline) {
      const outArea = area(outline);
      if (outArea >= params.minFloorArea) {
        tooSmall = false;
        const cleaned = finishOutline(outline, buildable, workFrame, params);
        if (cleaned) {
          const clippedFraction = composedArea > 0 ? 1 - outArea / composedArea : 0;
          return {
            outline: cleaned,
            parts,
            frame: workFrame,
            clipped: clippedFraction > 0.005,
            clippedFraction,
            conform: false,
            walls: classifyWalls(cleaned, lot, spec, params.module),
            area: area(cleaned),
          };
        }
        // Big enough, but a corridor or all needle. Shrinking cannot widen it —
        // 0.92 of a ribbon is a shorter ribbon — so drop to a plain rectangle,
        // which claims the fattest part of an awkward parcel, and failing that
        // hand over to the conforming route.
        if (shape !== 'rect') {
          shape = 'rect';
          scale = 1;
          continue;
        }
        if (diag) diag.reason = 'too-narrow';
        break;
      }
    }

    // Shrinking answers "the mass overhangs the buildable area". It cannot
    // answer "what survived the clip is too small" — that failure only gets
    // worse at 0.92 the size, which used to burn four of the eight attempts
    // making the outcome less likely each time. Go straight to the shape
    // relaxation instead: a plain rectangle claims more of an awkward parcel
    // than an L or a U does.
    if (tooSmall && shape !== 'rect') {
      shape = 'rect';
      scale = 1;
      continue;
    }
    if (tooSmall) break;

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

  // A long enough ribbon clears the minimum floor area while being a metre
  // wide — a wall, not a building — and a wedge left between two streets ends in
  // a needle. A parcel that cannot hold anything better is left empty on
  // purpose, which is what `too-narrow` records.
  const cleaned = finishOutline(sized, buildable, frame, params);
  if (!cleaned) return null;

  // This outline was not composed from rectangles, so there is no span for a
  // ridge to sit over. 片流れ is exact on any polygon — as is 陸屋根 — and both
  // are what actually gets built on a narrow irregular site.
  //
  // 陸屋根 takes the majority. Sending every irregular parcel to a mono-pitch
  // made 片流れ a quarter of the whole town, and irregular parcels cluster —
  // they are the leftovers of one awkward block — so the ones that did land
  // together all leaned the same way.
  if (spec.roofType === 'gable' || spec.roofType === 'hip') {
    if (rng.chance(0.62)) {
      spec.roofType = 'flat';
      // The roof family drives which texture buffer the geometry lands in, so a
      // 瓦 family here would tile the parapet coping with pantiles.
      spec.roofFamily = 'concrete';
      spec.roofColor = sampleColor(CONCRETE, rng, { h: 0.01, s: 0.03, v: 0.05 }).color;
    } else {
      spec.roofType = 'shed';
      // A 瓦 pitch of 0.45–0.6 run one way across a 10 m wedge is a 5 m rise.
      spec.roofPitch = Math.min(spec.roofPitch, 0.28);
      if (spec.roofFamily === 'roofKawara') spec.roofFamily = 'roofMetal';
    }
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
    walls: classifyWalls(cleaned, lot, spec, params.module),
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
 * Clean, then put back anything the cleaning pushed outside the envelope.
 *
 * Simplification is not area-preserving. Merging a staircase of 10 cm clip
 * edges into one wall moves that wall *outward*, and on a heavily clipped
 * footprint that left 5% of the plan standing over its own setback. Clipping
 * back is exact, but it recreates short edges, so this alternates the two: each
 * round starts from a shape with fewer stairs to bulge, and the excess collapses
 * within two or three. A shape that will not settle is returned clipped and
 * unsimplified — correct geometry is worth more than tidy walls.
 */
function cleanFootprintWithin(
  poly: Polygon,
  within: Polygon,
  params: BuildingParams,
): Polygon | null {
  let current = poly;
  for (let i = 0; i < 3; i++) {
    const cleaned = cleanFootprint(current, params);
    if (!cleaned) return null;
    const inside = multiArea(intersectPoly([cleaned], [within]));
    if (area(cleaned) - inside <= area(cleaned) * 0.005) return cleaned;
    const clipped = largest(intersectPoly([cleaned], [within]));
    if (!clipped || area(clipped) < params.minFloorArea) return null;
    current = clipped;
  }
  return isSimple(current) ? ensureCCW(current) : null;
}

/**
 * Footprint hygiene. Skipping this produces 8 cm wall panels, and the façade
 * grammar then divides by a near-zero length.
 */
function cleanFootprint(poly: Polygon, params: BuildingParams): Polygon | null {
  const opts = {
    tolerance: 0.15,
    minEdge: 0.3,
    // Merge walls that turn by less than 4 degrees into one.
    maxTurn: 4 * DEG,
    minArea: params.minFloorArea * 0.5,
  };
  const cleaned = cleanPolygon(poly, opts);
  if (!cleaned) return null;
  if (isSimple(cleaned)) return ensureCCW(cleaned);

  // Clipping against an L-shaped buildable — which is what the car pad's notch
  // makes it — can pinch the result into a ring that touches itself, and merging
  // near-collinear walls can close the neck the rest of the way. A union
  // decomposes that into separate simple components; handing a figure-eight
  // downstream produces a building with self-crossing walls.
  let best: Polygon | null = null;
  for (const part of unionPoly([cleaned])) {
    const c = cleanPolygon(part, opts);
    if (!c || !isSimple(c)) continue;
    if (!best || area(c) > area(best)) best = c;
  }
  return best ? ensureCCW(best) : null;
}

/**
 * Classify each wall. `sunFacing` matters a lot: in Japan balconies and large
 * windows go on the south side and exterior corridors on the north. Deriving
 * that from real world orientation rather than at random is a cheap, strong
 * authenticity signal.
 */
function classifyWalls(outline: Polygon, lot: Lot, spec: BuildingSpec, module: number): Wall[] {
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

  const entranceIdx = chooseEntrance(raw, lot, spec, module);

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
      isEntrance: i === entranceIdx,
    });
  }
  return walls;
}

/**
 * Which wall the front door goes on — one wall, chosen for the building.
 *
 * The rule used to be "any wall whose outward normal is within 57° of the
 * street", applied independently per wall, which is three separate mistakes:
 * a building with two street-facing walls got two front doors, a wall that
 * pointed streetward from four metres back behind the parking space counted as
 * much as the one on the street, and a house whose frontage had been clipped
 * down to a metre and a half got no door at all because that wall was too short
 * to divide into bays.
 *
 * `aim` answers the user's actual requirement — the entrance faces the road *or*
 * the parking space — and `reach` breaks the tie in favour of the wall nearest
 * the street, which is where a 玄関 is. Length only breaks near-ties, so a short
 * wall squarely on the street still beats a long one facing the neighbours; the
 * façade builder narrows its margins to fit a door on whatever this returns.
 */
function chooseEntrance(
  raw: { e: { a: Vec2; b: Vec2; len: number }; outward: Vec2; role: WallRole }[],
  lot: Lot,
  spec: BuildingSpec,
  module: number,
): number {
  if (KIND_RULES[spec.kind].entranceOnCorridor) return -1; // Unit doors are the entrances.
  const front = lot.frontages[0];
  if (!front) return -1;

  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    const mid = V.lerp(r.e.a, r.e.b, 0.5);
    // Facing the street, or facing the car standing on the parking space.
    let aim = V.dot(r.outward, lot.faceDir);
    if (spec.carPadAt) {
      const toPad = V.sub(spec.carPadAt, mid);
      const d = V.len(toPad);
      if (d > 0.5) aim = Math.max(aim, V.dot(r.outward, V.scale(toPad, 1 / d)));
    }
    if (aim < 0.25) continue; // More than 75° from both: a door here faces nothing.
    // A 910 mm door needs 910 mm of wall. Without this the best-aimed candidate
    // is regularly a 36 cm chamfer that happens to point straight at the road.
    if (r.e.len < module) continue;
    const reach = V.dot(V.sub(mid, front.mid), front.outward);
    const score = aim + reach * 0.06 + Math.min(r.e.len, 6) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  // Nothing faces the street at all, or nothing that does is wide enough for a
  // door — a plan clipped into a shape that turns its back on the road. Better a
  // door on the least wrong wall than a house with no way in, which is what this
  // used to produce.
  if (best < 0) {
    let far = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      const d = V.dot(V.sub(V.lerp(r.e.a, r.e.b, 0.5), front.mid), front.outward) + r.e.len * 0.1;
      if (d > far) {
        far = d;
        best = i;
      }
    }
  }
  return best;
}

/** Local-frame coordinates of a world point, for callers that need them. */
export const footprintLocal = (fp: Footprint, p: Vec2): Vec2 => toLocal(p, fp.frame);
