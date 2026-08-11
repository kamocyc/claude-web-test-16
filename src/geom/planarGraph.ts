import type { Polygon, Vec2 } from '../core/types.js';
import * as V from './vec2.js';
import { signedArea } from './polygon.js';

/**
 * Planar straight-line graph, and extraction of its bounded faces.
 *
 * Two things here are not optional and are the usual cause of a city that
 * "mostly works but some blocks are garbage":
 *
 * - **Planarity.** Two edges crossing without a shared node makes the face walk
 *   produce overlapping or unbounded faces, and the failure is visually
 *   confusing rather than obvious. `makePlanar` splits every such crossing.
 * - **Dead-end pruning.** A degree-1 chain gets walked out and back, injecting a
 *   zero-area spike into the face polygon which then wrecks the offsetter.
 *   Spurs are pruned before the walk and kept for rendering.
 */

export interface GraphNode {
  id: number;
  p: Vec2;
}

export interface GraphEdge {
  id: number;
  a: number;
  b: number;
  /** Opaque payload carried through splitting — the road class and width. */
  data?: unknown;
}

export class PlanarGraph {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  private index = new Map<string, number>();
  private snap: number;

  constructor(snapDistance = 0.05) {
    this.snap = snapDistance;
  }

  private key(p: Vec2): string {
    const q = Math.max(1e-6, this.snap);
    return `${Math.round(p.x / q)},${Math.round(p.y / q)}`;
  }

  addNode(p: Vec2): number {
    const k = this.key(p);
    const existing = this.index.get(k);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ id, p });
    this.index.set(k, id);
    return id;
  }

  addEdge(a: number, b: number, data?: unknown): number {
    if (a === b) return -1;
    for (const e of this.edges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e.id;
    }
    const id = this.edges.length;
    this.edges.push(data === undefined ? { id, a, b } : { id, a, b, data });
    return id;
  }

  addSegment(p: Vec2, q: Vec2, data?: unknown): number {
    return this.addEdge(this.addNode(p), this.addNode(q), data);
  }

  node(id: number): GraphNode {
    return this.nodes[id]!;
  }

  /** Adjacency as node id -> incident edge ids. */
  adjacency(): number[][] {
    const adj: number[][] = this.nodes.map(() => []);
    for (const e of this.edges) {
      if (e.a < 0 || e.b < 0) continue;
      adj[e.a]!.push(e.id);
      adj[e.b]!.push(e.id);
    }
    return adj;
  }

  degree(): number[] {
    return this.adjacency().map((l) => l.length);
  }
}

/**
 * Split every pair of edges that cross without sharing a node, and merge nodes
 * that are closer than the graph's snap distance. Returns a new graph.
 */
export function makePlanar(graph: PlanarGraph, snapDistance = 0.4): PlanarGraph {
  // Collect split parameters per edge.
  const splits: Map<number, { t: number; p: Vec2 }[]> = new Map();
  const record = (edgeId: number, t: number, p: Vec2) => {
    let list = splits.get(edgeId);
    if (!list) splits.set(edgeId, (list = []));
    list.push({ t, p });
  };

  const es = graph.edges;
  for (let i = 0; i < es.length; i++) {
    const ei = es[i]!;
    const a1 = graph.node(ei.a).p;
    const a2 = graph.node(ei.b).p;
    for (let j = i + 1; j < es.length; j++) {
      const ej = es[j]!;
      if (ei.a === ej.a || ei.a === ej.b || ei.b === ej.a || ei.b === ej.b) continue;
      const b1 = graph.node(ej.a).p;
      const b2 = graph.node(ej.b).p;
      const x = V.segmentIntersection(a1, a2, b1, b2, -1e-6);
      if (!x) continue;
      record(ei.id, x.ta, x.point);
      record(ej.id, x.tb, x.point);
    }
  }

  const out = new PlanarGraph(snapDistance);
  for (const e of es) {
    const a = graph.node(e.a).p;
    const b = graph.node(e.b).p;
    const list = splits.get(e.id);
    if (!list || list.length === 0) {
      out.addSegment(a, b, e.data);
      continue;
    }
    list.sort((p, q) => p.t - q.t);
    let prev = a;
    for (const s of list) {
      if (V.dist(prev, s.p) > snapDistance) {
        out.addSegment(prev, s.p, e.data);
        prev = s.p;
      }
    }
    if (V.dist(prev, b) > snapDistance) out.addSegment(prev, b, e.data);
  }
  return out;
}

