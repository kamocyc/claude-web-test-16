import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import {
  area,
  centroid,
  clipSegmentToPolygon,
  contains,
  edges as polyEdges,
  isSimple,
} from '../geom/polygon.js';
import { cleanPolygon } from '../geom/simplify.js';
import { differencePoly, unionPoly } from '../geom/boolean.js';
import { extractFaces, findSpurs } from '../geom/planarGraph.js';
import { minAreaObb } from '../geom/obb.js';
import { clipHalfPlane, splitPolygonByLine } from '../geom/halfplane.js';
import type { UseZone } from '../core/params.js';
import type { ObstacleField } from '../terrain/Obstacles.js';
import type { RoadClass, RoadNetwork } from './Roads.js';
import { districtContaining } from './RoadDistricts.js';
import { trimLaneEnds } from './RoadClearance.js';

/**
 * Block extraction: bounded faces of the road graph become city blocks, and each
 * block edge is tagged with the road that produced it.
 */

export interface BlockEdge {
  a: Vec2;
  b: Vec2;
  /** Index of `a` in the block polygon. */
  i: number;
  len: number;
  dir: Vec2;
  /** Points into the block interior. */
  normal: Vec2;
  roadEdgeId: number | null;
  cls: RoadClass | null;
  roadWidth: number;
}

/**
 * A road running through the *inside* of a block rather than along its edge.
 *
 * Dead-end streets are pruned before the face walk — a degree-1 chain would be
 * walked out and back and inject a zero-area spike into the face — so a block
 * containing one has no boundary edge for it, and used to have no knowledge of
 * it whatsoever. It was still drawn by the renderer, so the subdivider laid
 * lots straight over the asphalt and put houses on them.
 *
 * Carrying them here means the same block that gets the road's right of way
 * taken off it also gets to sell frontage on it, which is what a 行き止まり
 * street is for.
 */
export interface InteriorRoad {
  a: Vec2;
  b: Vec2;
  cls: RoadClass;
  width: number;
  roadEdgeId: number;
}

export interface Block {
  id: number;
  seed: string;
  polygon: Polygon;
  edges: BlockEdge[];
  /** Dead-end streets lying inside this block. */
  interiorRoads: InteriorRoad[];
  area: number;
  centroid: Vec2;
  /** The Tier-1 face this block sits in, or -1 if there are no districts. */
  districtId: number;
  /** 用途地域, inherited from that district. Decides how the block subdivides. */
  zone: UseZone;
  /** Growth step the district was enclosed at. 0 in a town built all at once. */
  generation: number;
}

export interface BlockExtraction {
  blocks: Block[];
  /** Edge ids on dead-end chains — rendered, but excluded from the face walk. */
  spurEdgeIds: Set<number>;
  /** Blocks rejected as too small, kept for debug display. */
  rejected: Polygon[];
}

export interface BlockOptions {
  minArea: number;
  /**
   * Per-zone override of `maxArea`.
   *
   * Coarsening the industrial street grid is not enough on its own: the splitter
   * runs a new street through anything over `maxArea`, so a 12,000 m² face laid
   * out at 95 m spacing came straight back out as three 4,000 m² ones and the
   * factory parcels with them. The two limits have to agree about how big an
   * industrial block is allowed to be.
   */
  maxAreaByZone?: Partial<Record<UseZone, number>>;
  maxArea: number;
  /** How close a block edge must be to a road edge to be attributed to it. */
  attributionTolerance: number;
  /** Gap a lane cut through an oversized block must keep from the roads around it. */
  laneClearance: number;
  /** Water and scarps to carve out of the blocks. Absent on flat ground. */
  obstacles?: ObstacleField;
}

export const DEFAULT_BLOCK_OPTIONS: BlockOptions = {
  minArea: 200,
  maxArea: 5200,
  maxAreaByZone: { industrial: 16000, quasiIndust: 8000 },
  attributionTolerance: 0.6,
  laneClearance: 2,
};

