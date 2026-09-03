import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type CityParams, type LotParams, type UseZone } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import {
  area,
  centroid,
  clipSegmentToPolygonAll,
  edges as polyEdges,
  isSimple,
  maxInscribedCircle,
  type Edge,
} from '../geom/polygon.js';
import { clipHalfPlane, splitPolygonByLine, type HalfPlane } from '../geom/halfplane.js';
import { minAreaObb } from '../geom/obb.js';
import { differencePoly, intersectPoly, largest, multiArea, unionPoly } from '../geom/boolean.js';
import { cleanPolygon } from '../geom/simplify.js';
import type { ObstacleField } from '../terrain/Obstacles.js';
import { FLAT_PLATFORM, type LotPlatform } from './Platform.js';
import type { Block } from './Blocks.js';
import { zoneLotParams } from './LandUse.js';
import type { RoadClass, RoadNetwork } from './Roads.js';
import type { BuildingKind, VacancyReason } from '../building/types.js';
import { laneClears } from './RoadClearance.js';
import { rightOfWayHalfWidth, rightOfWayStrip } from './RoadSurface.js';
import { NO_LAND_LOSSES, type LandLossSink } from './LandLoss.js';

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

/** What a lot is used for: a building, or nothing. */
export type LotKind = BuildingKind | 'vacant';

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
  /**
   * 用途地域, inherited from the block's district. Named `useZone` rather than
   * `zone` because `zonedKind` already exists and means the opposite direction:
   * this is what the map permits, that is what was decided under it.
   */
  useZone: UseZone;
  /** Growth step of the district this lot sits in — how old the estate is. */
  generation: number;
  /**
   * The levelled platform this lot was cut into the slope, and the walls that
   * hold it up. Non-null and flat on level ground — see `city/Platform.ts`.
   */
  platform: LotPlatform;
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

/**
 * A row of lots under construction: the land, the street it fronts, and the
 * stretch of that street it can actually reach.
 *
 * The span is what bounds absorption. Without it a row will take land it cannot
 * serve, and the slices that fall outside its reach come out landlocked.
 */
