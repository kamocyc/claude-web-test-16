import type { Vec2 } from '../core/types.js';
import type { RoadClass, RoadParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { PlanarGraph } from '../geom/planarGraph.js';
import type { RoadEdge, RoadEdgeData, RoadNetwork } from './Roads.js';

/**
 * Clearance: the rule that two roads which do not meet must not touch.
 *
 * Nothing in the pipeline used to measure the distance between two
 * *non-incident* road edges. `makePlanar` resolves genuine crossings and
 * `PlanarGraph` snaps coincident nodes, but two edges running 1.5 m apart are
 * perfectly planar and perfectly wrong: a 13 m arterial and a 4.8 m street that
 * close have nearly 9 m of overlapping asphalt for their whole shared length.
 *
 * This module is both the detector and the fix. `clearanceViolations` is the
 * oracle — it is what the tests assert on, and it is deliberately independent
 * of how the roads were generated, so it keeps working when the generator
 * changes again.
 */

export interface ClearanceViolation {
  /** Edge ids, `a < b`. */
  a: number;
  b: number;
  gap: number;
  required: number;
}

/** A road segment as the clearance pass sees it: geometry, width, identity. */
interface Probe {
  id: number;
  a: Vec2;
  b: Vec2;
  width: number;
  cls: RoadClass;
  /** Graph node ids, or null for a private lane (which has no node identity). */
  na: number | null;
  nb: number | null;
}

const CLASS_RANK: Record<RoadClass, number> = {
  arterial: 3,
  collector: 2,
  local: 1,
  private: 0,
};

/**
 * Pull both ends of a segment back past whatever fills its junctions.
 *
 * Two edges of the same street either side of a T-junction do not share a node
 * with the stem, yet they pass within a stem's half width of it by design. So
 * do the four arms of a crossroads. Measuring the raw segments would report
 * every junction in the town as a violation. Retracting each end by the largest
 * half width meeting there leaves exactly the part of the road that is supposed
 * to be clear of everything, and two genuinely parallel streets stay in
 * violation along their whole length.
 */
function trimmedForProbe(p: Probe, radius: (node: number | null, at: Vec2) => number): [Vec2, Vec2] | null {
  const l = V.dist(p.a, p.b);
  if (l < 1e-6) return null;
  const dir = V.scale(V.sub(p.b, p.a), 1 / l);
  const ra = radius(p.na, p.a);
  const rb = radius(p.nb, p.b);
  // Entirely inside its own junctions — a fragment left between two crossings a
  // couple of metres apart is junction geometry, not a road running alongside
  // something. `minEdgeLength` governs those, not this pass.
  if (ra + rb >= l - 1e-6) return null;
  return [V.addScaled(p.a, dir, ra), V.addScaled(p.b, dir, -rb)];
}

/**
 * Are these two segments arms of the same junction?
 *
 * Sharing a node is the obvious case. The one that matters is two hops out: at
 * a crossroads of two 13 m arterials, the arm *beyond* the short link edge does
 * not share a node with the arm across from it, yet the two are only ever going
 * to be a junction's width apart. Treating that as an overlap would condemn
 * every crossroads in the town. Two segments belong to one junction when a node
 * of each lies inside the other's junction radius.
 */
function sameJunction(a: Probe, b: Probe, radius: (node: number | null, at: Vec2) => number): boolean {
  for (const [na, pa] of [
    [a.na, a.a],
    [a.nb, a.b],
  ] as const) {
    for (const [nb, pb] of [
      [b.na, b.a],
      [b.nb, b.b],
    ] as const) {
      // A private lane has no node identity and never joins the graph on
      // purpose, so it is never excused by proximity to a junction.
      if (na === null || nb === null) continue;
      if (na === nb) return true;
      if (V.dist(pa, pb) < radius(na, pa) + radius(nb, pb)) return true;
    }
  }
  return false;
}

function probesOf(net: RoadNetwork, includeLanes: boolean): Probe[] {
  const out: Probe[] = [];
  for (const e of net.edges) {
    out.push({
      id: e.id,
      a: net.graph.node(e.a).p,
      b: net.graph.node(e.b).p,
      width: e.width,
      cls: e.cls,
      na: e.a,
      nb: e.b,
    });
  }
  if (includeLanes) {
    // Lanes are injected after `generateRoads` by the block splitter and the lot
    // subdivider, so they carry no graph identity. Negative ids keep them
    // distinguishable from edges in a violation report.
    net.privateLanes.forEach((lane, i) => {
      out.push({
        id: -1 - i,
        a: lane.a,
        b: lane.b,
        width: lane.width,
        cls: 'private',
        na: null,
        nb: null,
      });
    });
  }
  return out;
}

/**
 * How much of a private lane's end is junction rather than lane.
 *
 * A lane has no graph node, but it still ends *at* a street — that is the whole
 * point of it, and it is where the parcels behind it take their frontage.
 * Measuring centreline distance right up to that end would flag every
 * legitimate T-junction, since a lane's last few metres are of course within a
 * carriageway's width of the road it joins. So a lane end takes its junction
 * radius from whichever road it is running into.
 */
function laneEndRadius(net: RoadNetwork, at: Vec2, clearance: number): number {
  let widest = 0;
  for (const e of net.edges) {
    const a = net.graph.node(e.a).p;
    const b = net.graph.node(e.b).p;
    if (V.distToSegment(at, a, b) > e.width / 2 + 8) continue;
    widest = Math.max(widest, e.width / 2);
  }
  return widest === 0 ? 0 : widest + clearance;
}

/**
 * May this lane be built? Same rule as the detector, asked before the fact.
 *
 * A block is a face of the road graph, so no road crosses its interior — except
 * a dead-end street, which is pruned from the face walk and therefore sits
 * *inside* a block with nothing recording that it is there. The lot subdivider
 * cannot see it and will happily drive a 私道 straight over it.
 */
export function laneClears(
  net: RoadNetwork,
  a: Vec2,
  b: Vec2,
  width: number,
  clearance: number,
): boolean {
  const l = V.dist(a, b);
  if (l < 1e-6) return false;
  const dir = V.scale(V.sub(b, a), 1 / l);
  const ra = Math.min(laneEndRadius(net, a, clearance), l * 0.4);
  const rb = Math.min(laneEndRadius(net, b, clearance), l * 0.4);
  if (ra + rb >= l) return true; // all junction, no road to speak of
  const from = V.addScaled(a, dir, ra);
  const to = V.addScaled(b, dir, -rb);

  for (const e of net.edges) {
    const ea = net.graph.node(e.a).p;
    const eb = net.graph.node(e.b).p;
    if (V.segmentDistance(from, to, ea, eb) < e.width / 2 + width / 2 + clearance - 1e-9) {
      return false;
    }
  }
  for (const lane of net.privateLanes) {
    if (
      V.segmentDistance(from, to, lane.a, lane.b) <
      lane.width / 2 + width / 2 + clearance - 1e-9
    ) {
      return false;
    }
  }
  return true;
}

export interface ClearanceOptions {
  clearance: number;
  /** Also check the private lanes injected downstream of `generateRoads`. */
  includeLanes?: boolean;
}

/**
 * Every pair of road segments whose ribbons come closer than they should.
 *
 * O(n²) over edge pairs behind an expanded-AABB reject. The network runs to
 * roughly a thousand edges, and `makePlanar` already does two full O(n²) sweeps
 * on the same data, so this does not register in `city.timings`.
 */
export function clearanceViolations(
  net: RoadNetwork,
  opts: ClearanceOptions,
): ClearanceViolation[] {
  const probes = probesOf(net, opts.includeLanes ?? false);
  const clearance = opts.clearance;

  // Junction radius per node: the widest thing meeting there, plus the gap.
  const nodeRadius = new Map<number, number>();
  for (const p of probes) {
    for (const n of [p.na, p.nb]) {
      if (n === null) continue;
      const r = p.width / 2 + clearance;
      if ((nodeRadius.get(n) ?? 0) < r) nodeRadius.set(n, r);
    }
  }
  const radius = (node: number | null, at: Vec2): number =>
    node === null ? laneEndRadius(net, at, clearance) : (nodeRadius.get(node) ?? clearance);

  interface Item {
    p: Probe;
    a: Vec2;
    b: Vec2;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }
  const items: Item[] = [];
  for (const p of probes) {
    const t = trimmedForProbe(p, radius);
    if (!t) continue;
    const pad = p.width / 2 + clearance;
    items.push({
      p,
      a: t[0],
      b: t[1],
      minX: Math.min(t[0].x, t[1].x) - pad,
      maxX: Math.max(t[0].x, t[1].x) + pad,
      minY: Math.min(t[0].y, t[1].y) - pad,
      maxY: Math.max(t[0].y, t[1].y) + pad,
    });
  }

  const out: ClearanceViolation[] = [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i]!;
    for (let j = i + 1; j < items.length; j++) {
      const y = items[j]!;
      if (x.maxX < y.minX || y.maxX < x.minX || x.maxY < y.minY || y.maxY < x.minY) continue;
      if (sameJunction(x.p, y.p, radius)) continue;
      const required = x.p.width / 2 + y.p.width / 2 + clearance;
      const gap = V.segmentDistance(x.a, x.b, y.a, y.b);
      if (gap >= required - 1e-9) continue;
      out.push({
        a: Math.min(x.p.id, y.p.id),
        b: Math.max(x.p.id, y.p.id),
        gap,
        required,
      });
    }
  }
  return out;
}