export function extractBlocks(
  net: RoadNetwork,
  seed: string,
  opts: BlockOptions = DEFAULT_BLOCK_OPTIONS,
): BlockExtraction {
  // Dead-end chains would be walked out and back, injecting zero-area spikes
  // into the face polygons which then wreck the offsetter downstream.
  const spurs = findSpurs(net.graph);
  const faces = extractFaces(net.graph, spurs.edgeIds);

  const blocks: Block[] = [];
  const rejected: Polygon[] = [];

  /**
   * Take the river out of a block before anything is subdivided on it.
   *
   * A block that spans the water is not one block, it is two with a river
   * between them, and handing the undivided face to `Lots` gives a row of houses
   * standing in the channel. The pre-reject on the bounding box matters: this is
   * a polygon boolean per block and only the handful along the river need one.
   *
   * A bend of the river that closes *inside* a single block is a hole, and
   * `geom/boolean.ts` drops holes — hence the second line of defence in
   * `Lots.finaliseLots`, which refuses any parcel whose centroid is in the water.
   */
  const carveWater = (parts: Polygon[], obstacles: BlockOptions['obstacles']): Polygon[] => {
    const banks = obstacles?.banks;
    if (!obstacles || !banks || banks.length === 0) return parts;
    const out: Polygon[] = [];
    for (const part of parts) {
      // Reject on the real distance to the water, not on bounding boxes. The
      // river's bounding box is a band across the whole town, so a box test says
      // "maybe" for most of the blocks in it — every one of those then paid for
      // a polygon boolean, and the ones where polygon-clipping came back empty
      // were deleted outright. That put square holes in the middle of the town,
      // nowhere near any water.
      const c = centroid(part);
      let radius = 0;
      for (const q of part) radius = Math.max(radius, V.dist(q, c));
      if (obstacles.terrain.waterDistance(c) > radius + 1) {
        out.push(part);
        continue;
      }
      const cut = differencePoly([part], banks as Polygon[]);
      // Failing open: an empty result here means the boolean gave up, not that
      // the block is entirely under water — `Lots.finaliseLots` still refuses
      // any parcel whose centroid is wet, so keeping it costs nothing.
      if (cut.length === 0) {
        if (obstacles.buildable(c)) out.push(part);
        continue;
      }
      out.push(...cut);
    }
    return out;
  };

  for (const face of faces) {
    // A face walk can legitimately revisit an articulation node, producing a
    // ring that touches itself. Running it through a union decomposes those
    // into separate simple components instead of handing a figure-eight to the
    // subdivider.
    for (const part of carveWater(
      unionPoly([face.polygon], { tolerance: 0.05, minEdge: 0.3, minArea: 1 }),
      opts.obstacles,
    )) {
      const cleaned = cleanPolygon(part, { tolerance: 0.05, minEdge: 0.3, minArea: 1 });
      if (!cleaned || !isSimple(cleaned)) continue;
      if (area(cleaned) < opts.minArea) {
        rejected.push(cleaned);
        continue;
      }

      // The district this face sits in decides two things, and the first of them
      // has to be settled *before* the face is cut up.
      //
      // Beyond the frontier there is no estate, so there is nothing to divide.
      // Checking after `splitOversized` is too late by then: an undeveloped face
      // is one enormous polygon, the splitter obligingly runs lane after lane
      // through it — thirty-two of them, up to its guard — and registers every
      // one on the road network, so a town stopped at step 8 came out with its
      // fields neatly gridded in 私道.
      const faceDistrict = districtContaining(net.districts, centroid(cleaned));
      if (faceDistrict && !faceDistrict.developed) continue;

      // And the size limit: an oversized block would otherwise be dropped,
      // leaving a conspicuous hole in the town, so a street is run through it
      // instead — which is what actually happens when a large parcel is
      // developed. A 工業団地 block is meant to be several times a residential one.
      const faceZone = faceDistrict?.zone ?? 'lowRise';
      const split = splitOversized(
        cleaned,
        net,
        opts.laneClearance,
        opts.maxAreaByZone?.[faceZone] ?? opts.maxArea,
      );
      for (const piece of split.pieces) {
        const a = area(piece);
        if (a < opts.minArea) {
          rejected.push(piece);
          continue;
        }
        const id = blocks.length;
        const c = centroid(piece);
        const district = districtContaining(net.districts, c);
        blocks.push({
          id,
          seed: `${seed}/block/${id}`,
          polygon: piece,
          // Only this block's own lanes may supply frontage. Scanning every lane
          // in the network let a neighbouring block's lane manufacture phantom
          // frontage, and the lot subdivider then set the edge back 3 m for a
          // road that was not there.
          edges: attributeEdges(piece, net, split.lanes, opts.attributionTolerance),
          interiorRoads: interiorRoadsOf(piece, net, spurs.edgeIds),
          area: a,
          centroid: c,
          districtId: district?.id ?? -1,
          zone: district?.zone ?? 'lowRise',
          generation: district?.generation ?? 0,
        });
      }
    }
  }

  return { blocks, spurEdgeIds: spurs.edgeIds, rejected };
}