interface Row {
  poly: Polygon;
  front: FrontRef;
  /** t-range along `front.dir`, or null when the strip touches no street. */
  span: { t0: number; t1: number } | null;
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

/** See `clipToRoads`: how far the safety-net strip is pulled in off a lot line. */
const COLLINEAR_SHRINK = 0.02;

/**
 * Where land this block discards is recorded, and which block to charge it to.
 *
 * Carried as one object rather than two arguments because it is threaded
 * through six functions that otherwise have nothing to say about it.
 */
interface LossCtx {
  losses: LandLossSink;
  blockId: number;
}

const NO_LOSSES: LossCtx = { losses: NO_LAND_LOSSES, blockId: -1 };

/**
 * How far a row of lots may run past each end of the street it fronts.
 *
 * `FrontRef.a` and `.b` are the block edge's endpoints pushed *inward* by the
 * right of way, so two references meeting at a corner leave a gap between them
 * proportional to how obtuse the corner is. This covers that gap and nothing
 * else: it is not a licence to run down the side of a block that has its own
 * street.
 */
const BAND_END_MARGIN = 2;

/**
 * How near a frontage line a strip has to come to count as touching it.
 *
 * A band starts half a metre behind its own frontage line and the cleaning that
 * follows moves a boundary by centimetres, so this only has to be bigger than
 * the slop. It is not the 接道義務 test — that is `computeFrontages`.
 */
const FRONT_TOUCH = 1.5;

/** How many times leftover land may be offered to a row before we stop asking. */
const ABSORB_GUARD = 24;

/**
 * The smallest piece of stranded land worth running a 竿 out to the street for.
 *
 * Under this a flag lot is mostly 竿: the 2.6 m corridor comes off the body,
 * the body fails `too-narrow` at the building stage, and an empty lot has been
 * traded for a recorded offcut. Anything smaller stays recorded and lost.
 */
const SALVAGE_MIN_AREA = 100;

export function subdivideBlock(
  block: Block,
  net: RoadNetwork,
  params: CityParams,
  idOffset: number,
  obstacles?: ObstacleField,
  losses: LandLossSink = NO_LAND_LOSSES,
): Lot[] {
  const loss: LossCtx = { losses, blockId: block.id };
  // The block's 用途地域 reaches subdivision here and nowhere else. A factory
  // parcel and a shophouse frontage are not reachable from one set of numbers
  // tuned for detached houses, and this single read is the whole seam.
  const cfg = zoneLotParams(params.lots, block.zone);
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
    const inset = rightOfWayHalfWidth(e.roadWidth, cfg.gutterWidth);
    // The same rectangle the renderer draws and `clipToRoads` checks against —
    // see `city/RoadSurface.ts`. It overshoots the ends so strips meet cleanly
    // at block corners.
    const strip = rightOfWayStrip(e.a, e.b, e.roadWidth, cfg.gutterWidth, 0, {
      dir: e.dir,
      normal: e.normal,
    });
    if (strip) roadStrips.push(strip);
    // Extended along the street by the same `inset` the strip overshoots by.
    //
    // The two are built from one number and used to disagree: the strip runs
    // `inset` past each end — that is what closes the corner where two of them
    // meet — while the reference stopped at the node. `computeFrontages`
    // measures to the reference as a *segment*, so a lot standing on land the
    // strip had already taken read as `inset` metres away from its own street
    // and was refused for want of frontage. A band 2.9 m wide on a local street
    // and 7 m on an arterial, at every block corner and every dead-end head.
    fronts.push({
      a: V.addScaled(V.addScaled(e.a, e.normal, inset), e.dir, -inset),
      b: V.addScaled(V.addScaled(e.b, e.normal, inset), e.dir, inset),
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
    const half = rightOfWayHalfWidth(r.width, cfg.gutterWidth);
    const dir = V.normalize(V.sub(r.b, r.a));
    const side = V.perp(dir);
    const strip = rightOfWayStrip(r.a, r.b, r.width, cfg.gutterWidth, 0, {
      dir,
      normal: side,
    });
    if (strip) roadStrips.push(strip);
    for (const sign of [1, -1]) {
      fronts.push({
        a: V.addScaled(V.addScaled(r.a, side, sign * half), dir, -half),
        b: V.addScaled(V.addScaled(r.b, side, sign * half), dir, half),
        dir,
        // Inward means away from the street, into the land behind it.
        inward: V.scale(side, sign),
        cls: r.cls,
        roadWidth: r.width,
        roadEdgeId: r.roadEdgeId,
      });
    }
  }

  // No street was attributed to any edge of this block, so nothing on it could
  // ever meet 接道義務. The whole face goes back on the books as lost.
  if (fronts.length === 0) {
    loss.losses.add('block-no-frontage', block.polygon, block.id);
    return [];
  }

  // Every part, not just the largest. Taking a street's right of way out of a
  // block can leave two pieces — an interior dead end makes a C, and a lane cut
  // across a corner makes a wedge — and keeping only the bigger one threw the
  // other away as bare ground.
  const parcels: Parcel[] = [];
  for (const inner of differencePoly([block.polygon], roadStrips)) {
    if (area(inner) < cfg.minLotArea) {
      loss.losses.add('offcut-too-small', inner, block.id);
      continue;
    }
    // Only the frontages this piece actually touches; a reference on the far
    // side of the street would have the piece set back for a road it does not
    // reach, and then sliced perpendicular to a street it cannot see.
    const own = fronts.filter((f) => touchesFront(inner, f));
    if (own.length === 0) {
      loss.losses.add('offcut-no-frontage', inner, block.id);
      continue;
    }
    parcels.push(...subdivideInterior(inner, own, cfg, rng, net, 0, loss));
  }
  return finaliseLots(parcels, block, fronts, cfg, idOffset, net, obstacles, loss);
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
  loss: LossCtx = NO_LOSSES,
): Parcel[] {
  const parcels: Parcel[] = [];

  // Widest road first, then longest edge. The order decides who gets the corners
  // and, now that depth is fitted to what is left, who gets the depth: the block
  // takes its grain from the biggest road on it, which is what lets a parcel on
  // an arterial be deep enough for a マンション while the local street behind it
  // still gets an ordinary row.
  const ordered = [...fronts].sort(
    (a, b) => classRank(b.cls) - classRank(a.cls) || V.dist(b.a, b.b) - V.dist(a.a, a.b),
  );
  const depthOf = new Map<FrontRef, number>();
  for (const f of ordered) depthOf.set(f, rowDepth(inner, f, cfg, rng));

  // The core is what remains once every frontage edge is pushed inward by its
  // own row depth. Offsetting *only* the frontage edges is exactly an
  // intersection of half-planes — no variable-width offsetter needed.
  let coreParts: Polygon[] = [inner];
  for (const f of ordered) {
    const hp: HalfPlane = { origin: V.addScaled(f.a, f.inward, depthOf.get(f)!), normal: f.inward };
    const next: Polygon[] = [];
    for (const p of coreParts) next.push(...clipHalfPlane(p, hp));
    coreParts = next;
    if (coreParts.length === 0) break;
  }
  const core = coreParts.length > 0 ? largest(coreParts) : null;
  const coreArea = core ? area(core) : 0;
  // Not always one piece: a bent block can leave the land behind its rows in
  // two. Only the largest drives the lane-or-flags decision; the rest go
  // straight to the street row like any other leftover.
  const strandedCore = core ? coreParts.filter((q) => q !== core) : [];

  // Strips: the part of `inner` within the row depth of each frontage edge, with
  // earlier strips subtracted so corners are not claimed twice.
  const strips: Row[] = [];
  // Kept as a plain list, deliberately *not* unioned: the union of frontage
  // strips around a deep block is an annulus, and this pipeline drops holes, so
  // unioning would silently hand back a solid disc and over-subtract every
  // later band.
  const consumed: Polygon[] = [];

  for (const f of ordered) {
    // A slab, bounded on *both* sides — no deeper than the row, and not behind
    // the frontage at all.
    //
    // The near side used to be left open, on the reasoning that there is nothing
    // behind a frontage but the road it fronts. That holds for a block edge and
    // fails completely for a dead-end street through the middle of a block: both
    // sides of it are frontage, and everything on the far side of it is at a
    // *negative* depth from this one. So one front's band swallowed the whole
    // other half of the block — 50 m of it — and then sliced it perpendicular to
    // its own street into 5 m ribbons 47 m long. Those were the town's worst
    // parcels by a distance, and every one of them came from here.
    // Half a metre behind the frontage line rather than exactly on it: the block
    // interior already starts there, so nothing is lost, and a clip plane lying
    // exactly along an existing boundary is what `polygon-clipping` is worst at.
    const front: HalfPlane = { origin: V.addScaled(f.a, f.inward, -0.5), normal: f.inward };
    const back: HalfPlane = {
      origin: V.addScaled(f.a, f.inward, depthOf.get(f)!),
      normal: V.neg(f.inward),
    };
    // And bounded along the street as well, which it was not.
    //
    // Both planes above are perpendicular to `f.inward`, so the band was
    // infinite in the street's own direction. On a bent or C-shaped block the
    // widest road is taken first and its slab swept clean across the face,
    // claiming land twenty metres past the end of its own carriageway — which
    // `computeFrontages` then measures against the reference as a *segment* and
    // refuses. The land was sliced perpendicular to a street it is off the end
    // of, and every slice died landlocked. A quarter of the town's frontageless
    // land was this.
    //
    // Worse than losing it: the band went into `consumed`, so the street round
    // the corner — whose land it actually is — could not have it either.
    const t0 = -BAND_END_MARGIN;
    const t1 = V.dist(f.a, f.b) + BAND_END_MARGIN;
    const startCap: HalfPlane = { origin: V.addScaled(f.a, f.dir, t0), normal: f.dir };
    const endCap: HalfPlane = { origin: V.addScaled(f.a, f.dir, t1), normal: V.neg(f.dir) };
    let band: Polygon[] = [];
    for (const p of clipHalfPlane(inner, front)) {
      for (const q of clipHalfPlane(p, back)) {
        for (const r of clipHalfPlane(q, startCap)) band.push(...clipHalfPlane(r, endCap));
      }
    }
    if (consumed.length > 0) band = differencePoly(band, consumed);
    for (const p of band) {
      if (area(p) >= cfg.minLotArea * 0.6) strips.push({ poly: p, front: f, span: frontageSpan(p, f) });
      else loss.losses.add('offcut-too-small', p, loss.blockId);
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
  // Drawn unconditionally and before the branch, for the reason `rowDepth`
  // gives: a draw made only on some blocks lets the shape of one block shift
  // the random stream for every block after it.
  const preferFlags = rng.chance(cfg.flagLotChance);

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
        if (area(piece) < cfg.minLotArea) {
          loss.losses.add('offcut-too-small', piece, loss.blockId);
          continue;
        }
        const usable = laneFronts.filter((lf) => touchesFront(piece, lf));
        if (usable.length === 0) {
          loss.losses.add('offcut-no-frontage', piece, loss.blockId);
          continue;
        }
        parcels.push(...subdivideInterior(piece, usable, cfg, rng, net, depth + 1, loss));
      }
    }
  }

  // A core too small for its own lane still gets flag lots: a leftover of one or
  // two lots' worth of land behind the street row is exactly where 旗竿地 come
  // from in real Japanese blocks.
  //
  // `flagLotChance` used to decide whether the core became 旗竿地 **or vanished**,
  // and it is 0.55, so on a middling block the land behind the houses had
  // slightly worse than even odds of simply not existing. `canRecurse` made it
  // worse: land behind a lane, behind a lane, was dropped every time. Neither
  // was a decision about the town — nothing chose to leave a 300 m² hole in the
  // middle of a block, it was the absence of a third branch.
  //
  // Now the chance decides 旗竿地 **or absorbed into the depth of the street
  // row**, which is the other thing that happens to leftover land in a real
  // block, and the depth limit goes with the lane it belongs to. That also
  // keeps `ZONE_LOTS.industrial`, which sets the chance to zero because a
  // 工業団地 is a grid of large parcels and not a warren: it now gets deeper
  // parcels rather than gaps.
  // Land that is in neither a band nor the core.
  //
  // The bands are now bounded four ways and the core still only three, so the
  // two no longer tile `inner` between them — the land past the end of a
  // street, which is the whole point of the change, falls between them. Taking
  // the difference explicitly is what keeps this function honest: whatever it
  // does not hand to a row or a pole, it hands back, and nothing leaves without
  // a name. One boolean per block interior.
  const claimed: Polygon[] = [...strips.map((r) => r.poly), ...coreParts];
  const leftovers: Polygon[] = [...strandedCore];
  for (const rest of differencePoly([inner], claimed)) leftovers.push(rest);
  if (core && !laneBuilt) {
    if (coreArea >= cfg.flagLotMinCore && preferFlags) {
      // `carveOuts` is handed in rather than collected afterwards: `placePole`
      // appends each corridor it places, which is what stops the next pole
      // crossing it — and what stops any of them crossing the block's 私道.
      const flags = makeFlagLots(core, inner, ordered, cfg, rng, carveOuts, loss);
      parcels.push(...flags.parcels);
      leftovers.push(...flags.leftovers);
    } else {
      leftovers.push(core);
    }
  }

  // The street row takes what it can reach. Done before slicing, so the deepened
  // strip is cut perpendicular to its own street like any other and every lot
  // that comes out of it still fronts one. What a row cannot reach comes back
  // and is offered to the next one.
  const pending = [...leftovers];
  const unclaimed: Polygon[] = [];
  let absorbGuard = 0;
  while (pending.length > 0 && absorbGuard++ < ABSORB_GUARD) {
    const raw = pending.pop()!;
    // Cleaned on the way in, wherever it came from.
    //
    // Every piece here is the difference of two polygons that were themselves
    // cut by half-planes, so it arrives with runs of two- and three-metre edges
    // tracing where one clip crossed another. A fourteen-vertex ring of those
    // is one no row will merge with and no 竿 can be squared up against, and it
    // ends up abandoned for reasons of arithmetic rather than of geography.
    const piece = cleanPolygon(raw, { tolerance: 0.3, minEdge: 1, minArea: cfg.minLotArea });
    if (!piece) {
      loss.losses.add('offcut-too-small', raw, loss.blockId);
      continue;
    }
    const { taken, rest } = absorbIntoRow(piece, strips);
    if (taken) pending.push(...rest);
    else unclaimed.push(piece);
  }
  unclaimed.push(...pending);

  // Last resort: land no row could reach becomes 旗竿地 rather than nothing.
  //
  // This is the branch that used not to exist. A row can only take land that
  // lies behind the stretch of street it actually fronts, so on a deep block
  // there is always some left over — and it was sliced up with the row anyway
  // and then refused, one parcel at a time, for want of the frontage nobody had
  // given it. A 竿 is what that land gets in a real Japanese block.
  //
  // Only above `SALVAGE_MIN_AREA`. Below it, running a 2.6 m 竿 out of a scrap
  // leaves a body too narrow to build on, and a `too-narrow` empty lot is not
  // an improvement on a recorded offcut.
  for (const piece of unclaimed) {
    if (area(piece) < SALVAGE_MIN_AREA) {
      loss.losses.add('stranded-too-small', piece, loss.blockId);
      continue;
    }
    const forced = forceFlagLots(piece, inner, ordered, cfg, carveOuts, loss);
    parcels.push(...forced);
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
        } else {
          loss.losses.add('offcut-too-small', piece, loss.blockId);
        }
      }
    }
  }

  return parcels;
}