/** Describe a violation the way a failing test wants to read it. */
export function describeViolation(net: RoadNetwork, v: ClearanceViolation): string {
  const label = (id: number): string => {
    if (id < 0) {
      const lane = net.privateLanes[-1 - id];
      return lane
        ? `lane#${-1 - id} w=${lane.width} (${lane.a.x.toFixed(1)},${lane.a.y.toFixed(1)})–(${lane.b.x.toFixed(1)},${lane.b.y.toFixed(1)})`
        : `lane#${-1 - id}`;
    }
    const e = net.edgeById.get(id);
    if (!e) return `edge#${id}`;
    const a = net.graph.node(e.a).p;
    const b = net.graph.node(e.b).p;
    return `edge#${id} ${e.cls} w=${e.width} (${a.x.toFixed(1)},${a.y.toFixed(1)})–(${b.x.toFixed(1)},${b.y.toFixed(1)})`;
  };
  return `${label(v.a)} vs ${label(v.b)}: gap ${v.gap.toFixed(2)} m, needs ${v.required.toFixed(2)} m`;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export interface EnforceResult {
  graph: PlanarGraph;
  removedEdges: number;
  removedSpans: number;
  rounds: number;
}

/** Straight-ish continuation of the same street through a degree-2 node. */
const SPAN_TURN_LIMIT = 15 * (Math.PI / 180);

export interface AcuteJunction {
  a: number;
  b: number;
  /** Angle between the two arms, radians. */
  angle: number;
  node: number;
}

/**
 * Junctions where two arms leave at a sliver angle.
 *
 * These are the other half of the overlap problem. Two roads meeting at 10°
 * have ribbons that overlap in a long lens either side of the node, and the
 * block corner between them is a spike that the subdivider throws away — which
 * is what leaves the bald patches at intersections. Unlike a clearance breach
 * this cannot be seen by measuring distances, because at the shared node the
 * distance is legitimately zero.
 */
export function acuteJunctions(
  graph: PlanarGraph,
  edges: RoadEdge[],
  minAngle: number,
): AcuteJunction[] {
  const arms: { angle: number; id: number }[][] = graph.nodes.map(() => []);
  for (const e of edges) {
    const a = graph.node(e.a).p;
    const b = graph.node(e.b).p;
    arms[e.a]!.push({ angle: V.angleOf(V.sub(b, a)), id: e.id });
    arms[e.b]!.push({ angle: V.angleOf(V.sub(a, b)), id: e.id });
  }

  const out: AcuteJunction[] = [];
  arms.forEach((list, node) => {
    if (list.length < 2) return;
    const sorted = list.slice().sort((x, y) => x.angle - y.angle);
    for (let i = 0; i < sorted.length; i++) {
      // With two arms there is only one gap worth naming: the angle the street
      // turns through. Wrapping round would report its explement as well.
      if (sorted.length === 2 && i === 1) break;
      const cur = sorted[i]!;
      const next = sorted[(i + 1) % sorted.length]!;
      let gap = next.angle - cur.angle;
      if (gap < 0) gap += Math.PI * 2;
      if (gap < minAngle - 1e-9) {
        out.push({ a: Math.min(cur.id, next.id), b: Math.max(cur.id, next.id), angle: gap, node });
      }
    }
  });
  return out;
}

/**
 * Delete the lesser road wherever two ribbons overlap, then rebuild the graph.
 *
 * Removal works on whole *spans*, not single edges: taking one edge out of the
 * middle of a street leaves a hole with traffic on both sides of it, whereas
 * taking the run leaves two honest dead ends — which a Japanese suburb is full
 * of anyway. A span is the chain that continues through degree-2 nodes while
 * the class matches and the street does not really turn.
 *
 * Deleting edges cannot create a crossing, so no re-planarisation is needed.
 */
export function enforceClearance(
  net: RoadNetwork,
  p: RoadParams,
  maxRounds = 3,
): EnforceResult {
  let graph = net.graph;
  let edges = net.edges;
  let removedEdges = 0;
  let removedSpans = 0;
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const view: RoadNetwork = { ...net, graph, edges, edgeById: new Map(edges.map((e) => [e.id, e])) };

    // Both defects are resolved the same way — delete the lesser road — so they
    // share one work list and one fixed point. Severity is expressed as "how
    // far short of acceptable", scaled so a metre of missing gap and a degree
    // of missing angle are comparable.
    const work: { a: number; b: number; severity: number; acute?: AcuteJunction }[] = [];
    for (const v of clearanceViolations(view, { clearance: p.roadClearance })) {
      work.push({ a: v.a, b: v.b, severity: v.required - v.gap });
    }
    const minAngle = p.minJunctionAngle * (Math.PI / 180);
    for (const j of acuteJunctions(graph, edges, minAngle)) {
      work.push({ a: j.a, b: j.b, severity: ((minAngle - j.angle) / minAngle) * 8, acute: j });
    }
    if (work.length === 0) break;

    const byId = view.edgeById;
    const spanLength = new Map<number, number>();
    const dead = new Set<number>();

    // Worst offender first, deterministically.
    work.sort((u, w) => w.severity - u.severity || u.a - w.a || u.b - w.b);

    const adj = graph.adjacency();
    const lengthOf = (e: RoadEdge): number =>
      V.dist(graph.node(e.a).p, graph.node(e.b).p);

    /** The chain of same-class, near-collinear edges through this one. */
    const spanOf = (start: RoadEdge): RoadEdge[] => {
      const span = [start];
      const seen = new Set([start.id]);
      for (const startNode of [start.a, start.b]) {
        let node = startNode;
        let cur = start;
        for (let guard = 0; guard < 64; guard++) {
          const incident = adj[node]!.filter((id) => byId.has(id));
          if (incident.length !== 2) break;
          const nextId = incident.find((id) => id !== cur.id);
          if (nextId === undefined) break;
          const next = byId.get(nextId)!;
          if (seen.has(next.id) || next.cls !== cur.cls) break;
          const dirIn = V.normalize(
            V.sub(graph.node(node).p, graph.node(cur.a === node ? cur.b : cur.a).p),
          );
          const other = next.a === node ? next.b : next.a;
          const dirOut = V.normalize(V.sub(graph.node(other).p, graph.node(node).p));
          if (V.angleBetween(dirIn, dirOut) > SPAN_TURN_LIMIT) break;
          span.push(next);
          seen.add(next.id);
          cur = next;
          node = other;
        }
      }
      return span;
    };

    const spanLen = (e: RoadEdge): number => {
      const cached = spanLength.get(e.id);
      if (cached !== undefined) return cached;
      const span = spanOf(e);
      const total = span.reduce((s, x) => s + lengthOf(x), 0);
      for (const x of span) spanLength.set(x.id, total);
      return total;
    };

    for (const w of work) {
      // Lanes are handled by `trimLaneEnds` at their injection sites, not here.
      if (w.a < 0 || w.b < 0) continue;
      if (dead.has(w.a) || dead.has(w.b)) continue;
      const ea = byId.get(w.a);
      const eb = byId.get(w.b);
      if (!ea || !eb) continue;

      // Two Tier-1 roads should never have got into this state — the skeleton
      // rejects such placements outright. Deleting one would tear a hole
      // through the town, so report it and leave it: a test failing is the
      // right outcome, not a mutilated arterial.
      const tier1 = (e: RoadEdge) => e.cls === 'arterial' || e.cls === 'collector';
      if (tier1(ea) && tier1(eb)) {
        if (import.meta.env?.DEV) {
          console.warn(
            `[roads] two Tier-1 roads conflict: edges ${w.a}/${w.b}` +
              (w.acute ? ` meet at ${((w.acute.angle * 180) / Math.PI).toFixed(1)}°` : ' overlap'),
          );
        }
        continue;
      }

      const rank = CLASS_RANK[ea.cls] - CLASS_RANK[eb.cls];
      const loser = rank < 0 ? ea : rank > 0 ? eb : spanLen(ea) <= spanLen(eb) ? ea : eb;
      for (const e of spanOf(loser)) dead.add(e.id);
      removedSpans++;
    }

    if (dead.size === 0) break;
    removedEdges += dead.size;
    edges = edges.filter((e) => !dead.has(e.id));
    graph = rebuild(graph, edges, p.nodeSnap);
    edges = readEdges(graph, p);
  }

  return { graph, removedEdges, removedSpans, rounds };
}

