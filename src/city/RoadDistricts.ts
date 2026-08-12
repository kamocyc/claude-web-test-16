import type { Polygon, Vec2 } from '../core/types.js';
import { DEG, type RoadClass, type RoadParams, type UseZone } from '../core/params.js';
import { makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { area, centroid, isSimple, edges as polyEdges } from '../geom/polygon.js';
import { cleanPolygon } from '../geom/simplify.js';
import { unionPoly } from '../geom/boolean.js';
import { extractFaces, findSpurs, makePlanar, PlanarGraph } from '../geom/planarGraph.js';
import type { RoadEdgeData } from './Roads.js';
import { roadWidth } from './Roads.js';
import type { Skeleton } from './RoadSkeleton.js';

/**
 * Districts: the faces of the Tier-1 graph.
 *
 * A Japanese suburb is not one street grid, it is a patchwork of 区画整理
 * districts. Each is internally square and regular; neighbours meet at an angle
 * only along the arterial between them. That is what gives the aerial view its
 * character — locally tidy, globally irregular — and it is what a single
 * globally-warped lattice can never produce, because a warp that is gentle
 * enough to keep right angles is too gentle to be visible.
 *
 * So the town's irregularity lives *here*, in how districts are oriented, and
 * the grid inside each one is left alone.
 */

export interface DistrictBoundary {
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  /** Points into the district. */
  inward: Vec2;
  cls: RoadClass;
  width: number;
  gen: number;
}

export interface District {
  id: number;
  seed: string;
  polygon: Polygon;
  /** Grid direction, radians. */
  axis: number;
  boundary: DistrictBoundary[];
  area: number;
  /**
   * The growth step that closed this face — how old the district is.
   *
   * Read as the *maximum* over the boundary: a face does not exist until its
   * last side has been built, and the last side is the newest one. It decides
   * how finely the district grids itself, which is the largest single lever on
   * the town's density gradient.
   */
  generation: number;
  /**
   * 用途地域. Set to `lowRise` at construction and overwritten by
   * `city/LandUse.ts` before the Tier-2 grids are laid — the industrial zone
   * coarsens its own street grid, so the zone has to exist before the streets do.
   */
  zone: UseZone;
}

/**
 * How old a face is: the newest road that closed it.
 *
 * The maximum, because a face does not exist until its last side is built. The
 * perimeter ring is excluded — it carries `UNGROWN` and was never a growth
 * event, so counting it dated every edge-of-town district as the newest in the
 * place and gave it the coarsest grid regardless of what had happened inside.
 */
function faceGeneration(boundary: DistrictBoundary[]): number {
  let best = 0;
  let sawGrown = false;
  for (const e of boundary) {
    if (e.gen < 0) continue;
    sawGrown = true;
    if (e.gen > best) best = e.gen;
  }
  return sawGrown ? best : 0;
}

/** Relative say a road has in setting the axis of the district beside it. */
const AXIS_WEIGHT: Record<RoadClass, number> = {
  arterial: 2.0,
  collector: 1.4,
  local: 1.0,
  private: 0.6,
};

/**
 * The dominant direction of a district's boundary, mod 90°.
 *
 * Averaging angles directly is meaningless (0° and 179° average to 90°), and
 * the OBB is no good either — it follows the two extreme vertices, so one
 * clipped corner can swing it. Summing `len · e^{4iθ}` over the boundary and
 * taking a quarter of the resulting argument is the circular mean over
 * directions that are equivalent mod 90°, which is exactly the symmetry a grid
 * has: weighted by how much boundary actually runs each way.
 */
function dominantAxis(boundary: DistrictBoundary[]): number {
  let sx = 0;
  let sy = 0;
  for (const e of boundary) {
    const len = V.dist(e.a, e.b);
    const w = len * AXIS_WEIGHT[e.cls];
    const t = V.angleOf(e.dir) * 4;
    sx += w * Math.cos(t);
    sy += w * Math.sin(t);
  }
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) return 0;
  return Math.atan2(sy, sx) / 4;
}

/**
 * Match a face's polygon edges back to the Tier-1 roads that produced them.
 *
 * Cleaning merges and shortens edges, so the index alignment with
 * `face.edgeIds` does not survive it. Matching by midpoint proximity plus
 * direction agreement does, and it is the same approach `Blocks.attributeEdges`
 * takes for the same reason.
 */