/**
 * Share of a block's depth the row on the wide road takes.
 *
 * A parcel on an arterial is deeper as well as wider — that pair is the whole of
 * what makes a マンション site geometrically possible, without any zoning rule
 * ever naming one. An even split of a 33 m block leaves 16.5 m, and 21 m of
 * frontage by 16.5 m is 346 m² against the 400 a マンション needs.
 */
const MAJOR_DEPTH_SHARE = 0.62;

/** Sample rays cast into the block from each frontage. */
const REACH_SAMPLES = 5;

/**
 * How far the block goes back from this frontage.
 *
 * The median of a few rays cast inward, rather than the extreme: a block is a
 * face of a road graph, not a rectangle, and one clipped corner or one edge
 * meeting another at 60° makes the maximum reach half again the typical one.
 *
 * Only the run that starts *at* the frontage counts. A block with a dead-end
 * street through it is a C, and the land on the far side of that street belongs
 * to the row fronting the street, not to this one.
 */
function blockReach(inner: Polygon, f: FrontRef): number {
  const runs: number[] = [];
  for (let i = 0; i < REACH_SAMPLES; i++) {
    // Started a hair inside: the frontage line lies exactly on the boundary of
    // `inner`, where a clip is a coin toss.
    const q = V.addScaled(V.lerp(f.a, f.b, (i + 0.5) / REACH_SAMPLES), f.inward, 0.05);
    let best = 0;
    for (const [a, b] of clipSegmentToPolygonAll(inner, q, V.addScaled(q, f.inward, 400))) {
      const t0 = V.dot(V.sub(a, q), f.inward);
      const t1 = V.dot(V.sub(b, q), f.inward);
      if (Math.min(t0, t1) > 0.5) continue;
      best = Math.max(best, Math.max(t0, t1));
    }
    if (best > 0.5) runs.push(best + 0.05);
  }
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1]!;
}

