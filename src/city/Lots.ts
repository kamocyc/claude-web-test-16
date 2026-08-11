import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type CityParams, type LotParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import {
  area,
  centroid,
  edges as polyEdges,
  isSimple,
  maxInscribedCircle,
  type Edge,
} from '../geom/polygon.js';
import { clipHalfPlane, splitPolygonByLine, type HalfPlane } from '../geom/halfplane.js';
import { minAreaObb } from '../geom/obb.js';
import { differencePoly, intersectPoly, largest, multiArea, unionPoly } from '../geom/boolean.js';
import { cleanPolygon } from '../geom/simplify.js';
import type { Block } from './Blocks.js';
import type { RoadClass, RoadNetwork } from './Roads.js';
import type { VacancyReason } from '../building/types.js';
import { laneClears } from './RoadClearance.js';

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
  /**
   * The road edge this frontage belongs to, or null for a private lane. Two
   * lots sharing this id are on the same stretch of the same street, which is
   * the only way anything downstream can tell that they should line up.
   */
  roadEdgeId: number | null;
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
  /**
   * What the lot is used for. Mutated to 'vacant' by the mesh builder when no
   * building could be fitted, so `zonedKind` keeps what the zoning decided.
   */
  kind: LotKind;
  /** The use zoning assigned, before any failure to build on it. */
  zonedKind: LotKind;
  /** Why the lot is empty, when it is. Null on a lot that carries a building. */
  vacancyReason: VacancyReason | null;
  urbanity: number;
}

interface Parcel {
  polygon: Polygon;
  isFlagLot: boolean;
  poleCorridor: Polygon | null;
  /**
   * Frontage references *in addition to* the block's street references.
   * Parcels behind a private lane front the lane, not the street; validating
   * them against street refs alone discarded every one of them — the lane was
   * dug, registered and paved while the lots it existed to serve were thrown
   * away. The block refs still apply too, which is what gives a corner lot its
   * second frontage.
   */
  fronts: FrontRef[];
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
  roadEdgeId: number | null;
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
  // Subtract each road's actual footprint rather than clipping by a half-plane.
  //
  // A half-plane is infinite, and a block bounded by a *curved* road has ten or
  // more short edges along that curve. On the concave side each of those planes
  // slices right across the block, and their intersection collapses far more
  // than the road's own width — eleven blocks, some of them 2,000–4,000 m²,
  // were being emptied outright and left as bare ground.
  //
  // Subtracting strips is also what makes the lots agree with the road surface
  // drawn in `props/Ground.ts`, since both are now the same rectangle.
  const fronts: FrontRef[] = [];
  const roadStrips: Polygon[] = [];

  for (const e of block.edges) {
    if (e.cls === null) continue;
    const inset = e.roadWidth / 2 + cfg.gutterWidth;
    // Overshoot the ends so strips meet cleanly at block corners.
    const a = V.addScaled(e.a, e.dir, -inset);
    const b = V.addScaled(e.b, e.dir, inset);
    roadStrips.push([
      V.addScaled(a, e.normal, -inset),
      V.addScaled(b, e.normal, -inset),
      V.addScaled(b, e.normal, inset),
      V.addScaled(a, e.normal, inset),
    ]);
    fronts.push({
      a: V.addScaled(e.a, e.normal, inset),
      b: V.addScaled(e.b, e.normal, inset),
      dir: e.dir,
      inward: e.normal,
      cls: e.cls,
      roadWidth: e.roadWidth,
      roadEdgeId: e.roadEdgeId,
    });
  }

  // Dead-end streets inside the block. They are drawn like any other street, so
  // their right of way has to come off the block like any other street's — and
  // then both sides of them front lots, which is the whole point of a
  // 行き止まり: the houses along it are why it was built.
  for (const r of block.interiorRoads) {
    const half = r.width / 2 + cfg.gutterWidth;
    const dir = V.normalize(V.sub(r.b, r.a));
    const side = V.perp(dir);
    // Extended at the open end only. The closed end stops where the asphalt
    // does; running past it would take land off lots the street never reaches.
    const a = V.addScaled(r.a, dir, -half);
    const b = V.addScaled(r.b, dir, half);
    roadStrips.push([
      V.addScaled(a, side, -half),
      V.addScaled(b, side, -half),
      V.addScaled(b, side, half),
      V.addScaled(a, side, half),
    ]);
    for (const sign of [1, -1]) {
      fronts.push({
        a: V.addScaled(r.a, side, sign * half),
        b: V.addScaled(r.b, side, sign * half),
        dir,
        // Inward means away from the street, into the land behind it.
        inward: V.scale(side, sign),
        cls: r.cls,
        roadWidth: r.width,
        roadEdgeId: r.roadEdgeId,
      });
    }
  }

  if (fronts.length === 0) return [];