/**
 * Split every edge that a node lands on the *interior* of.
 *
 * `makePlanar` only records intersections strictly inside both edges, so a
 * street that ends exactly on another one — every T-junction, and every road
 * that stops on the town perimeter — leaves the road it meets unsplit. The two
 * then share no node: the face walk treats them as unconnected, `findSpurs`
 * prunes the dead-ending street out of the walk entirely, and the districts
 * either side of it merge into one.
 *
 * Callers can avoid this by overshooting the junction, but that only works when
 * they know a junction is there. This pass makes it unconditional.
 */
export function splitEdgesAtNodes(graph: PlanarGraph, tolerance = 0.05): PlanarGraph {
  const splits: Map<number, { t: number; p: Vec2 }[]> = new Map();

  for (const e of graph.edges) {
    const a = graph.node(e.a).p;
    const b = graph.node(e.b).p;
    const ab = V.sub(b, a);
    const l2 = V.lenSq(ab);
    if (l2 < 1e-12) continue;

    for (const n of graph.nodes) {
      if (n.id === e.a || n.id === e.b) continue;
      const t = V.dot(V.sub(n.p, a), ab) / l2;
      // Only interior hits: an endpoint hit means they already share a node, or
      // are within snapping distance of doing so.
      if (t <= 1e-6 || t >= 1 - 1e-6) continue;
      const foot = V.addScaled(a, ab, t);
      if (V.dist(foot, n.p) > tolerance) continue;
      // Do not manufacture a fragment shorter than the tolerance itself.
      const len = Math.sqrt(l2);
      if (t * len < tolerance || (1 - t) * len < tolerance) continue;
      let list = splits.get(e.id);
      if (!list) splits.set(e.id, (list = []));
      list.push({ t, p: n.p });
    }
  }

  if (splits.size === 0) return graph;

  const out = new PlanarGraph(tolerance);
  for (const e of graph.edges) {
    const a = graph.node(e.a).p;
    const b = graph.node(e.b).p;
    const list = splits.get(e.id);
    if (!list) {
      out.addSegment(a, b, e.data);
      continue;
    }
    list.sort((x, y) => x.t - y.t);
    let prev = a;
    for (const s of list) {
      if (V.dist(prev, s.p) > tolerance) {
        out.addSegment(prev, s.p, e.data);
        prev = s.p;
      }
    }
    if (V.dist(prev, b) > tolerance) out.addSegment(prev, b, e.data);
  }
  return out;
}

/** Edges removed by spur pruning, in original-graph terms. */
export interface PrunedSpurs {
  edgeIds: Set<number>;
}

/**
 * Iteratively remove degree-1 nodes. Returns the set of edge ids that are part
 * of dead-end chains — those still get rendered, they just cannot bound a face.
 */
export function findSpurs(graph: PlanarGraph): PrunedSpurs {
  const adj = graph.adjacency();
  const degree = adj.map((l) => l.length);
  const removed = new Set<number>();

  const queue: number[] = [];
  for (let i = 0; i < degree.length; i++) if (degree[i] === 1) queue.push(i);

  while (queue.length > 0) {
    const n = queue.pop()!;
    if (degree[n] !== 1) continue;
    const edgeId = adj[n]!.find((id) => !removed.has(id));
    if (edgeId === undefined) {
      degree[n] = 0;
      continue;
    }
    removed.add(edgeId);
    const e = graph.edges[edgeId]!;
    const other = e.a === n ? e.b : e.a;
    degree[n] = 0;
    degree[other] = (degree[other] ?? 1) - 1;
    if (degree[other] === 1) queue.push(other);
  }
  return { edgeIds: removed };
}