/**
 * How deep the row of lots along this frontage should be.
 *
 * **Fitted to the block, not drawn independently of it.** The drawn depth is a
 * fallback for the one case where the block is genuinely deeper than two rows —
 * where a 私道 or a run of 旗竿地 into the middle is the honest answer. Everywhere
 * else the block is divided exactly: two rows meeting on a shared rear boundary,
 * or one row through a block too shallow for two.
 *
 * Drawing the depth first and living with the remainder is what produced the
 * town's long thin parcels. The block gave 34–60 m of usable depth against two
 * rows' 27, and the leftover had to go somewhere — so the lots stretched, the
 * median parcel came out 7.8 m × 20.8 m, and every house on one was shaped to
 * suit. `city/LotModule.ts` now sizes the streets so the fitted answer is close
 * to the drawn one; this is what makes sure it is *exact*.
 */
function rowDepth(inner: Polygon, f: FrontRef, cfg: LotParams, rng: Rng): number {
  const major = f.cls === 'arterial' || f.cls === 'collector';
  const cap = major ? cfg.depthMeanMajor + 8 : cfg.depthMax;
  // Drawn unconditionally and before the branch, so the shape of one block
  // cannot shift the random stream for everything after it.
  const drawn = rng.gaussClamped(
    major ? cfg.depthMeanMajor : cfg.depthMean,
    cfg.depthSigma,
    cfg.depthMin,
    cap,
  );

  const reach = blockReach(inner, f);
  if (reach <= 0) return drawn;
  // Too shallow for two rows: one row goes right through, backing onto the far
  // street. Better than two rows of 8 m, and better than half a block of nothing.
  if (reach < 2 * cfg.depthMin) return Math.min(reach, cap);
  if (reach > 2 * cap) return drawn;
  return Math.min(cap, reach * (major ? MAJOR_DEPTH_SHARE : 0.5));
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
  claimed: Polygon[],
  loss: LossCtx = NO_LOSSES,
): { parcels: Parcel[]; leftovers: Polygon[] } {
  const out: Parcel[] = [];
  const leftovers: Polygon[] = [];

  for (const piece of splitCoreForFlags(core, cfg, rng, loss)) {
    // A 竿 is a driveway, not a corridor across the block: past a row's depth
    // the land is better off widening the row it is behind, which is where it
    // goes when every front refuses. `minSquareness` matches `tryPrivateLane`,
    // which is the other thing that threads a corridor between two street lots.
    const parcel = placePole(piece, inner, fronts, cfg, {
      maxLength: cfg.depthMax,
      claimed,
      minSquareness: 0.55,
    });
    // No street would take a pole from this piece. It is still land, so it goes
    // back to the caller to be absorbed rather than being written off here.
    if (!parcel) leftovers.push(piece);
    else out.push(parcel);
  }
  return { parcels: out, leftovers };
}