  // Every part, not just the largest. Taking a street's right of way out of a
  // block can leave two pieces — an interior dead end makes a C, and a lane cut
  // across a corner makes a wedge — and keeping only the bigger one threw the
  // other away as bare ground.
  const parcels: Parcel[] = [];
  for (const inner of differencePoly([block.polygon], roadStrips)) {
    if (area(inner) < cfg.minLotArea) continue;
    // Only the frontages this piece actually touches; a reference on the far
    // side of the street would have the piece set back for a road it does not
    // reach, and then sliced perpendicular to a street it cannot see.
    const own = fronts.filter((f) => touchesFront(inner, f));
    if (own.length === 0) continue;
    parcels.push(...subdivideInterior(inner, own, cfg, rng, net, 0));
  }
  return finaliseLots(parcels, block, fronts, cfg, idOffset, net);
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
    const candidate = tryPrivateLane(core, inner, ordered, cfg, rng);
    // `inner` only has the *bounding* roads subtracted from it. A dead-end
    // street is pruned from the face walk, so it lies inside the block with
    // nothing to mark it, and a corridor driven toward the core can run
    // straight along it. Nothing here can move the road, so drop the lane and
    // let the core become 旗竿地 instead.
    const lane =
      candidate && laneClears(net, candidate.from, candidate.to, cfg.privateLaneWidth, 2)
        ? candidate
        : null;
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
          parcels.push({ ...sp, polygon: piece });
        }
      }
    }
  }

  return parcels;
}

/** Cut a frontage strip into individual lots along the street. */
function sliceStripIntoLots(strip: Polygon, front: FrontRef, cfg: LotParams, rng: Rng): Parcel[] {
  const a = area(strip);
  const tag = (polygon: Polygon): Parcel => ({
    polygon,
    isFlagLot: false,
    poleCorridor: null,
    fronts: [front],
  });
  if (a < cfg.minLotArea) return [tag(strip)];

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
    return [tag(strip)];
  }

  const isMajor = front.cls === 'arterial' || front.cls === 'collector';
  const targetWidth = rng.gaussClamped(
    isMajor ? cfg.widthMeanMajor : cfg.widthMean,
    cfg.widthSigma * (isMajor ? 2 : 1),
    cfg.widthMin,
    isMajor ? cfg.widthMeanMajor + 12 : cfg.widthMax,
  );
  const k = Math.max(1, Math.round(span / targetWidth));
  if (k === 1) return [tag(strip)];

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
      for (const p of done) out.push(tag(p));
      nextRest.push(...remaining);
    }
    rest = nextRest;
    if (rest.length === 0) break;
  }
  for (const p of rest) out.push(tag(p));
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

    // Report the endpoints of the *clipped* corridor. `end` deliberately
    // overshoots the core centroid by 6 m so the corridor is sure to reach it,
    // and the corridor polygon is then clipped to the block — but the endpoints
    // were being reported unclipped, so the rendered road ran that far past the
    // land it had actually taken.
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const p of lane) {
      const t = V.dot(V.sub(p, entry), dir);
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    return {
      from: V.addScaled(entry, dir, tMin),
      to: V.addScaled(entry, dir, tMax),
      corridor: lane,
      dir,
    };
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
      // A lane is not in the road graph, so it has no edge to point at. Both of
      // its sides still share this one reference, which is what keeps the two
      // facing rows of houses parallel to each other.
      roadEdgeId: null,
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
    out.push({ polygon: cleaned, isFlagLot: true, poleCorridor: corridor, fronts });
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
/**
 * Take back any road surface a parcel has ended up covering.
 *
 * Every stage upstream is *supposed* to keep lots off the asphalt — the block
 * boundary is set back, interior dead ends have their own right of way removed,
 * lanes are trimmed. Each of those is a separate mechanism with its own way of
 * failing quietly: an unattributed block edge gets no setback at all, a
 * `mergeCollinear` merge applies one road's width along another's, and
 * `differencePoly` returns its subject unchanged when the clipper throws, which
 * hands back a block with no right of way taken off it whatsoever.
 *
 * A lot containing public road is wrong however it got there, so it is checked
 * once, here, against the same rectangles the renderer actually draws rather
 * than against what the subdivider intended. A correctly-placed lot is already
 * a gutter's width clear of the kerb and loses nothing.
 */
function clipToRoads(poly: Polygon, net: RoadNetwork, cfg: LotParams): Polygon | null {
  let box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of poly) {
    box = {
      minX: Math.min(box.minX, p.x),
      minY: Math.min(box.minY, p.y),
      maxX: Math.max(box.maxX, p.x),
      maxY: Math.max(box.maxY, p.y),
    };
  }

  const strips: Polygon[] = [];
  const add = (a: Vec2, b: Vec2, width: number) => {
    // A hair narrower than the right of way the parcel was set back by, so a
    // correctly-placed boundary and the strip beside it are not exactly
    // collinear. Coincident edges are what polygon clippers are worst at: on
    // the axis-aligned grid layout every lot line lay exactly on a strip edge,
    // the clipper threw, and the retry across all four quanta turned a one
    // second subdivision into thirteen.
    const half = width / 2 + cfg.gutterWidth - 0.02;
    if (
      Math.max(a.x, b.x) + half < box.minX ||
      Math.min(a.x, b.x) - half > box.maxX ||
      Math.max(a.y, b.y) + half < box.minY ||
      Math.min(a.y, b.y) - half > box.maxY
    ) {
      return;
    }
    // Nothing to subtract unless the road actually reaches this parcel. Bounding
    // boxes are far too generous for a diagonal road, and every strip kept here
    // costs a boolean.
    const near =
      poly.some((q) => V.distToSegment(q, a, b) < half) ||
      polyEdges(poly).some((e) => V.segmentDistance(e.a, e.b, a, b) < half);
    if (!near) return;
    const d = V.sub(b, a);
    const l = V.len(d);
    if (l < 0.2) return;
    const dir = V.scale(d, 1 / l);
    const n = V.perp(dir);
    // Cover the junction overshoot the renderer adds, so a lot cannot be left
    // holding the corner of asphalt that spills past a node.
    const a2 = V.addScaled(a, dir, -half);
    const b2 = V.addScaled(b, dir, half);
    strips.push([
      V.addScaled(a2, n, -half),
      V.addScaled(b2, n, -half),
      V.addScaled(b2, n, half),
      V.addScaled(a2, n, half),
    ]);
  };

  for (const e of net.edges) add(net.graph.node(e.a).p, net.graph.node(e.b).p, e.width);
  for (const lane of net.privateLanes) add(lane.a, lane.b, lane.width);
  if (strips.length === 0) return poly;

  const before = area(poly);
  const clipped = largest(differencePoly([poly], strips));
  // Losing nearly everything means the parcel *was* the road — land the
  // subdivider had no business handing out. Nothing is salvageable, so refuse
  // it outright rather than keep the original and build a house in the
  // carriageway. (A failed `differencePoly` looks nothing like this: it returns
  // the subject unchanged, so the area is undiminished.)
  if (!clipped || area(clipped) < before * 0.05) return null;
  return clipped;
}

