import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import {
  area,
  centroid,
  clipSegmentToPolygon,
  edges as polyEdges,
  isSimple,
} from '../geom/polygon.js';
import { cleanPolygon } from '../geom/simplify.js';
import { unionPoly } from '../geom/boolean.js';
import { extractFaces, findSpurs } from '../geom/planarGraph.js';
import { minAreaObb } from '../geom/obb.js';
import { clipHalfPlane, splitPolygonByLine } from '../geom/halfplane.js';
import type { RoadClass, RoadNetwork } from './Roads.js';

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

export interface Block {
  id: number;
  seed: string;
  polygon: Polygon;
  edges: BlockEdge[];
  area: number;
  centroid: Vec2;
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
  maxArea: number;
  /** How close a block edge must be to a road edge to be attributed to it. */
  attributionTolerance: number;
}

export const DEFAULT_BLOCK_OPTIONS: BlockOptions = {
  minArea: 200,
  maxArea: 5200,
  attributionTolerance: 0.6,
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

  for (const face of faces) {
    // A face walk can legitimately revisit an articulation node, producing a
    // ring that touches itself. Running it through a union decomposes those
    // into separate simple components instead of handing a figure-eight to the
    // subdivider.
    for (const part of unionPoly([face.polygon], { tolerance: 0.05, minEdge: 0.3, minArea: 1 })) {
      const cleaned = cleanPolygon(part, { tolerance: 0.05, minEdge: 0.3, minArea: 1 });
      if (!cleaned || !isSimple(cleaned)) continue;
      if (area(cleaned) < opts.minArea) {
        rejected.push(cleaned);
        continue;
      }

      // An oversized block would otherwise be dropped, leaving a conspicuous
      // hole in the town. Run a street through it instead — which is what
      // actually happens when a large parcel is developed.
      const split = splitOversized(cleaned, net, opts);
      for (const piece of split.pieces) {
        const a = area(piece);
        if (a < opts.minArea) {
          rejected.push(piece);
          continue;
        }
        const id = blocks.length;
        blocks.push({
          id,
          seed: `${seed}/block/${id}`,
          polygon: piece,
          // Only this block's own lanes may supply frontage. Scanning every lane
          // in the network let a neighbouring block's lane manufacture phantom
          // frontage, and the lot subdivider then set the edge back 3 m for a
          // road that was not there.
          edges: attributeEdges(piece, net, split.lanes, opts.attributionTolerance),
          area: a,
          centroid: centroid(piece),
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
  opts: BlockOptions,
): { pieces: Polygon[]; lanes: RoadNetwork['privateLanes'] } {
  const out: Polygon[] = [];
  const lanes: RoadNetwork['privateLanes'] = [];
  const queue: Polygon[] = [poly];
  let guard = 0;

  while (queue.length > 0 && guard++ < 32) {
    const p = queue.shift()!;
    if (area(p) <= opts.maxArea) {
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
    const lane = clipSegmentToPolygon(
      p,
      V.addScaled(c, cutDir, -spanAlongCut),
      V.addScaled(c, cutDir, spanAlongCut),
    );
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

    out.push({
      a: e.a,
      b: e.b,
      i: e.i,
      len: e.len,
      dir: e.dir,
      normal: e.normal,
      roadEdgeId: bestId,
      cls: bestCls,
      roadWidth: bestWidth,
    });
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