/** What a 竿 is allowed to do on its way out to the street. */
interface PoleOpts {
  /** How far it may run. A chosen 旗竿地 keeps this short; a salvaged one cannot. */
  maxLength: number;
  /**
   * Every corridor already spoken for — other poles **and the block's 私道**.
   *
   * Mutated: a pole that is placed is appended. The claimed set used to be
   * local to one `makeFlagLots` call and knew nothing about the lane corridor
   * beside it, which is how two poles came to overlap.
   */
  claimed: Polygon[];
  /** Minimum |dot(dir, f.inward)|, so a 竿 leaves its street square-on. */
  minSquareness: number;
}

/**
 * Run a 竿 from `body` out to the nearest street that will take one.
 *
 * Every street in turn, nearest first, rather than the nearest only: a pole can
 * fail several ways — it clips to nothing, it lands on a corridor already
 * claimed, the union with its own flag comes apart — and giving up on the first
 * of those cost the whole rear parcel when the street round the corner would
 * have taken it.
 */
function placePole(
  body: Polygon,
  inner: Polygon,
  fronts: FrontRef[],
  cfg: LotParams,
  opts: PoleOpts,
): Parcel | null {
  const c = centroid(body);
  const byDistance = fronts
    .map((f) => {
      const { point } = V.closestOnSegment(c, f.a, f.b);
      return { f, point, d: V.dist(c, point) };
    })
    .sort((x, y) => x.d - y.d);

  for (const near of byDistance) {
    if (near.d > opts.maxLength) break;
    const dir = V.normalize(V.sub(c, near.point));
    // Square-on to the street it leaves. An oblique 竿 shears the street lot it
    // passes through lengthwise and leaves a wedge behind it.
    if (V.dot(dir, near.f.inward) < opts.minSquareness) continue;
    const side = V.perp(dir);
    const halfW = cfg.poleWidth / 2;
    // Start just outside the frontage line, then clip back to it, so the pole
    // reliably reaches the street and reports frontage of exactly its width.
    const start = V.addScaled(near.point, dir, -0.5);
    const corridorRaw: Polygon = [
      V.addScaled(start, side, -halfW),
      V.addScaled(c, side, -halfW),
      V.addScaled(c, side, halfW),
      V.addScaled(start, side, halfW),
    ];

    let corridor = largest(intersectPoly([corridorRaw], [inner]));
    if (!corridor) continue;
    // Two poles must not overlap each other either. What is left has to still
    // be a 竿 and not a smear of one: subtracting a claimed pole from a
    // crossing corridor leaves a 0.4 m ribbon running the whole way alongside
    // it, which passes an area test comfortably, cannot carry the 2 m of
    // frontage 接道義務 asks for, and unions with its own flag into a ring
    // that touches itself. Two of those were reported as overlapping lots.
    if (opts.claimed.length > 0) {
      corridor = largest(differencePoly([corridor], opts.claimed));
      if (!corridor || area(corridor) < cfg.poleWidth * 2) continue;
      if (maxInscribedCircle(corridor, 0.2).radius < cfg.poleWidth * 0.35) continue;
    }

    // One ring, or the pole and its flag are not joined. Subtracting a pole
    // already claimed can cut a corridor in two and leave the half that
    // reaches the street; `largest` then hands back that half alone, and what
    // is registered as a 旗竿地 is a bare 31 m × 2.6 m 竿 with no land on the
    // end of it. One of those was the whole of a finished town's unexplained
    // vacancy — a lot no house could stand on, which is exactly what a flag
    // lot with no flag is.
    const merged = unionPoly([body, corridor]);
    if (merged.length !== 1) continue;
    const cleaned = cleanPolygon(merged[0]!, {
      tolerance: 0.05,
      minEdge: 0.15,
      minArea: cfg.minLotArea,
    });
    // A flag and its pole meet along one edge, so their union is one simple
    // ring. Anything else means they met at a point, or not at all.
    if (!cleaned || !isSimple(cleaned)) continue;
    if (area(cleaned) < area(body) * 0.9) continue;

    opts.claimed.push(corridor);
    return { polygon: cleaned, isFlagLot: true, poleCorridor: corridor, fronts };
  }
  return null;
}