/**
 * Recursively cut an oversized block with new local streets until every piece is
 * within the size limit. The cut lines are registered on the road network so the
 * new streets render and supply frontage to the lots behind them.
 */
function splitOversized(
  poly: Polygon,
  net: RoadNetwork,
  clearance: number,
  maxArea: number,
): { pieces: Polygon[]; lanes: RoadNetwork['privateLanes'] } {
  const out: Polygon[] = [];
  const lanes: RoadNetwork['privateLanes'] = [];
  const queue: Polygon[] = [poly];
  let guard = 0;

  while (queue.length > 0 && guard++ < 32) {
    const p = queue.shift()!;
    if (area(p) <= maxArea) {
      out.push(p);
      continue;
    }
    // Cut across the block's long axis, through its centroid.
    const obb = minAreaObb(p);
    const alongLong = obb.rect.w >= obb.rect.d ? obb.frame.xAxis : V.perp(obb.frame.xAxis);
    const cutDir = V.perp(alongLong);
    const c = centroid(p);
    const [left, right] = splitPolygonByLine(p, c, cutDir);
    if (left.length === 0 || right.length === 0) {
      out.push(p);
      continue;
    }

    // Register the new street so the lots either side of it have frontage.
    // The lane runs along `cutDir`, so its length is the block's extent along
    // `cutDir` — the *short* axis. Using max(w, d) here made the lane as long as
    // the block's long side and drove tens of metres of asphalt straight through
    // the neighbouring blocks.
    const spanAlongCut = Math.min(obb.rect.w, obb.rect.d);
    const cut = clipSegmentToPolygon(
      p,
      V.addScaled(c, cutDir, -spanAlongCut),
      V.addScaled(c, cutDir, spanAlongCut),
    );
    // The block face is bounded by road *centrelines*, so a lane clipped to it
    // ends half a carriageway inside the asphalt of the road it meets — up to
    // 6.5 m of it against an arterial. Pull both ends back off the roads they
    // run into; if nothing usable is left, split the block anyway and let the
    // halves do without the extra frontage.
    const lane = cut ? trimLaneEnds(net, cut[0], cut[1], 5, clearance) : null;
    if (lane) {
      const record = { a: lane[0], b: lane[1], width: 5 };
      net.privateLanes.push(record);
      lanes.push(record);
    }

    // Both halves lose the road's right of way.
    for (const side of [left, right]) {
      for (const piece of side) {
        const trimmed = clipHalfPlane(piece, {
          origin: V.addScaled(c, V.perp(cutDir), inwardSign(piece, c, cutDir) * 3),
          normal: V.scale(V.perp(cutDir), inwardSign(piece, c, cutDir)),
        });
        for (const t of trimmed) {
          const cleaned = cleanPolygon(t, { tolerance: 0.05, minEdge: 0.3, minArea: 1 });
          if (cleaned) queue.push(cleaned);
        }
      }
    }
  }
  return { pieces: out, lanes };
}

/** Which side of the cut line a piece lies on: +1 or -1. */
function inwardSign(piece: Polygon, origin: Vec2, cutDir: Vec2): number {
  const n = V.perp(cutDir);
  return V.dot(V.sub(centroid(piece), origin), n) >= 0 ? 1 : -1;
}