/**
 * Drop dangling fragments too short to be a street.
 *
 * Streets are deliberately run past the road they join so the junction splits
 * properly, which leaves a stub on the far side of every such crossing. A real
 * 行き止まり is at least `minEdgeLength` long by construction, so anything
 * shorter that dead-ends is an artefact of that overshoot. Iterated, because
 * removing one stub can expose the next.
 */
export function pruneShortStubs(graph: PlanarGraph, p: RoadParams): PlanarGraph {
  let edges = readEdges(graph, p);
  for (let round = 0; round < 4; round++) {
    const degree = new Map<number, number>();
    for (const e of edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const kept = edges.filter((e) => {
      const dangling = degree.get(e.a) === 1 || degree.get(e.b) === 1;
      if (!dangling) return true;
      return V.dist(graph.node(e.a).p, graph.node(e.b).p) >= p.minEdgeLength;
    });
    if (kept.length === edges.length) break;
    edges = kept;
  }
  return rebuild(graph, edges, p.nodeSnap * 0.4);
}

/** Rebuild a graph from a surviving subset of edges, dropping orphaned nodes. */
function rebuild(graph: PlanarGraph, edges: RoadEdge[], snap: number): PlanarGraph {
  const out = new PlanarGraph(snap);
  for (const e of edges) {
    out.addSegment(graph.node(e.a).p, graph.node(e.b).p, {
      cls: e.cls,
      width: e.width,
    } satisfies RoadEdgeData);
  }
  return out;
}

/** Re-derive the `RoadEdge` list from a graph's edge payloads. */
export function readEdges(graph: PlanarGraph, p: RoadParams): RoadEdge[] {
  return graph.edges.map((e) => {
    const data = e.data as RoadEdgeData | undefined;
    return {
      id: e.id,
      a: e.a,
      b: e.b,
      cls: data?.cls ?? 'local',
      width: data?.width ?? p.localWidth,
    };
  });
}

/**
 * Pull a private lane's ends back until they clear every road they pass.
 *
 * Lanes are cut *after* the road graph is final, and the block splitter clips
 * its lane against the block face — whose boundary is the road centreline, not
 * its kerb. Every such lane therefore ran a full half width (up to 6.5 m
 * against an arterial) into the asphalt at both ends. Returns null when what is
 * left is too short to be a street.
 */
export function trimLaneEnds(
  net: RoadNetwork,
  a: Vec2,
  b: Vec2,
  width: number,
  clearance: number,
  minLength = 12,
): [Vec2, Vec2] | null {
  const l0 = V.dist(a, b);
  if (l0 < minLength) return null;
  const dir = V.scale(V.sub(b, a), 1 / l0);

  const roads: { a: Vec2; b: Vec2; width: number }[] = [];
  for (const e of net.edges) {
    roads.push({ a: net.graph.node(e.a).p, b: net.graph.node(e.b).p, width: e.width });
  }
  const lanes = net.privateLanes;

  // The gutter allowance the lot subdivider already takes off every frontage;
  // stopping the lane on the same line keeps the asphalt and the land agreed.
  const GUTTER = 0.5;

  let t0 = 0;
  let t1 = l0;
  for (const n of roads) {
    // Walk each end inward in half-metre steps until it clears the road it is
    // running into. A lane is *supposed* to reach the street — it stops at the
    // right-of-way line, flush with the kerb, not a clearance short of it.
    const need = n.width / 2 + GUTTER;
    for (let guard = 0; guard < 60 && t0 < t1; guard++) {
      if (V.distToSegment(V.addScaled(a, dir, t0), n.a, n.b) >= need - 1e-9) break;
      t0 += 0.5;
    }
    for (let guard = 0; guard < 60 && t1 > t0; guard++) {
      if (V.distToSegment(V.addScaled(a, dir, t1), n.a, n.b) >= need - 1e-9) break;
      t1 -= 0.5;
    }
  }
  // Another lane is not a street to join, so keep a full clearance from it.
  for (const n of lanes) {
    const need = n.width / 2 + width / 2 + clearance;
    for (let guard = 0; guard < 60 && t0 < t1; guard++) {
      if (V.distToSegment(V.addScaled(a, dir, t0), n.a, n.b) >= need - 1e-9) break;
      t0 += 0.5;
    }
    for (let guard = 0; guard < 60 && t1 > t0; guard++) {
      if (V.distToSegment(V.addScaled(a, dir, t1), n.a, n.b) >= need - 1e-9) break;
      t1 -= 0.5;
    }
  }

  // Stopping at the right-of-way line is the right answer for a lane running
  // straight into a street, but not for one arriving at a slant, where the
  // near corner still has to clear. Rather than solve for that angle, converge
  // on the acceptance test itself, so the two can never disagree.
  for (let guard = 0; guard < 24; guard++) {
    if (t1 - t0 < minLength) return null;
    const from = V.addScaled(a, dir, t0);
    const to = V.addScaled(a, dir, t1);
    if (laneClears(net, from, to, width, clearance)) return [from, to];
    t0 += 0.5;
    t1 -= 0.5;
  }
  return null;
}