/**
 * 旗竿地 for land no street row could reach.
 *
 * The bodies are cut **along** the street they will front rather than across
 * the piece's own longest extent, so that parcels standing side by side each
 * send their 竿 down their own column and no pole has to tunnel through its
 * neighbour's plot to get out. It is `resliceOversized`'s lesson — cut across
 * the frontage, never parallel to it — applied one stage earlier, and it is
 * what makes forcing a pole safe rather than merely possible.
 *
 * Deliberately draws no random numbers. Everything here is geometry, so
 * salvaging a block cannot shift the stream for the blocks after it.
 */
function forceFlagLots(
  piece: Polygon,
  inner: Polygon,
  fronts: FrontRef[],
  cfg: LotParams,
  claimed: Polygon[],
  loss: LossCtx,
): Parcel[] {
  const c = centroid(piece);
  // The nearest street, preferring one the piece is actually in front of but
  // not insisting on it.
  //
  // Insisting was wrong in exactly one place, and it was the place this matters
  // most: inside a 私道's own recursion there are only two frontage references,
  // one for each side of the lane, and a piece sitting off the *end* of the
  // lane is in front of neither. Every one of those was written off — and they
  // are the land at the head of a cul-de-sac, which is a 旗竿地 if anywhere is.
  // This only picks which way the bodies are cut; `placePole` still decides,
  // street by street, whether a 竿 can actually be run.
  let target: FrontRef | null = null;
  let best = Infinity;
  for (const f of fronts) {
    const { point } = V.closestOnSegment(c, f.a, f.b);
    // A street the piece is behind is a last resort, so push it down the order
    // rather than out of it.
    const d = V.dist(c, point) + (V.dot(V.sub(c, f.a), f.inward) > 0 ? 0 : 1000);
    if (d < best) {
      best = d;
      target = f;
    }
  }
  if (!target) {
    loss.losses.add('core-abandoned', piece, loss.blockId);
    return [];
  }

  const out: Parcel[] = [];
  const streetward = V.neg(target.inward);
  for (const body of resliceOversized(piece, cfg.maxLotArea, cfg, loss, streetward)) {
    if (area(body) < cfg.flagLotMinCore) {
      loss.losses.add('stranded-too-small', body, loss.blockId);
      continue;
    }
    // Square-on first, obliquely if it must, and no length limit either way:
    // the alternative here is not a worse 竿, it is losing the land.
    //
    // The second pass is what reaches the land past the end of a street. The
    // nearest point on a frontage line is clamped to its ends, so a body that
    // overhangs one can only be served by a pole that leaves it at an angle —
    // and refusing that is refusing the only access the land has.
    const parcel =
      placePole(body, inner, fronts, cfg, {
        maxLength: Infinity,
        claimed,
        minSquareness: 0.85,
      }) ??
      placePole(body, inner, fronts, cfg, {
        maxLength: Infinity,
        claimed,
        minSquareness: 0.4,
      });
    if (parcel) out.push(parcel);
    else loss.losses.add('core-abandoned', body, loss.blockId);
  }
  return out;
}

/**
 * Give a piece of leftover core to the row of lots in front of it.
 *
 * The row is deepened and then sliced perpendicular to its own street exactly
 * as it would have been anyway, so every lot the deepened strip produces still
 * fronts a road — which is the whole reason this generator peels rings off a
 * block instead of splitting it recursively.
 *
 * It is refused rather than forced when the union is not a single simple ring,
 * or when its area is not the sum of its parts. Both mean the two pieces did
 * not actually share a boundary — `largest` would then quietly hand back the
 * strip alone and the core would be lost with the books still balancing.
 */
function absorbIntoRow(piece: Polygon, rows: Row[]): { taken: boolean; rest: Polygon[] } {
  const c = centroid(piece);
  const candidates = rows
    // The row has to be in front of the piece, not across the block from it.
    .filter((r) => r.span !== null && V.dot(V.sub(c, r.front.a), r.front.inward) > 0)
    .map((r) => ({ r, d: V.dist(c, centroid(r.poly)) }))
    .sort((x, y) => x.d - y.d);

  // Every row in turn, nearest first. The nearest by centroid is not always the
  // one the piece actually shares an edge with — a core behind an L of two rows
  // has its centroid nearest the one it only touches at a corner.
  for (const { r } of candidates) {
    const span = r.span!;
    // Only the part of the piece that lies behind the stretch of street this
    // row actually fronts.
    //
    // The union used to be judged on shape alone: one simple ring of the right
    // area. An L satisfies that trivially, and `sliceStripIntoLots` then
    // measures the *whole* L to decide where to cut — so every slice falling in
    // the arm that overhangs the row's own street came out with no street edge
    // at all. Three quarters of the town's frontageless land was made here, one
    // 200–400 m² parcel at a time, by an absorb that kept the land in name
    // only.
    //
    // No tolerance on the span. A lot's width of slack re-admits exactly one
    // such slice at each end of every absorbing row, which is the thing being
    // removed.
    const rest: Polygon[] = [];
    const inSpan: Polygon[] = [];
    const startCap: HalfPlane = {
      origin: V.addScaled(r.front.a, r.front.dir, span.t0),
      normal: r.front.dir,
    };
    const endCap: HalfPlane = {
      origin: V.addScaled(r.front.a, r.front.dir, span.t1),
      normal: V.neg(r.front.dir),
    };
    for (const p of clipHalfPlane(piece, startCap)) {
      for (const q of clipHalfPlane(p, endCap)) inSpan.push(q);
    }
    for (const q of differencePoly([piece], inSpan)) rest.push(q);
    if (inSpan.length === 0) continue;

    let poly = r.poly;
    let took = false;
    for (const part of inSpan) {
      const want = area(poly) + area(part);
      const merged = unionPoly([poly, part]);
      if (merged.length !== 1) {
        rest.push(part);
        continue;
      }
      const cleaned = cleanPolygon(merged[0]!, { tolerance: 0.05, minEdge: 0.15, minArea: 1 });
      if (!cleaned || !isSimple(cleaned)) {
        rest.push(part);
        continue;
      }
      if (Math.abs(area(cleaned) - want) > 0.5 + want * 0.002) {
        rest.push(part);
        continue;
      }
      poly = cleaned;
      took = true;
    }
    if (!took) continue;
    r.poly = poly;
    // The row's reach is a property of the street, not of how much land has
    // been piled behind it, so `span` is deliberately not recomputed. That is
    // also what stops a row taking the same piece twice and this loop running
    // for ever.
    return { taken: true, rest: rest.filter((q) => area(q) > 0.5) };
  }
  return { taken: false, rest: [] };
}