export interface Face {
  /** CCW polygon of the bounded face. */
  polygon: Polygon;
  /** For each polygon vertex i, the graph edge id of the edge from i to i+1. */
  edgeIds: number[];
}

/**
 * Extract every bounded face by half-edge traversal.
 *
 * At each node the incident half-edges are sorted by angle. Arriving along
 * `u -> v`, the next half-edge is the one immediately clockwise from the reverse
 * `v -> u`, which traces interior faces counter-clockwise.
 */
export function extractFaces(graph: PlanarGraph, excludeEdges?: Set<number>): Face[] {
  const skip = excludeEdges ?? new Set<number>();

  // Build directed half-edges, skipping excluded edges.
  interface HalfEdge {
    id: number;
    from: number;
    to: number;
    edgeId: number;
    angle: number;
    twin: number;
  }
  const halves: HalfEdge[] = [];
  const outgoing: number[][] = graph.nodes.map(() => []);

  for (const e of graph.edges) {
    if (skip.has(e.id)) continue;
    const pa = graph.node(e.a).p;
    const pb = graph.node(e.b).p;
    if (V.dist(pa, pb) < 1e-9) continue;
    const i0 = halves.length;
    halves.push({
      id: i0,
      from: e.a,
      to: e.b,
      edgeId: e.id,
      angle: Math.atan2(pb.y - pa.y, pb.x - pa.x),
      twin: i0 + 1,
    });
    halves.push({
      id: i0 + 1,
      from: e.b,
      to: e.a,
      edgeId: e.id,
      angle: Math.atan2(pa.y - pb.y, pa.x - pb.x),
      twin: i0,
    });
    outgoing[e.a]!.push(i0);
    outgoing[e.b]!.push(i0 + 1);
  }

  for (const list of outgoing) list.sort((x, y) => halves[x]!.angle - halves[y]!.angle);
  const posInSorted = new Map<number, number>();
  for (const list of outgoing) {
    for (let i = 0; i < list.length; i++) posInSorted.set(list[i]!, i);
  }

  const visited = new Uint8Array(halves.length);
  const faces: Face[] = [];

  for (const start of halves) {
    if (visited[start.id]) continue;
    const ring: number[] = [];
    let cur = start;
    let guard = 0;
    let closed = false;

    while (guard++ < halves.length * 2 + 8) {
      visited[cur.id] = 1;
      ring.push(cur.id);

      const twin = halves[cur.twin]!;
      const list = outgoing[twin.from]!;
      const idx = posInSorted.get(twin.id)!;
      // One step clockwise from the reverse half-edge.
      const nextId = list[(idx - 1 + list.length) % list.length]!;
      const next = halves[nextId]!;
      if (next.id === start.id) {
        closed = true;
        break;
      }
      if (visited[next.id]) break;
      cur = next;
    }
    if (!closed || ring.length < 3) continue;

    const polygon: Polygon = ring.map((hid) => graph.node(halves[hid]!.from).p);
    // Only counter-clockwise cycles are interior faces; the single clockwise
    // cycle with large area is the outer boundary of the whole graph.
    if (signedArea(polygon) <= 0) continue;
    faces.push({ polygon, edgeIds: ring.map((hid) => halves[hid]!.edgeId) });
  }

  return faces;
}

/**
 * Development check: report edge pairs that cross without sharing a node.
 * Returns an empty array for a properly planar graph.
 */
export function findNonPlanarCrossings(graph: PlanarGraph): [number, number][] {
  const bad: [number, number][] = [];
  const es = graph.edges;
  for (let i = 0; i < es.length; i++) {
    const ei = es[i]!;
    const a1 = graph.node(ei.a).p;
    const a2 = graph.node(ei.b).p;
    for (let j = i + 1; j < es.length; j++) {
      const ej = es[j]!;
      if (ei.a === ej.a || ei.a === ej.b || ei.b === ej.a || ei.b === ej.b) continue;
      if (V.segmentIntersection(a1, a2, graph.node(ej.a).p, graph.node(ej.b).p, -1e-6)) {
        bad.push([ei.id, ej.id]);
      }
    }
  }
  return bad;
}
