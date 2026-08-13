import type { Vec2 } from '../core/types.js';
import type { RoadClass, RoadParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import type { Terrain } from '../terrain/Terrain.js';
import type { RoadEdge, RoadNetwork } from './Roads.js';

/**
 * The design height of every road.
 *
 * **A road is a graded surface, not a drape.** Laying the carriageway on the
 * heightfield directly would give every street the fBm's own texture — a 4 m
 * ripple that no earthworks would ever leave — and the eye reads that as a
 * rendering fault rather than as ground. Real roads are cut and filled until
 * their longitudinal profile is smooth and their gradient is something a lorry
 * can climb, and the spoil ends up in the embankment beside them.
 *
 * The solve is per *node*, not per edge. Two streets meeting at a junction must
 * agree on a height or the junction tears open, and there is no way to make two
 * independently-drawn profiles agree after the fact. Once each node has one
 * height, every ribbon is linear between its two ends, every junction closes
 * exactly, and — the part that pays for itself twice over — a row of lots down a
 * sloping street inherits a staircase of frontage heights for free, which is
 * what 雛壇造成 actually is.
 */

export interface RoadHeights {
  /** Design height at a graph node. */
  at(node: number): number;
  /** Design height a fraction `t` along an edge. */
  alongEdge(e: RoadEdge, t: number): number;
  /** Design height at the nearest point of the network, for the camera. */
  nearestRoadHeight(p: Vec2, within: number): number | null;
  /** True when every height is zero — the flat-world fast path. */
  readonly flat: boolean;
}

const FLAT: RoadHeights = {
  at: () => 0,
  alongEdge: () => 0,
  nearestRoadHeight: () => null,
  flat: true,
};

/**
 * How hard a class of road pushes the land around rather than following it.
 *
 * An arterial is graded: it cuts through the rise and fills the dip, because it
 * has to hold 6% over a kilometre. A 私道 up to a flag lot follows the ground,
 * because nobody brought a bulldozer for it.
 */
const SMOOTHING: Record<RoadClass, number> = {
  arterial: 0.55,
  collector: 0.42,
  local: 0.26,
  private: 0.12,
};

export function solveRoadProfile(net: RoadNetwork, terrain: Terrain, p: RoadParams): RoadHeights {
  if (!terrain.params.enabled) return FLAT;

  const g = p.growth;
  const nodeCount = net.graph.nodes.length;
  const y = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const q = net.graph.node(i).p;
    y[i] = terrain.heightAtXY(q.x, q.y);
  }

  // Adjacency, with the length and the governing class of each incident edge.
  const inc: { other: number; len: number; cls: RoadClass }[][] = Array.from(
    { length: nodeCount },
    () => [],
  );
  for (const e of net.edges) {
    const a = net.graph.node(e.a).p;
    const b = net.graph.node(e.b).p;
    const len = Math.max(0.5, V.dist(a, b));
    inc[e.a]?.push({ other: e.b, len, cls: e.cls });
    inc[e.b]?.push({ other: e.a, len, cls: e.cls });
  }

  const ground = new Float64Array(y);

  // Gauss–Seidel, in node-id order, for a fixed number of sweeps. Both the
  // order and the count are fixed rather than convergence-driven: this runs
  // inside `generateCity`, and `test/golden.test.ts` hashes what comes out of
  // it, so "however many sweeps it took today" is not an acceptable answer.
  for (let sweep = 0; sweep < g.profileRelaxIterations; sweep++) {
    for (let n = 0; n < nodeCount; n++) {
      const links = inc[n];
      if (!links || links.length === 0) continue;

      let best: RoadClass = 'private';
      let sum = 0;
      let weight = 0;
      for (const l of links) {
        if (SMOOTHING[l.cls] > SMOOTHING[best]) best = l.cls;
        const w = 1 / l.len;
        sum += y[l.other]! * w;
        weight += w;
      }
      // Blend toward the neighbours, then pull back toward the ground so the
      // road does not float away from the land it is supposed to be on.
      const k = SMOOTHING[best];
      const smoothed = weight > 0 ? sum / weight : y[n]!;
      y[n] = y[n]! * (1 - k) + smoothed * k * 0.85 + (ground[n]! - y[n]!) * k * 0.15;
    }

    // Project onto the gradient constraint. Done as a separate pass after the
    // smoothing rather than interleaved, because a violated pair has to be
    // corrected from both ends — moving only the lower node walks the whole
    // road downhill over twenty sweeps.
    for (const e of net.edges) {
      const a = net.graph.node(e.a).p;
      const b = net.graph.node(e.b).p;
      const len = Math.max(0.5, V.dist(a, b));
      const limit = g.maxGradient[e.cls] * len;
      const diff = y[e.b]! - y[e.a]!;
      const over = Math.abs(diff) - limit;
      if (over <= 0) continue;
      const fix = (over / 2) * Math.sign(diff);
      y[e.a] = y[e.a]! + fix;
      y[e.b] = y[e.b]! - fix;
    }
  }

  const heights = Array.from(y);
  return {
    at: (node) => heights[node] ?? 0,
    alongEdge: (e, t) => (heights[e.a] ?? 0) + ((heights[e.b] ?? 0) - (heights[e.a] ?? 0)) * t,
    nearestRoadHeight(q, within) {
      let bestD = within;
      let bestH: number | null = null;
      for (const e of net.edges) {
        const a = net.graph.node(e.a).p;
        const b = net.graph.node(e.b).p;
        const c = V.closestOnSegment(q, a, b);
        const d = V.dist(q, c.point);
        if (d >= bestD) continue;
        bestD = d;
        bestH = (heights[e.a] ?? 0) + ((heights[e.b] ?? 0) - (heights[e.a] ?? 0)) * c.t;
      }
      return bestH;
    },
    flat: false,
  };
}

