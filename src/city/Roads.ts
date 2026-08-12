import type { Vec2 } from '../core/types.js';
import type { LandUseParams, RoadClass, RoadParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { makePlanar, PlanarGraph, splitEdgesAtNodes } from '../geom/planarGraph.js';
import { generateSkeleton } from './RoadSkeleton.js';
import { partitionDistricts, type District } from './RoadDistricts.js';
import { assignLandUse } from './LandUse.js';
import { districtStreets } from './RoadGrid.js';
import { enforceClearance, pruneShortStubs, readEdges } from './RoadClearance.js';

export type { RoadClass } from '../core/params.js';

/**
 * Road network generation: a hierarchy, not three families drawn on top of each
 * other.
 *
 * Tier-1 — arterials, collectors and the odd diagonal — is laid down first as
 * long, mostly straight polylines, and it *partitions* the town. The bounded
 * faces of that graph are districts, and each district then lays its own
 * orthogonal grid in its own frame, inheriting its direction from the main road
 * it fronts. That is the actual structure of a Japanese suburb: a patchwork of
 * 区画整理 districts, each internally square, meeting its neighbours at an angle
 * only along the roads between them.
 *
 * The alternative — one grid warped by a noise field — cannot produce it. A
 * warp gentle enough to preserve right angles is invisible, and one strong
 * enough to be visible bends every street and fans out every row of houses.
 *
 * Two invariants are enforced rather than hoped for, because nothing
 * downstream can repair a breach of either:
 *
 * - **Clearance.** Two roads that do not meet keep their ribbons apart. This
 *   used to be measured nowhere at all, which is why a 13 m arterial could run
 *   3.5 m from a parallel street with 7 m of asphalt in common.
 * - **Junction angle.** Roads meet squarely enough that their ribbons and the
 *   block corner between them are real geometry rather than slivers.
 */

export interface RoadEdgeData {
  cls: RoadClass;
  width: number;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  width: number;
}

export interface RoadNetwork {
  graph: PlanarGraph;
  edges: RoadEdge[];
  edgeById: Map<number, RoadEdge>;
  station: Vec2;
  extent: number;
  /** Tier-2 grid districts. Used by the debug overlay and the tests. */
  districts: District[];
  /** Private lanes created during lot subdivision; rendered, and provide frontage. */
  privateLanes: { a: Vec2; b: Vec2; width: number }[];
}

export function roadWidth(cls: RoadClass, p: RoadParams): number {
  switch (cls) {
    case 'arterial':
      return p.arterialWidth;
    case 'collector':
      return p.collectorWidth;
    case 'local':
      return p.localWidth;
    case 'private':
      return 4;
  }
}

export function generateRoads(seed: string, p: RoadParams, landUse: LandUseParams): RoadNetwork {
  const E = p.extent;

  // --- 1. Tier-1, and the districts it cuts the town into ------------------
  const skeleton = generateSkeleton(seed, p);
  const { graph: tier1, districts } = partitionDistricts(seed, skeleton, p);

  // --- 1b. 用途地域 --------------------------------------------------------
  // Land use is settled here, in the middle of road generation, rather than
  // downstream with the rest of the zoning. It has to be: an industrial
  // district lays a coarser street grid than a residential one, and the grid is
  // laid in the next step. This is the one place a downstream concept reaches
  // back upstream, and it is not avoidable — a 45 m grid cannot hold a factory
  // parcel no matter what the lot parameters say.
  assignLandUse(districts, skeleton.station, E, seed, landUse);

  // --- 2. Tier-2: each district's own grid ---------------------------------
  const raw = new PlanarGraph(p.nodeSnap);
  for (const e of tier1.edges) {
    raw.addSegment(tier1.node(e.a).p, tier1.node(e.b).p, e.data);
  }
  for (const d of districts) {
    for (const line of districtStreets(d, p, landUse)) {
      for (let i = 0; i + 1 < line.pts.length; i++) {
        raw.addSegment(line.pts[i]!, line.pts[i + 1]!, {
          cls: line.cls,
          width: roadWidth(line.cls, p),
        } satisfies RoadEdgeData);
      }
    }
  }

  // --- 3. Planarise, clean -------------------------------------------------
  const planar = makePlanar(raw, p.nodeSnap);

  // Splitting produces short fragments — including the deliberate stubs left
  // where a street overshot its boundary road to force a junction. Drop the
  // local ones, which would otherwise become slivers of block boundary.
  const trimmed = new PlanarGraph(p.nodeSnap);
  for (const e of planar.edges) {
    const data = e.data as RoadEdgeData | undefined;
    const cls = data?.cls ?? 'local';
    const a = planar.node(e.a).p;
    const b = planar.node(e.b).p;
    if (cls === 'local' && V.dist(a, b) < 6) continue;
    // The stubs left outside the town by the deliberate overshoots — Tier-1
    // past the perimeter, local streets past their district boundary — have
    // done their job of forcing a real crossing at the junction.
    const mid = V.lerp(a, b, 0.5);
    if (Math.abs(mid.x) > E + 0.01 || Math.abs(mid.y) > E + 0.01) continue;
    trimmed.addSegment(a, b, { cls, width: roadWidth(cls, p) } satisfies RoadEdgeData);
  }

  // Rebuilding snaps nodes together again, which can reintroduce a crossing
  // that the first pass had resolved. Planarise once more so face extraction
  // gets a genuinely planar graph — a single stray crossing produces
  // overlapping "blocks" and the failure is visually baffling.
  // Then connect the T-junctions. A street that stops exactly on the road it
  // meets is invisible to `makePlanar`, and an unsplit T is not a cosmetic
  // problem: the street is pruned as a dead end and the districts either side
  // of the road it failed to join merge into one.
  let graph = pruneShortStubs(
    splitEdgesAtNodes(makePlanar(trimmed, p.nodeSnap * 0.4), p.nodeSnap * 0.4),
    p,
  );
  let edges = readEdges(graph, p);

  // --- 4. Clearance: the safety net ---------------------------------------
  // The layout rules above should leave almost nothing to do here. What they
  // cannot foresee is where two districts' grids happen to meet across a
  // boundary road, or where the planariser's snapping has pulled two streets
  // together, so the pass runs regardless and the tests assert its result.
  const net: RoadNetwork = {
    graph,
    edges,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    station: skeleton.station,
    extent: E,
    districts,
    privateLanes: [],
  };
  const cleared = enforceClearance(net, p);
  graph = cleared.graph;
  edges = readEdges(graph, p);

  net.graph = graph;
  net.edges = edges;
  net.edgeById = new Map(edges.map((e) => [e.id, e]));
  return net;
}

/** Sample points along every road of a class, for distance fields. */
export function roadSamples(net: RoadNetwork, cls: RoadClass, spacing = 12): Vec2[] {
  const out: Vec2[] = [];
  for (const e of net.edges) {
    if (e.cls !== cls) continue;
    const a = net.graph.node(e.a).p;
    const b = net.graph.node(e.b).p;
    const n = Math.max(1, Math.round(V.dist(a, b) / spacing));
    for (let i = 0; i <= n; i++) out.push(V.lerp(a, b, i / n));
  }
  return out;
}

export const roadEndpoints = (net: RoadNetwork, e: RoadEdge): [Vec2, Vec2] => [
  net.graph.node(e.a).p,
  net.graph.node(e.b).p,
];