function finaliseLots(
  parcels: Parcel[],
  block: Block,
  blockFronts: FrontRef[],
  cfg: LotParams,
  idOffset: number,
  net: RoadNetwork,
): Lot[] {
  const kept: { parcel: Parcel; frontages: LotFrontage[] }[] = [];

  const accept = (p: Parcel, depth = 0): void => {
    const onLand = clipToRoads(p.polygon, net, cfg);
    if (!onLand) return;
    const cleaned = cleanPolygon(onLand, { tolerance: 0.04, minEdge: 0.2, minArea: 1 });
    if (!cleaned) return;

    // Subtracting two road strips that meet at a block corner can pinch the
    // remainder into a ring that touches itself. A union decomposes it into
    // separate simple components; handing a figure-eight downstream produces a
    // building with self-crossing walls.
    if (!isSimple(cleaned)) {
      if (depth >= 3) return;
      for (const piece of unionPoly([cleaned])) {
        if (isSimple(piece)) accept({ ...p, polygon: piece }, depth + 1);
      }
      return;
    }

    const a = area(cleaned);
    if (a < cfg.minLotArea) return;
    // Unbuildable slivers: long and thin, nothing fits.
    if (maxInscribedCircle(cleaned, 0.4).radius < cfg.minInscribedRadius) return;

    // The block's street refs plus whatever the parcel itself fronts (a private
    // lane, typically) — see the note on `Parcel.fronts`.
    const frontages = computeFrontages(cleaned, [...blockFronts, ...p.fronts], cfg);
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
        accept({ ...p, polygon: piece }, depth + 1);
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
      zonedKind: 'house',
      vacancyReason: null,
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
    if (e.len < cfg.minFrontage) continue;
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
    // Take the direction from the *street*, not from this lot's own edge.
    //
    // The two differ by a fraction of a degree — the lot boundary has been
    // through cleaning, simplification and a boolean or two since it was cut
    // off the block — but that fraction is what decides which way the house
    // points, and it differs for every lot on the street. Reading it off the
    // shared reference instead makes every house on one street segment face
    // exactly the same way, which is what a row of them looks like in life.
    const streetward = V.neg(best.f.inward);
    // The reference is shared by both sides of a lane, so orient it by this
    // lot's own outward normal rather than trusting its stored sign.
    const outward = V.dot(V.neg(e.normal), streetward) < 0 ? V.neg(streetward) : streetward;
    const dir = V.dot(e.dir, V.perp(outward)) < 0 ? V.neg(V.perp(outward)) : V.perp(outward);
    out.push({
      i: e.i,
      a: e.a,
      b: e.b,
      len: e.len,
      dir,
      outward,
      cls: best.f.cls,
      roadWidth: best.f.roadWidth,
      roadEdgeId: best.f.roadEdgeId,
      mid,
    });
  }

  // Merge collinear runs so a lot with a cleaned-up boundary still reports one
  // long frontage rather than several short ones.
  return out.filter((f) => f.len >= cfg.minFrontage);
}

export const clampNumber = clamp;