/**
 * The stretch of its own street a strip actually abuts.
 *
 * Measured on the part of the strip that comes within `FRONT_TOUCH` of the
 * frontage line, not on the whole polygon — a strip that has already been given
 * land behind it is longer than the street it fronts, and it is the street that
 * decides what else it may be given.
 */
function frontageSpan(poly: Polygon, front: FrontRef): { t0: number; t1: number } | null {
  const near: HalfPlane = {
    origin: V.addScaled(front.a, front.inward, FRONT_TOUCH),
    normal: V.neg(front.inward),
  };
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const part of clipHalfPlane(poly, near)) {
    for (const q of part) {
      const t = V.dot(V.sub(q, front.a), front.dir);
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
  }
  return t1 > t0 ? { t0, t1 } : null;
}

/**
 * How many splits each recursive splitter is allowed before it gives up.
 *
 * Named, and paired below with a record of whatever is still on the stack when
 * they run out. A bare `guard++ < 24` that trips drops every polygon left in
 * the queue, which is the one kind of lost land invisible even to a reason
 * code: nobody decided anything, the loop simply stopped.
 */
const FLAG_SPLIT_GUARD = 24;
const RESLICE_GUARD = 40;

/** Recursive minimum-area split of the core into flag-lot-sized parcels. */
function splitCoreForFlags(
  core: Polygon,
  cfg: LotParams,
  rng: Rng,
  loss: LossCtx = NO_LOSSES,
): Polygon[] {
  const target = rng.gaussClamped(cfg.depthMean * cfg.widthMean, 40, cfg.minLotArea * 1.4, cfg.maxLotArea);
  const out: Polygon[] = [];
  const stack: Polygon[] = [core];
  let guard = 0;

  while (stack.length > 0 && guard++ < FLAG_SPLIT_GUARD) {
    const p = stack.pop()!;
    const a = area(p);
    if (a <= target * 1.5 || a < cfg.minLotArea * 2) {
      if (a >= cfg.minLotArea) out.push(p);
      else loss.losses.add('offcut-too-small', p, loss.blockId);
      continue;
    }
    // Split across the longest extent so parcels stay compact.
    const e = longestExtentAxis(p);
    const [left, right] = splitPolygonByLine(p, centroid(p), V.perp(e));
    if (left.length === 0 || right.length === 0) {
      if (a >= cfg.minLotArea) out.push(p);
      else loss.losses.add('offcut-too-small', p, loss.blockId);
      continue;
    }
    stack.push(...left, ...right);
  }
  for (const p of stack) loss.losses.add('offcut-too-small', p, loss.blockId);
  return out;
}

/**
 * Repeatedly halve an oversized parcel until every piece is within the cap.
 *
 * Split **across the frontage** where the parcel has one: the cut line runs
 * from the street into the block, so every piece keeps a share of the street.
 * Splitting on the oriented bounding box instead — which is what this did, and
 * still does for a parcel with no frontage to preserve — cuts a *deep* parcel
 * parallel to its own street, and the rear half is then landlocked and dies in
 * `accept` for want of frontage with no more explanation than that. Deep
 * parcels are exactly what the block core is absorbed into, so this went from a
 * rare accident to the largest single kind of lost land in the town.
 */
