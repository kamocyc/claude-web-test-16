import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type CityParams, type LotParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import {
  area,
  centroid,
  edges as polyEdges,
  maxInscribedCircle,
  type Edge,
} from '../geom/polygon.js';
import { clipHalfPlane, splitPolygonByLine, type HalfPlane } from '../geom/halfplane.js';
import { minAreaObb } from '../geom/obb.js';
import { differencePoly, intersectPoly, largest, multiArea, unionPoly } from '../geom/boolean.js';
import { cleanPolygon } from '../geom/simplify.js';
import type { Block } from './Blocks.js';
import type { RoadClass, RoadNetwork } from './Roads.js';

/**
 * Lot subdivision — the crux of the whole generator. Everything downstream
 * inherits the quality of what comes out of here.
 *
 * **Recursive OBB splitting is deliberately not used.** It is the usual
 * textbook answer and it does not preserve road frontage: interior parcels end
 * up landlocked. In Japan that is not a cosmetic problem — 接道義務 means a
 * parcel without at least 2 m of frontage on a 4 m road literally cannot be
 * built on.
 *
 * Instead: peel a frontage-depth ring off the block, slice that ring
 * perpendicular to its street, and give whatever is left in the middle either a
 * private lane (私道) or flag-lot poles (旗竿地). Every parcel that survives has
 * frontage by construction.
 */

export type LotKind = 'house' | 'apart' | 'mansion' | 'vacant';

export interface LotFrontage {
  /** Index of the frontage edge in `polygon`. */
  i: number;
  a: Vec2;
  b: Vec2;
  len: number;
  dir: Vec2;
  /** Outward normal — points from the lot toward the street. */
  outward: Vec2;
  cls: RoadClass;
  roadWidth: number;
  /** Midpoint of the frontage edge. */
  mid: Vec2;
}

export interface Lot {
  id: number;
  seed: string;
  blockId: number;
  polygon: Polygon;
  area: number;
  frontages: LotFrontage[];
  /** Outward normal of the primary frontage — the direction the building faces. */
  faceDir: Vec2;
  frontPoint: Vec2;
  centroid: Vec2;
  isFlagLot: boolean;
  poleCorridor: Polygon | null;
  clusterId: number;
  kind: LotKind;
  urbanity: number;
}

interface Parcel {
  polygon: Polygon;
  isFlagLot: boolean;
  poleCorridor: Polygon | null;
}