/**
 * The design height of every 私道, station by station.
 *
 * A private lane has no node in the road graph, so `solveRoadProfile` never sees
 * it and it had no profile at all: both ends were given the height of whatever
 * road happened to be within 40 m and the asphalt was drawn as one flat plane
 * between them. Across a block on a slope that borrows a height from the street
 * on the *far* side — measured on the default seed, 34 of 47 lanes ran more than
 * a metre under the land they cross and the worst was seven metres down, which is
 * to say the alley was inside the hill.
 *
 * A lane is not graded like a street, and this is not the street solver with
 * different weights. Nobody brought a bulldozer for a 私道: it follows the ground,
 * lifting off it only at the end where it has to meet the street it opens off,
 * and only over the few metres that takes.
 */

/** One private lane's profile: heights at evenly spaced stations along it. */
export interface LaneProfile {
  points: Vec2[];
  heights: number[];
  width: number;
}

export interface LaneHeights {
  /** One profile per entry of `RoadNetwork.privateLanes`, in the same order. */
  readonly profiles: LaneProfile[];
  /** Design height at the nearest point of any lane, or null if none is near. */
  nearestLaneHeight(p: Vec2, within: number): number | null;
}

/** Station spacing along a lane, metres. Fine enough to follow a hillside. */
const LANE_STATION = 4;
/**
 * How far from a lane end to look for the street it opens off.
 *
 * Short on purpose. The old 40 m search is exactly what put a lane at the height
 * of the road on the other side of the block; a lane is trimmed about 5 m back
 * from the carriageway it meets, so anything past a dozen metres is a different
 * street and not this lane's business.
 */
const LANE_ANCHOR_SEARCH = 12;
/** Over what distance along the lane the street's height gives way to the land. */
const LANE_ANCHOR_BLEND = 14;