/**
 * Match each block edge to the road edge it came from.
 *
 * Cleanup merges and shortens block edges, so identity by node id is not
 * reliable. Matching by midpoint proximity plus direction agreement is, and it
 * degrades gracefully: an unmatched edge simply carries no frontage.
 */
function attributeEdges(
  poly: Polygon,
  net: RoadNetwork,
  ownLanes: RoadNetwork['privateLanes'],
  tol: number,
): BlockEdge[] {
  const out: BlockEdge[] = [];

  for (const e of polyEdges(poly)) {
    const mid = V.lerp(e.a, e.b, 0.5);
    let bestId: number | null = null;
    let bestCls: RoadClass | null = null;
    let bestWidth = 0;
    let bestDir: Vec2 | null = null;
    let bestScore = Infinity;

    for (const re of net.edges) {
      const ra = net.graph.node(re.a).p;
      const rb = net.graph.node(re.b).p;
      const d = V.distToSegment(mid, ra, rb);
      if (d > tol) continue;
      // Prefer a road running parallel to this block edge.
      const rdir = V.normalize(V.sub(rb, ra));
      const align = Math.abs(V.dot(rdir, e.dir));
      if (align < 0.7) continue;
      const score = d - align;
      if (score < bestScore) {
        bestScore = score;
        bestId = re.id;
        bestCls = re.cls;
        bestWidth = re.width;
        bestDir = rdir;
      }
    }

    // Streets punched through oversized blocks live in `privateLanes`, not in
    // the road graph, but they still front the lots beside them.
    if (bestCls === null) {
      for (const lane of ownLanes) {
        const d = V.distToSegment(mid, lane.a, lane.b);
        if (d > lane.width / 2 + tol) continue;
        const ldir = V.normalize(V.sub(lane.b, lane.a));
        if (Math.abs(V.dot(ldir, e.dir)) < 0.7) continue;
        bestCls = 'private';
        bestWidth = lane.width;
        break;
      }
    }

    // Where the edge came from a road, take its frame from the road rather than
    // from the polygon. Face extraction and cleanup shift a block edge by a
    // fraction of a degree, differently for each one, and that fraction
    // propagates all the way to which way the house points — so every lot on a
    // street ends up facing a slightly different way. Reading the direction off
    // the road makes a row of them exactly parallel.
    let dir = e.dir;
    let normal = e.normal;
    if (bestId !== null && bestDir) {
      dir = V.dot(bestDir, e.dir) < 0 ? V.neg(bestDir) : bestDir;
      const n = V.perp(dir);
      normal = V.dot(n, e.normal) < 0 ? V.neg(n) : n;
    }

    out.push({
      a: e.a,
      b: e.b,
      i: e.i,
      len: e.len,
      dir,
      normal,
      roadEdgeId: bestId,
      cls: bestCls,
      roadWidth: bestWidth,
    });
  }
  return out;
}

/**
 * The pruned dead-end streets that fall inside this block.
 *
 * Tested at the midpoint: a spur either runs into the block from its boundary
 * or lies wholly within it, and in both cases the midpoint is inside. Endpoints
 * are not usable — a spur's first node sits exactly on the block boundary,
 * where `contains` is a coin toss.
 */
function interiorRoadsOf(poly: Polygon, net: RoadNetwork, spurIds: Set<number>): InteriorRoad[] {
  const out: InteriorRoad[] = [];
  for (const e of net.edges) {
    if (!spurIds.has(e.id)) continue;
    const a = net.graph.node(e.a).p;
    const b = net.graph.node(e.b).p;
    if (!contains(poly, V.lerp(a, b, 0.5))) continue;
    out.push({ a, b, cls: e.cls, width: e.width, roadEdgeId: e.id });
  }
  return out;
}

/** Block edges that face a road — the ones that can supply frontage. */
export const frontageEdges = (b: Block): BlockEdge[] => b.edges.filter((e) => e.cls !== null);

/** Total frontage length of a block on a given road class. */
export function frontageOn(b: Block, cls: RoadClass): number {
  let s = 0;
  for (const e of b.edges) if (e.cls === cls) s += e.len;
  return s;
}