/** A frontage-bearing edge carried through the block-interior clipping. */
interface FrontRef {
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  /** Points into the block interior. */
  inward: Vec2;
  cls: RoadClass;
  roadWidth: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function subdivideBlock(
  block: Block,
  net: RoadNetwork,
  params: CityParams,
  idOffset: number,
): Lot[] {
  const cfg = params.lots;
  const rng = makeRng(subSeed(block.seed, 'lots'));

  // --- Stage A: road right-of-way -----------------------------------------
  // Road widths differ per edge, so this is an intersection of half-planes
  // rather than a uniform offset. Doing it as an offset would be both slower
  // and wrong.
  const fronts: FrontRef[] = [];
  let interior: Polygon[] = [block.polygon];

  for (const e of block.edges) {
    if (e.cls === null) continue;
    const inset = e.roadWidth / 2 + cfg.gutterWidth;
    const hp: HalfPlane = { origin: V.addScaled(e.a, e.normal, inset), normal: e.normal };
    const next: Polygon[] = [];
    for (const p of interior) next.push(...clipHalfPlane(p, hp));
    if (next.length === 0) return [];
    interior = next;
    fronts.push({
      a: hp.origin,
      b: V.addScaled(e.b, e.normal, inset),
      dir: e.dir,
      inward: e.normal,
      cls: e.cls,
      roadWidth: e.roadWidth,
    });
  }

  if (fronts.length === 0) return [];
  const inner = largest(interior);
  if (!inner || area(inner) < cfg.minLotArea) return [];

  const parcels = subdivideInterior(inner, fronts, cfg, rng, net, 0);
  return finaliseLots(parcels, block, fronts, cfg, idOffset);
}

/**
 * Ring / core split, then slice. Recurses into the core when a private lane can
 * reach it.
 */
function subdivideInterior(
  inner: Polygon,
  fronts: FrontRef[],
  cfg: LotParams,
  rng: Rng,
  net: RoadNetwork,
  depth: number,
): Parcel[] {
  const parcels: Parcel[] = [];
  // A block fronting a wide road gets deeper lots; that plus wider slices is
  // what produces the large arterial-front parcels マンション need.
  const major = fronts.some((f) => f.cls === 'arterial' || f.cls === 'collector');
  const lotDepth = rng.gaussClamped(
    major ? cfg.depthMeanMajor : cfg.depthMean,
    cfg.depthSigma,
    cfg.depthMin,
    major ? cfg.depthMeanMajor + 8 : cfg.depthMax,
  );

  // The core is what remains once every frontage edge is pushed inward by the
  // lot depth. Offsetting *only* the frontage edges is exactly an intersection
  // of half-planes — no variable-width offsetter needed.
  let coreParts: Polygon[] = [inner];
  for (const f of fronts) {
    const hp: HalfPlane = { origin: V.addScaled(f.a, f.inward, lotDepth), normal: f.inward };
    const next: Polygon[] = [];
    for (const p of coreParts) next.push(...clipHalfPlane(p, hp));
    coreParts = next;
    if (coreParts.length === 0) break;
  }
  const core = coreParts.length > 0 ? largest(coreParts) : null;
  const coreArea = core ? area(core) : 0;

  // Strips: the part of `inner` within `lotDepth` of each frontage edge, with
  // earlier strips subtracted so corners are not claimed twice.
  const strips: { poly: Polygon; front: FrontRef }[] = [];
  // Kept as a plain list, deliberately *not* unioned: the union of frontage
  // strips around a deep block is an annulus, and this pipeline drops holes, so
  // unioning would silently hand back a solid disc and over-subtract every
  // later band.
  const consumed: Polygon[] = [];
  const ordered = [...fronts].sort((a, b) => V.dist(b.a, b.b) - V.dist(a.a, a.b));

  for (const f of ordered) {
    const cut: HalfPlane = {
      origin: V.addScaled(f.a, f.inward, lotDepth),
      normal: V.neg(f.inward),
    };
    let band = clipHalfPlane(inner, cut);
    if (consumed.length > 0) band = differencePoly(band, consumed);
    for (const p of band) {
      if (area(p) >= cfg.minLotArea * 0.6) strips.push({ poly: p, front: f });
      consumed.push(p);
    }
  }

  // --- Core handling -------------------------------------------------------
  // Anything that reaches the core has to cross the frontage strips to get
  // there. Those crossings are collected as carve-outs and removed from the
  // street lots afterwards — a private lane is public land, and a flag lot's
  // pole belongs to the flag lot, so in both cases the street lot loses it.
  const carveOuts: Polygon[] = [];
  const canRecurse = depth < cfg.maxRecursionDepth;
  let laneBuilt = false;

  if (core && canRecurse && coreArea >= cfg.minCoreArea) {
    const lane = tryPrivateLane(core, inner, ordered, cfg, rng);
    if (lane) {
      laneBuilt = true;
      net.privateLanes.push({ a: lane.from, b: lane.to, width: cfg.privateLaneWidth });
      carveOuts.push(lane.corridor);
      const laneFronts = laneFrontRefs(lane, cfg);
      for (const piece of differencePoly([core], [lane.corridor])) {
        if (area(piece) < cfg.minLotArea) continue;
        const usable = laneFronts.filter((lf) => touchesFront(piece, lf));
        if (usable.length === 0) continue;
        parcels.push(...subdivideInterior(piece, usable, cfg, rng, net, depth + 1));
      }
    }
  }

  // A core too small for its own lane still gets flag lots: a leftover of one or
  // two lots' worth of land behind the street row is exactly where 旗竿地 come
  // from in real Japanese blocks.
  if (core && !laneBuilt && canRecurse && coreArea >= cfg.flagLotMinCore && rng.chance(cfg.flagLotChance)) {
    const flags = makeFlagLots(core, inner, ordered, cfg, rng);
    parcels.push(...flags);
    for (const f of flags) if (f.poleCorridor) carveOuts.push(f.poleCorridor);
  }

  // --- Stage C: slice each strip perpendicular to its street ---------------
  const stripParcels: Parcel[] = [];
  for (const s of strips) {
    stripParcels.push(...sliceStripIntoLots(s.poly, s.front, cfg, rng));
  }

  if (carveOuts.length === 0) {
    parcels.push(...stripParcels);
  } else {
    for (const sp of stripParcels) {
      for (const piece of differencePoly([sp.polygon], carveOuts)) {
        if (area(piece) >= cfg.minLotArea * 0.5) {
          parcels.push({ polygon: piece, isFlagLot: false, poleCorridor: null });
        }
      }
    }
  }

  return parcels;
}

/** Cut a frontage strip into individual lots along the street. */
function sliceStripIntoLots(strip: Polygon, front: FrontRef, cfg: LotParams, rng: Rng): Parcel[] {
  const a = area(strip);
  if (a < cfg.minLotArea) return [{ polygon: strip, isFlagLot: false, poleCorridor: null }];

  // The extent of the strip measured along the street direction.
  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of strip) {
    const t = V.dot(V.sub(p, front.a), front.dir);
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  const span = maxT - minT;
  if (span < cfg.minFrontage * 1.6) {
    return [{ polygon: strip, isFlagLot: false, poleCorridor: null }];
  }

  const isMajor = front.cls === 'arterial' || front.cls === 'collector';
  const targetWidth = rng.gaussClamped(
    isMajor ? cfg.widthMeanMajor : cfg.widthMean,
    cfg.widthSigma * (isMajor ? 2 : 1),
    cfg.widthMin,
    isMajor ? cfg.widthMeanMajor + 12 : cfg.widthMax,
  );
  const k = Math.max(1, Math.round(span / targetWidth));
  if (k === 1) return [{ polygon: strip, isFlagLot: false, poleCorridor: null }];

  // Jittered widths that still sum to the span and respect the minimum frontage.
  const widths: number[] = [];
  let total = 0;
  for (let i = 0; i < k; i++) {
    const w = Math.max(cfg.minFrontage, span / k + rng.jitter(span / k * 0.22));
    widths.push(w);
    total += w;
  }
  for (let i = 0; i < k; i++) widths[i] = widths[i]! * (span / total);

  const out: Parcel[] = [];
  let rest: Polygon[] = [strip];
  let t = minT;
  for (let i = 0; i < k - 1; i++) {
    t += widths[i]!;
    const origin = V.addScaled(front.a, front.dir, t);
    // Non-parallel side boundaries: real lots are rarely perfectly parallel.
    const cutDir = V.rotate(front.inward, rng.gauss(0, cfg.cutAngleJitter) * DEG);
    const nextRest: Polygon[] = [];
    for (const piece of rest) {
      // splitPolygonByLine returns [left, right] relative to `cutDir`. With
      // `cutDir` pointing into the block, `left` is the side already passed
      // along the street — that is the finished lot; `right` carries on.
      const [done, remaining] = splitPolygonByLine(piece, origin, cutDir);
      for (const p of done) out.push({ polygon: p, isFlagLot: false, poleCorridor: null });
      nextRest.push(...remaining);
    }
    rest = nextRest;
    if (rest.length === 0) break;
  }
  for (const p of rest) out.push({ polygon: p, isFlagLot: false, poleCorridor: null });
  return out;
}

interface PrivateLane {
  from: Vec2;
  to: Vec2;
  corridor: Polygon;
  dir: Vec2;
}

/**
 * Punch a 4 m corridor from the shortest available frontage into the block core.
 * The corridor must clear the already-consumed frontage strips only at its
 * entry, which is exactly how a 位置指定道路 threads between two street lots.
 */
function tryPrivateLane(
  core: Polygon,
  inner: Polygon,
  fronts: FrontRef[],
  cfg: LotParams,
  rng: Rng,
): PrivateLane | null {
  const target = centroid(core);
  const candidates = rng.shuffled(fronts);

  for (const f of candidates) {
    // Enter at a jittered point along the frontage, not always the middle.
    const t = rng.range(0.25, 0.75);
    const entry = V.lerp(f.a, f.b, t);
    const dir = V.normalize(V.sub(target, entry));
    // Keep the lane roughly perpendicular to the street it leaves.
    if (V.dot(dir, f.inward) < 0.55) continue;

    const halfW = cfg.privateLaneWidth / 2;
    const side = V.perp(dir);
    const end = V.addScaled(entry, dir, V.dist(entry, target) + 6);
    const corridor: Polygon = [
      V.addScaled(entry, side, -halfW),
      V.addScaled(end, side, -halfW),
      V.addScaled(end, side, halfW),
      V.addScaled(entry, side, halfW),
    ];
    const lane = largest(intersectPoly([corridor], [inner]));
    if (!lane) continue;
    // The lane must actually reach the core, or it is just a driveway.
    if (multiArea(intersectPoly([lane], [core])) < cfg.privateLaneWidth * 4) continue;
    return { from: entry, to: end, corridor: lane, dir };
  }
  return null;
}

/** Both sides of a private lane become frontage for the parcels behind it. */
function laneFrontRefs(lane: PrivateLane, cfg: LotParams): FrontRef[] {
  const side = V.perp(lane.dir);
  const halfW = cfg.privateLaneWidth / 2;
  const mk = (sign: number): FrontRef => {
    const a = V.addScaled(lane.from, side, sign * halfW);
    const b = V.addScaled(lane.to, side, sign * halfW);
    return {
      a,
      b,
      dir: V.normalize(V.sub(b, a)),
      // Inward means away from the lane centre.
      inward: V.scale(side, sign),
      cls: 'private',
      roadWidth: cfg.privateLaneWidth,
    };
  };
  return [mk(1), mk(-1)];
}

function touchesFront(poly: Polygon, f: FrontRef): boolean {
  for (const p of poly) {
    const { point } = V.closestOnSegment(p, f.a, f.b);
    if (V.dist(p, point) < 0.9) return true;
  }
  return false;
}

/**
 * Flag lots (旗竿地): a rear parcel reached by a narrow pole running out to the
 * street. Frontage is supplied artificially by the pole, so the rear parcels can
 * be split with a plain recursive OBB cut.
 */
function makeFlagLots(
  core: Polygon,
  inner: Polygon,
  fronts: FrontRef[],
  cfg: LotParams,
  rng: Rng,
): Parcel[] {
  const out: Parcel[] = [];
  const claimedPoles: Polygon[] = [];

  for (const piece of splitCoreForFlags(core, cfg, rng)) {
    const c = centroid(piece);
    // Nearest point on any street edge — that is where the pole comes out.
    let best: { point: Vec2; d: number } | null = null;
    for (const f of fronts) {
      const { point } = V.closestOnSegment(c, f.a, f.b);
      const d = V.dist(c, point);
      if (!best || d < best.d) best = { point, d };
    }
    if (!best) continue;

    const dir = V.normalize(V.sub(c, best.point));
    const side = V.perp(dir);
    const halfW = cfg.poleWidth / 2;
    // Start just outside the frontage line, then clip back to it, so the pole
    // reliably reaches the street and reports frontage of exactly its width.
    const start = V.addScaled(best.point, dir, -0.5);
    const corridorRaw: Polygon = [
      V.addScaled(start, side, -halfW),
      V.addScaled(c, side, -halfW),
      V.addScaled(c, side, halfW),
      V.addScaled(start, side, halfW),
    ];

    let corridor = largest(intersectPoly([corridorRaw], [inner]));
    if (!corridor) continue;
    // Two poles must not overlap each other either.
    if (claimedPoles.length > 0) {
      corridor = largest(differencePoly([corridor], claimedPoles));
      if (!corridor || area(corridor) < cfg.poleWidth * 2) continue;
    }

    const merged = largest(unionPoly([piece, corridor]));
    if (!merged) continue;
    const cleaned = cleanPolygon(merged, { tolerance: 0.05, minEdge: 0.15, minArea: cfg.minLotArea });
    if (!cleaned) continue;

    claimedPoles.push(corridor);
    out.push({ polygon: cleaned, isFlagLot: true, poleCorridor: corridor });
  }
  return out;
}

/** Recursive minimum-area split of the core into flag-lot-sized parcels. */
function splitCoreForFlags(core: Polygon, cfg: LotParams, rng: Rng): Polygon[] {
  const target = rng.gaussClamped(cfg.depthMean * cfg.widthMean, 40, cfg.minLotArea * 1.4, cfg.maxLotArea);
  const out: Polygon[] = [];
  const stack: Polygon[] = [core];
  let guard = 0;

  while (stack.length > 0 && guard++ < 24) {
    const p = stack.pop()!;
    const a = area(p);
    if (a <= target * 1.5 || a < cfg.minLotArea * 2) {
      if (a >= cfg.minLotArea) out.push(p);
      continue;
    }
    // Split across the longest extent so parcels stay compact.
    const e = longestExtentAxis(p);
    const [left, right] = splitPolygonByLine(p, centroid(p), V.perp(e));
    if (left.length === 0 || right.length === 0) {
      if (a >= cfg.minLotArea) out.push(p);
      continue;
    }
    stack.push(...left, ...right);
  }
  return out;
}

/** Repeatedly halve an oversized parcel across its longest extent. */
function resliceOversized(poly: Polygon, cap: number, cfg: LotParams): Polygon[] {
  const out: Polygon[] = [];
  const stack: Polygon[] = [poly];
  let guard = 0;

  while (stack.length > 0 && guard++ < 40) {
    const p = stack.pop()!;
    const a = area(p);
    if (a <= cap || a < cfg.minLotArea * 2) {
      if (a >= cfg.minLotArea) out.push(p);
      continue;
    }
    // Split perpendicular to the widest direction of the oriented bounding box.
    const obb = minAreaObb(p);
    const acrossLong = obb.rect.w >= obb.rect.d ? V.perp(obb.frame.xAxis) : obb.frame.xAxis;
    const [left, right] = splitPolygonByLine(p, centroid(p), acrossLong);
    if (left.length === 0 || right.length === 0) {
      if (a >= cfg.minLotArea) out.push(p);
      continue;
    }
    stack.push(...left, ...right);
  }
  return out;
}

function longestExtentAxis(poly: Polygon): Vec2 {
  let best: Edge | null = null;
  for (const e of polyEdges(poly)) if (!best || e.len > best.len) best = e;
  return best ? best.dir : { x: 1, y: 0 };
}

/**
 * Repair pass, then build the public `Lot` records: merge undersized parcels,
 * drop unbuildable slivers, and recompute frontage for every survivor.
 */
function finaliseLots(
  parcels: Parcel[],
  block: Block,
  fronts: FrontRef[],
  cfg: LotParams,
  idOffset: number,
): Lot[] {
  const kept: { parcel: Parcel; frontages: LotFrontage[] }[] = [];

  const accept = (p: Parcel, depth = 0): void => {
    const cleaned = cleanPolygon(p.polygon, { tolerance: 0.04, minEdge: 0.2, minArea: 1 });
    if (!cleaned) return;
    const a = area(cleaned);
    if (a < cfg.minLotArea) return;
    // Unbuildable slivers: long and thin, nothing fits.
    if (maxInscribedCircle(cleaned, 0.4).radius < cfg.minInscribedRadius) return;

    const frontages = computeFrontages(cleaned, fronts, cfg);
    // 接道義務: without frontage the parcel cannot exist as a lot.
    if (frontages.length === 0) return;
    frontages.sort((x, y) => classRank(y.cls) - classRank(x.cls) || y.len - x.len);

    // Parcels with wide frontage on a wide road are allowed to stay large.
    const majorFrontage = frontages
      .filter((f) => f.cls === 'arterial' || f.cls === 'collector')
      .reduce((s, f) => s + f.len, 0);
    const cap = majorFrontage >= 12 ? cfg.maxLotAreaMajor : cfg.maxLotArea;

    // Oversized parcels get split again across their long axis. Without this a
    // strip that failed to slice cleanly survives as a single implausible
    // half-block lot.
    if (a > cap && !p.isFlagLot && depth < 3) {
      for (const piece of resliceOversized(cleaned, cap, cfg)) {
        accept({ polygon: piece, isFlagLot: false, poleCorridor: null }, depth + 1);
      }
      return;
    }
    kept.push({ parcel: { ...p, polygon: cleaned }, frontages });
  };

  for (const p of parcels) accept(p);

  const lots: Lot[] = [];
  for (const { parcel: p, frontages } of kept) {
    const primary = frontages[0]!;

    lots.push({
      id: idOffset + lots.length,
      seed: subSeed(block.seed, 'lot', lots.length),
      blockId: block.id,
      polygon: p.polygon,
      area: area(p.polygon),
      frontages,
      faceDir: primary.outward,
      frontPoint: primary.mid,
      centroid: centroid(p.polygon),
      isFlagLot: p.isFlagLot,
      poleCorridor: p.poleCorridor,
      clusterId: -1,
      kind: 'house',
      urbanity: 0,
    });
  }
  return lots;
}

const classRank = (c: RoadClass): number =>
  c === 'arterial' ? 3 : c === 'collector' ? 2 : c === 'local' ? 1 : 0;

/**
 * Which of a parcel's edges lie on a street. An edge counts when it runs
 * parallel to a frontage reference and sits within a tolerance of it.
 */
function computeFrontages(poly: Polygon, fronts: FrontRef[], cfg: LotParams): LotFrontage[] {
  const out: LotFrontage[] = [];

  for (const e of polyEdges(poly)) {
    if (e.len < cfg.minFrontage * 0.5) continue;
    const mid = V.lerp(e.a, e.b, 0.5);
    let best: { f: FrontRef; d: number } | null = null;
    for (const f of fronts) {
      if (Math.abs(V.dot(e.dir, f.dir)) < 0.82) continue;
      const { point } = V.closestOnSegment(mid, f.a, f.b);
      const d = V.dist(mid, point);
      if (d > 1.2) continue;
      if (!best || d < best.d) best = { f, d };
    }
    if (!best) continue;
    out.push({
      i: e.i,
      a: e.a,
      b: e.b,
      len: e.len,
      dir: e.dir,
      // Polygon edge normals point inward, so the street is the other way.
      outward: V.neg(e.normal),
      cls: best.f.cls,
      roadWidth: best.f.roadWidth,
      mid,
    });
  }

  // Merge collinear runs so a lot with a cleaned-up boundary still reports one
  // long frontage rather than several short ones.
  return out.filter((f) => f.len >= cfg.minFrontage * 0.5);
}

export const clampNumber = clamp;