export function solveLaneProfiles(
  net: RoadNetwork,
  terrain: Terrain,
  heights: RoadHeights,
  p: RoadParams,
): LaneHeights {
  const flat = heights.flat;
  const profiles: LaneProfile[] = [];

  for (const lane of net.privateLanes) {
    const len = V.dist(lane.a, lane.b);
    const n = Math.max(1, Math.round(len / LANE_STATION));
    const points: Vec2[] = [];
    for (let i = 0; i <= n; i++) points.push(V.lerp(lane.a, lane.b, i / n));

    if (flat) {
      profiles.push({ points, heights: points.map(() => 0), width: lane.width });
      continue;
    }

    // Where the lane meets a street, it is at the street's height — that is the
    // one place a 私道 is not free to follow the ground.
    const anchors: { at: number; y: number }[] = [];
    for (const [end, at] of [
      [lane.a, 0],
      [lane.b, n],
    ] as const) {
      const y = heights.nearestRoadHeight(end, LANE_ANCHOR_SEARCH);
      if (y !== null) anchors.push({ at, y });
    }

    // What the lane is trying to be: the land, pulled to the street over the
    // first few metres at each end that has one.
    const step = len / n;
    const target = points.map((q, i) => {
      const ground = terrain.heightAtXY(q.x, q.y);
      let w = 0;
      let ay = ground;
      for (const a of anchors) {
        const t = Math.min(1, (Math.abs(i - a.at) * step) / LANE_ANCHOR_BLEND);
        const wi = 1 - t * t * (3 - 2 * t);
        if (wi > w) {
          w = wi;
          ay = a.y;
        }
      }
      return ground * (1 - w) + ay * w;
    });

    // The same relaxation as the street solver, at the private smoothing — a
    // touch of averaging so the fBm's own ripple does not end up as a washboard,
    // and a gradient clamp so a lane up a scarp is still a lane.
    const h = [...target];
    const limit = p.growth.maxGradient.private * step;
    for (let sweep = 0; sweep < p.growth.profileRelaxIterations; sweep++) {
      for (let i = 0; i <= n; i++) {
        const smoothed = ((h[i - 1] ?? h[i]!) + (h[i + 1] ?? h[i]!)) / 2;
        const k = SMOOTHING.private;
        h[i] = h[i]! * (1 - k) + smoothed * k * 0.85 + (target[i]! - h[i]!) * k * 0.15;
      }
      for (const a of anchors) h[a.at] = a.y;
      for (let i = 0; i < n; i++) {
        const diff = h[i + 1]! - h[i]!;
        const over = Math.abs(diff) - limit;
        if (over <= 0) continue;
        const fix = (over / 2) * Math.sign(diff);
        h[i] = h[i]! + fix;
        h[i + 1] = h[i + 1]! - fix;
      }
    }

    profiles.push({ points, heights: h, width: lane.width });
  }

  return {
    profiles,
    nearestLaneHeight(q, within) {
      let bestD = within;
      let bestH: number | null = null;
      for (const prof of profiles) {
        for (let i = 0; i + 1 < prof.points.length; i++) {
          const a = prof.points[i]!;
          const b = prof.points[i + 1]!;
          const c = V.closestOnSegment(q, a, b);
          const d = V.dist(q, c.point);
          if (d >= bestD) continue;
          bestD = d;
          bestH = prof.heights[i]! + (prof.heights[i + 1]! - prof.heights[i]!) * c.t;
        }
      }
      return bestH;
    },
  };
}

export interface GradeViolation {
  edge: number;
  cls: RoadClass;
  gradient: number;
  limit: number;
  length: number;
}

/**
 * Every road steeper than its class allows.
 *
 * Written against the finished network rather than inside the solver, in the
 * same spirit as `RoadClearance.clearanceViolations`: the test that matters is
 * one that would still catch a regression after the generator is replaced. The
 * solver is *supposed* to guarantee this; the point of the detector is that
 * nothing has to take its word for it.
 */
export function gradeViolations(
  net: RoadNetwork,
  heights: RoadHeights,
  p: RoadParams,
  tolerance = 1e-3,
): GradeViolation[] {
  if (heights.flat) return [];
  const out: GradeViolation[] = [];
  for (const e of net.edges) {
    const a = net.graph.node(e.a).p;
    const b = net.graph.node(e.b).p;
    const len = V.dist(a, b);
    if (len < 0.5) continue;
    const grade = Math.abs(heights.at(e.b) - heights.at(e.a)) / len;
    const limit = p.growth.maxGradient[e.cls];
    if (grade <= limit + tolerance) continue;
    out.push({ edge: e.id, cls: e.cls, gradient: grade, limit, length: len });
  }
  return out;
}

export function describeGradeViolation(net: RoadNetwork, v: GradeViolation): string {
  const e = net.edgeById.get(v.edge);
  const a = e ? net.graph.node(e.a).p : { x: 0, y: 0 };
  const b = e ? net.graph.node(e.b).p : { x: 0, y: 0 };
  const at = (q: Vec2) => `(${q.x.toFixed(0)}, ${q.y.toFixed(0)})`;
  return (
    `${v.cls} ${at(a)}–${at(b)}, ${v.length.toFixed(0)} m: ` +
    `${(v.gradient * 100).toFixed(1)}% > ${(v.limit * 100).toFixed(0)}%`
  );
}
