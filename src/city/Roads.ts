import type { Vec2 } from '../core/types.js';
import type { RoadParams } from '../core/params.js';
import { makeFbm, makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { makePlanar, PlanarGraph } from '../geom/planarGraph.js';

/**
 * Road network generation.
 *
 * A pure Voronoi layout reads as medieval European; a pure grid reads as
 * American. Japanese suburbs are locally griddy but globally wobbly, with lots
 * of dead ends, more T-junctions than crossroads, and uneven street widths. The
 * generator targets that shape specifically: a regular grid built in a *warped*
 * parameter space, then thinned, stubbed and jogged.
 */

export type RoadClass = 'arterial' | 'collector' | 'local' | 'private';

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

/** Catmull-Rom through the control points, resampled at roughly `step`. */
function catmullRom(points: Vec2[], step: number): Vec2[] {
  if (points.length < 2) return points.slice();
  const pts = [points[0]!, ...points, points[points.length - 1]!];
  const out: Vec2[] = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2]!;
    const n = Math.max(2, Math.ceil(V.dist(p1, p2) / step));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Split a polyline into the runs that lie inside the square [-e, e]^2. */
function clipToSquare(line: Vec2[], e: number): Vec2[][] {
  const inside = (p: Vec2) => Math.abs(p.x) <= e && Math.abs(p.y) <= e;
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of line) {
    if (inside(p)) cur.push(p);
    else {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

export function generateRoads(seed: string, p: RoadParams): RoadNetwork {
  const rng = makeRng(subSeed(seed, 'roads'));
  const E = p.extent;

  // Two octaves of warp, with independent fields per axis so the grid shears
  // rather than merely translating.
  const wx1 = makeFbm(subSeed(seed, 'roads', 'wx1'), 1);
  const wy1 = makeFbm(subSeed(seed, 'roads', 'wy1'), 1);
  const wx2 = makeFbm(subSeed(seed, 'roads', 'wx2'), 1);
  const wy2 = makeFbm(subSeed(seed, 'roads', 'wy2'), 1);

  const warp = (u: number, v: number): Vec2 => ({
    x:
      u +
      wx1(u / p.warpWavelength1, v / p.warpWavelength1) * p.warpAmplitude1 +
      wx2(u / p.warpWavelength2, v / p.warpWavelength2) * p.warpAmplitude2,
    y:
      v +
      wy1(u / p.warpWavelength1, v / p.warpWavelength1) * p.warpAmplitude1 +
      wy2(u / p.warpWavelength2, v / p.warpWavelength2) * p.warpAmplitude2,
  });

  const pending: { a: Vec2; b: Vec2; cls: RoadClass }[] = [];
  const push = (a: Vec2, b: Vec2, cls: RoadClass) => {
    if (V.dist(a, b) > 1e-6) pending.push({ a, b, cls });
  };
  const pushLine = (line: Vec2[], cls: RoadClass) => {
    for (let i = 0; i + 1 < line.length; i++) push(line[i]!, line[i + 1]!, cls);
  };

  // --- 1. Arterials --------------------------------------------------------
  const arterials: Vec2[][] = [];
  for (let i = 0; i < p.arterialCount; i++) {
    const horizontal = i % 2 === 0;
    const offset = rng.range(-E * 0.4, E * 0.4);
    const ctrl: Vec2[] = [];
    const steps = 5;
    for (let s = 0; s <= steps; s++) {
      const t = -E * 1.15 + (s / steps) * E * 2.3;
      const wobble = offset + rng.gauss(0, E * 0.07);
      ctrl.push(horizontal ? { x: t, y: wobble } : { x: wobble, y: t });
    }
    const line = catmullRom(ctrl, 8);
    arterials.push(line);
    for (const run of clipToSquare(line, E)) pushLine(run, 'arterial');
  }

  // The station sits on an arterial, biased toward the middle of the town.
  const host = arterials[0];
  const station =
    host && host.length > 0
      ? host[Math.min(host.length - 1, Math.floor(host.length * rng.range(0.35, 0.65)))]!
      : { x: 0, y: 0 };

  // --- 2. Collectors -------------------------------------------------------
  const nCollectors = Math.max(2, Math.round((E * 2) / p.collectorSpacing));
  for (let i = 0; i <= nCollectors; i++) {
    const horizontal = i % 2 === 1;
    const base = -E + ((i + 0.5) / (nCollectors + 1)) * E * 2;
    const ctrl: Vec2[] = [];
    for (let s = 0; s <= 4; s++) {
      const t = -E * 1.1 + (s / 4) * E * 2.2;
      ctrl.push(horizontal ? { x: t, y: base + rng.gauss(0, 9) } : { x: base + rng.gauss(0, 9), y: t });
    }
    for (const run of clipToSquare(catmullRom(ctrl, 10), E)) pushLine(run, 'collector');
  }

  // --- 3. Local streets: the warped grid ----------------------------------
  const S = p.localSpacing;
  const nu = Math.ceil((E * 2) / S);
  const nv = Math.ceil((E * 2) / S);

  const grid: Vec2[][] = [];
  for (let j = 0; j <= nv; j++) {
    const row: Vec2[] = [];
    for (let i = 0; i <= nu; i++) row.push(warp(-E + i * S, -E + j * S));
    grid.push(row);
  }

  // 3a. Jog interior grid nodes *before* building edges, so a displaced vertex
  // turns its crossroads into a pair of offset T-junctions. Displacing the
  // shared vertex is what actually produces the staggered junctions Japanese
  // local grids are full of.
  for (let j = 1; j < nv; j++) {
    for (let i = 1; i < nu; i++) {
      if (!rng.chance(p.jogFraction)) continue;
      const dir = rng.chance(0.5) ? { x: 1, y: 0 } : { x: 0, y: 1 };
      const d = rng.range(p.jogDistance * 0.6, p.jogDistance) * (rng.chance(0.5) ? 1 : -1);
      grid[j]![i] = V.addScaled(grid[j]![i]!, dir, d);
    }
  }

  // 3b. Emit grid edges, deleting a fraction and truncating some into dead ends.
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const a = grid[j]![i]!;
      const neighbours: Vec2[] = [];
      if (i < nu) neighbours.push(grid[j]![i + 1]!);
      if (j < nv) neighbours.push(grid[j + 1]![i]!);
      for (const b0 of neighbours) {
        if (rng.chance(p.deleteFraction)) continue;
        const b = rng.chance(p.deadEndFraction) ? V.lerp(a, b0, rng.range(0.6, 0.7)) : b0;
        if (V.dist(a, b) >= p.minEdgeLength) push(a, b, 'local');
      }
    }
  }

  // --- 4. Build the graph, planarise, clean -------------------------------
  const raw = new PlanarGraph(p.nodeSnap);
  for (const seg of pending) {
    raw.addSegment(seg.a, seg.b, { cls: seg.cls, width: roadWidth(seg.cls, p) } satisfies RoadEdgeData);
  }
  const planar = makePlanar(raw, p.nodeSnap);

  // Splitting produces short fragments; drop the local ones, which would
  // otherwise become slivers of block boundary.
  const trimmed = new PlanarGraph(p.nodeSnap);
  for (const e of planar.edges) {
    const data = e.data as RoadEdgeData | undefined;
    const cls = data?.cls ?? 'local';
    const a = planar.node(e.a).p;
    const b = planar.node(e.b).p;
    if (cls === 'local' && V.dist(a, b) < 6) continue;
    trimmed.addSegment(a, b, { cls, width: roadWidth(cls, p) } satisfies RoadEdgeData);
  }

  // Rebuilding snapped nodes together again, which can reintroduce a crossing
  // that the first pass had resolved. Planarise once more so face extraction
  // gets a genuinely planar graph — a single stray crossing produces
  // overlapping "blocks" and the failure is visually baffling.
  const graph = makePlanar(trimmed, p.nodeSnap * 0.4);

  const edges: RoadEdge[] = graph.edges.map((e) => {
    const data = e.data as RoadEdgeData | undefined;
    return {
      id: e.id,
      a: e.a,
      b: e.b,
      cls: data?.cls ?? 'local',
      width: data?.width ?? p.localWidth,
    };
  });

  return {
    graph,
    edges,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    station,
    extent: E,
    privateLanes: [],
  };
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