function attributeBoundary(
  poly: Polygon,
  graph: PlanarGraph,
  p: RoadParams,
  tol: number,
): DistrictBoundary[] {
  const out: DistrictBoundary[] = [];
  for (const e of polyEdges(poly)) {
    const mid = V.lerp(e.a, e.b, 0.5);
    let cls: RoadClass = 'local';
    let width = p.localWidth;
    let gen = 0;
    let bestScore = Infinity;

    for (const ge of graph.edges) {
      const ga = graph.node(ge.a).p;
      const gb = graph.node(ge.b).p;
      const d = V.distToSegment(mid, ga, gb);
      if (d > tol) continue;
      const align = Math.abs(V.dot(V.normalize(V.sub(gb, ga)), e.dir));
      if (align < 0.7) continue;
      const score = d - align;
      if (score >= bestScore) continue;
      bestScore = score;
      const data = ge.data as RoadEdgeData | undefined;
      cls = data?.cls ?? 'local';
      width = data?.width ?? roadWidth(cls, p);
      gen = data?.gen ?? 0;
    }

    out.push({
      a: e.a,
      b: e.b,
      dir: e.dir,
      inward: e.normal,
      cls,
      width,
      gen,
    });
  }
  return out;
}

/**
 * Build the Tier-1 graph and cut the town into districts along it.
 *
 * Returns the graph too: the district grids are added to it, and the boundary
 * classes are read back out of its edge payloads.
 */
export function partitionDistricts(
  seed: string,
  skeleton: Skeleton,
  p: RoadParams,
): { graph: PlanarGraph; districts: District[] } {
  const raw = new PlanarGraph(p.nodeSnap);
  for (const line of skeleton.lines) {
    const data = { cls: line.cls, width: roadWidth(line.cls, p), gen: line.gen } satisfies RoadEdgeData;
    for (let i = 0; i + 1 < line.pts.length; i++) {
      raw.addSegment(line.pts[i]!, line.pts[i + 1]!, data);
    }
  }
  const graph = makePlanar(raw, p.nodeSnap);
  const faces = extractFaces(graph, findSpurs(graph).edgeIds);

  const districts: District[] = [];
  for (const face of faces) {
    // A face walk can revisit an articulation node and come back a ring that
    // touches itself; the union decomposes those into separate simple parts.
    for (const part of unionPoly([face.polygon], { tolerance: 0.05, minEdge: 0.3, minArea: 1 })) {
      const poly = cleanPolygon(part, { tolerance: 0.05, minEdge: 0.3, minArea: 1 });
      if (!poly || !isSimple(poly)) continue;
      const a = area(poly);
      if (a < 1) continue;

      const boundary = attributeBoundary(poly, graph, p, Math.max(1.0, p.nodeSnap * 0.5));
      const id = districts.length;
      const rng = makeRng(subSeed(seed, 'roads', 'district', id));
      districts.push({
        id,
        seed: subSeed(seed, 'district', id),
        polygon: poly,
        // A 区画整理 district is laid out to its main road but rarely exactly
        // square to it — the jitter is what stops neighbouring districts that
        // share an arterial from reading as one continuous grid.
        axis: dominantAxis(boundary) + rng.jitter(p.districtAxisJitter * DEG),
        boundary,
        area: a,
        generation: faceGeneration(boundary),
        zone: 'lowRise',
      });
    }
  }

  return { graph, districts };
}

/**
 * Which district a block belongs to.
 *
 * Blocks are faces of a graph that *contains* every Tier-1 edge, so a block
 * lies wholly inside one district by construction and its centroid decides the
 * answer. The nearest-centroid fallback is for numerics only: cleaning and the
 * boolean decomposition can move a centroid a few centimetres, and on a block
 * hugging a district boundary that is enough to land outside every polygon.
 * Returning null there would put a residential zone on an industrial block.
 */
export function districtContaining(districts: District[], p: Vec2): District | null {
  const hit = districtAt(districts, p);
  if (hit) return hit;

  let best: District | null = null;
  let bestD = Infinity;
  for (const d of districts) {
    const c = centroid(d.polygon);
    const dist = V.dist(c, p);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/** Which district contains this point, or null. Linear; used by tests and debug. */
export function districtAt(districts: District[], p: Vec2): District | null {
  for (const d of districts) {
    // Cheap reject on the centroid distance would need a radius; the district
    // count is in the tens, so a straight containment scan is fine.
    if (pointInPolygon(d.polygon, p)) return d;
  }
  return null;
}

function pointInPolygon(poly: Polygon, p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Total area covered by the districts — should be the whole town square. */
export const districtCoverage = (districts: District[]): number =>
  districts.reduce((s, d) => s + d.area, 0);

export const districtCentroid = (d: District): Vec2 => centroid(d.polygon);