function resliceOversized(
  poly: Polygon,
  cap: number,
  cfg: LotParams,
  loss: LossCtx = NO_LOSSES,
  outward?: Vec2,
): Polygon[] {
  const out: Polygon[] = [];
  const stack: Polygon[] = [poly];
  let guard = 0;

  while (stack.length > 0 && guard++ < RESLICE_GUARD) {
    const p = stack.pop()!;
    const a = area(p);
    if (a <= cap || a < cfg.minLotArea * 2) {
      if (a >= cfg.minLotArea) out.push(p);
      else loss.losses.add('offcut-too-small', p, loss.blockId);
      continue;
    }
    // Along the street's outward normal where there is one, so the cut runs from
    // the street into the block; otherwise perpendicular to the widest direction
    // of the oriented bounding box, which keeps the pieces compact.
    let cutDir = outward;
    if (!cutDir) {
      const obb = minAreaObb(p);
      cutDir = obb.rect.w >= obb.rect.d ? V.perp(obb.frame.xAxis) : obb.frame.xAxis;
    }
    const [left, right] = splitPolygonByLine(p, centroid(p), cutDir);
    if (left.length === 0 || right.length === 0) {
      if (a >= cfg.minLotArea) out.push(p);
      else loss.losses.add('offcut-too-small', p, loss.blockId);
      continue;
    }
    stack.push(...left, ...right);
  }
  for (const p of stack) loss.losses.add('offcut-too-small', p, loss.blockId);
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
    const half = rightOfWayHalfWidth(width, cfg.gutterWidth) - COLLINEAR_SHRINK;
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
    // The strip overshoots its own ends, which covers the junction overshoot
    // the renderer adds: a lot cannot be left holding the corner of asphalt
    // that spills past a node.
    const strip = rightOfWayStrip(a, b, width, cfg.gutterWidth, COLLINEAR_SHRINK);
    if (strip) strips.push(strip);
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
  obstacles: ObstacleField | undefined,
  loss: LossCtx = NO_LOSSES,
): Lot[] {
  const kept: { parcel: Parcel; frontages: LotFrontage[] }[] = [];
  const lost = (reason: Parameters<LandLossSink['add']>[0], poly: Polygon): void => {
    loss.losses.add(reason, poly, loss.blockId);
  };

  const accept = (p: Parcel, depth = 0): void => {
    const onLand = clipToRoads(p.polygon, net, cfg);
    if (!onLand) {
      lost('lot-on-road', p.polygon);
      return;
    }
    const cleaned = cleanPolygon(onLand, { tolerance: 0.04, minEdge: 0.2, minArea: 1 });
    if (!cleaned) {
      lost('lot-degenerate', onLand);
      return;
    }

    // Subtracting two road strips that meet at a block corner can pinch the
    // remainder into a ring that touches itself. A union decomposes it into
    // separate simple components; handing a figure-eight downstream produces a
    // building with self-crossing walls.
    if (!isSimple(cleaned)) {
      if (depth >= 3) {
        lost('lot-degenerate', cleaned);
        return;
      }
      for (const piece of unionPoly([cleaned])) {
        if (isSimple(piece)) accept({ ...p, polygon: piece }, depth + 1);
        else lost('lot-degenerate', piece);
      }
      return;
    }

    const a = area(cleaned);
    if (a < cfg.minLotArea) {
      lost('lot-too-small', cleaned);
      return;
    }
    // Unbuildable slivers: long and thin, nothing fits.
    if (maxInscribedCircle(cleaned, 0.4).radius < cfg.minInscribedRadius) {
      lost('lot-too-narrow', cleaned);
      return;
    }

    // Land the river or a scarp has already claimed. The blocks were carved
    // around the water upstream of here, but `geom/boolean.ts` drops holes, so a
    // bend of the river that closes inside a single block survives the carve
    // untouched. Without this gate that bend gets a row of houses in it, and the
    // failure is spectacular rather than subtle.
    if (obstacles && !obstacles.buildable(centroid(cleaned))) {
      // The river and the 段丘崖 are *areas*. Testing one point against them
      // decided the fate of the whole parcel on where its centroid happened to
      // land: a lot with a scarp clipping one corner was thrown away entire,
      // and a lot with a scarp through the middle was kept entire. Cut the bad
      // ground out and keep what is on good ground, which is what `Blocks`
      // already does with the water one stage earlier.
      //
      // Whatever survives goes back through this same door: it is re-clipped to
      // the roads, re-measured, and above all has its frontage recomputed, so a
      // remnant the scarp has cut off from the street is refused for the honest
      // reason rather than kept because its parent had frontage.
      const clipped =
        depth < 3 ? differencePoly([cleaned], obstacles.noBuildAreas as Polygon[]) : [cleaned];
      // Strictly smaller — which covers the parcel that is *entirely* on bad
      // ground, and rules out the case where there was nothing to cut and the
      // recursion would never end.
      if (multiArea(clipped) < a - 0.5) {
        // Booked against the whole parcel, before the survivors are re-offered.
        // `auditLand` subtracts the lots first and this reason last, so what it
        // is charged for is exactly the part that did not come back as land —
        // no extra boolean here to work out which part that was.
        lost('lot-unbuildable-ground', cleaned);
        for (const piece of clipped) {
          if (area(piece) >= cfg.minLotArea) accept({ ...p, polygon: piece }, depth + 1);
        }
        return;
      }
      // Nothing to cut, so it is the gradient. That has no edge to cut along,
      // so the question is how much of the parcel is too steep rather than
      // whether one point of it is.
      if (obstacles.buildableFraction(cleaned) < cfg.minBuildableFraction) {
        lost('lot-unbuildable-ground', cleaned);
        return;
      }
    }

    // The block's street refs plus whatever the parcel itself fronts (a private
    // lane, typically) — see the note on `Parcel.fronts`.
    const frontages = computeFrontages(cleaned, [...blockFronts, ...p.fronts], cfg);
    // 接道義務: without frontage the parcel cannot exist as a lot.
    if (frontages.length === 0) {
      lost('lot-no-frontage', cleaned);
      return;
    }
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
      for (const piece of resliceOversized(cleaned, cap, cfg, loss, frontages[0]!.outward)) {
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
      useZone: block.zone,
      generation: block.generation,
      platform: FLAT_PLATFORM,
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
