import type { Vec2 } from '../core/types.js';
import type { RoadParams } from '../core/params.js';
import { makeFbm, makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { makePlanar, PlanarGraph } from '../geom/planarGraph.js';

/**
 * Road network generation, in two flavours.
 *
 * `warped` — a pure Voronoi layout reads as medieval European; a pure grid
 * reads as American. Japanese suburbs are locally griddy but globally wobbly,
 * with lots of dead ends, more T-junctions than crossroads, and uneven street
 * widths. This layout targets that shape specifically: a regular grid built in
 * a *warped* parameter space, then thinned, stubbed and jogged.
 *
 * `grid` — the 区画整理 alternative. A complete orthogonal grid, every street
 * running the full width of the town, with the spacing between neighbouring
 * streets varying by ±`gridSpacingVariation`, plus a couple of diagonal
 * through-roads. Nothing is deleted and nothing dead-ends.
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

/** Resample a two-point line so `clipToSquare` has points to work with. */
function resampleLine(line: Vec2[], step: number): Vec2[] {
  const a = line[0]!;
  const b = line[line.length - 1]!;
  const n = Math.max(2, Math.ceil(V.dist(a, b) / step));
  return Array.from({ length: n + 1 }, (_, i) => V.lerp(a, b, i / n));
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

type PushLine = (line: Vec2[], cls: RoadClass) => void;

/**
 * Positions of the grid lines along one axis, spanning [-e, e], with every gap
 * drawn independently within ±`variation` of `spacing`.
 *
 * The gaps are rescaled to land exactly on both town edges. That keeps the
 * *relative* variation between neighbouring streets — which is what reads as
 * "a grid that was fitted to existing parcels" — without letting the accumulated
 * error decide how far the last street ends up from the boundary.
 */
function gridLines(rng: Rng, e: number, spacing: number, variation: number): number[] {
  const n = Math.max(2, Math.round((e * 2) / spacing));
  const gaps = Array.from({ length: n }, () => spacing * (1 + rng.range(-variation, variation)));
  const scale = (e * 2) / gaps.reduce((s, g) => s + g, 0);
  const pos: number[] = [-e];
  for (let i = 0; i < n; i++) pos.push(pos[i]! + gaps[i]! * scale);
  pos[n] = e;
  return pos;
}

/**
 * Assign a road class to each grid line: collectors roughly every
 * `collectorSpacing`, one of the central ones promoted to an arterial, the rest
 * local. In a planned layout the hierarchy has to live *on* the grid lines —
 * a separately drawn arterial would slice every block it crossed into slivers.
 */
function classifyLines(rng: Rng, count: number, arterials: number, p: RoadParams): RoadClass[] {
  const cls: RoadClass[] = Array.from({ length: count }, () => 'local');
  const step = Math.max(2, Math.round(p.collectorSpacing / p.localSpacing));
  const phase = rng.int(step);
  for (let i = 0; i < count; i++) if ((i + phase) % step === 0) cls[i] = 'collector';

  for (let k = 0; k < arterials; k++) {
    // Prefer a collector near the middle: an arterial hugging the town edge
    // would have nothing on one side of it.
    const target = (count - 1) / 2 + rng.range(-1.5, 1.5);
    let best = -1;
    for (let i = 1; i < count - 1; i++) {
      if (cls[i] !== 'collector') continue;
      if (best < 0 || Math.abs(i - target) < Math.abs(best - target)) best = i;
    }
    if (best < 0) break;
    cls[best] = 'arterial';
  }
  return cls;
}

/** The planned layout: a complete grid, both axes, nothing removed. */
function plannedStreets(p: RoadParams, rng: Rng, pushLine: PushLine): Vec2 {
  const E = p.extent;
  const perAxis = Math.max(0, Math.round(p.arterialCount / 2));
  const xs = gridLines(rng, E, p.localSpacing, p.gridSpacingVariation);
  const ys = gridLines(rng, E, p.localSpacing, p.gridSpacingVariation);
  const xCls = classifyLines(rng, xs.length, perAxis, p);
  const yCls = classifyLines(rng, ys.length, perAxis, p);

  // Full-width streets on both axes; `makePlanar` splits them at the crossings.
  for (let i = 0; i < xs.length; i++) {
    pushLine([{ x: xs[i]!, y: -E }, { x: xs[i]!, y: E }], xCls[i]!);
  }
  for (let j = 0; j < ys.length; j++) {
    pushLine([{ x: -E, y: ys[j]! }, { x: E, y: ys[j]! }], yCls[j]!);
  }

  // The station sits on the east–west arterial, off-centre along it.
  const ay = ys[yCls.indexOf('arterial')] ?? 0;
  return { x: rng.range(-E * 0.45, E * 0.45), y: ay };
}

/** The organic layout: wandering arterials over a warped, thinned grid. */
function warpedStreets(
  seed: string,
  p: RoadParams,
  rng: Rng,
  push: (a: Vec2, b: Vec2, cls: RoadClass) => void,
  pushLine: PushLine,
): Vec2 {
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
      const jitter = rng.gauss(0, 9);
      ctrl.push(horizontal ? { x: t, y: base + jitter } : { x: base + jitter, y: t });
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
      if (p.jogFraction <= 0 || !rng.chance(p.jogFraction)) continue;
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

  return station;
}

export function generateRoads(seed: string, p: RoadParams): RoadNetwork {
  const rng = makeRng(subSeed(seed, 'roads'));
  const E = p.extent;

  const pending: { a: Vec2; b: Vec2; cls: RoadClass }[] = [];
  const push = (a: Vec2, b: Vec2, cls: RoadClass) => {
    if (V.dist(a, b) > 1e-6) pending.push({ a, b, cls });
  };
  const pushLine: PushLine = (line, cls) => {
    for (let i = 0; i + 1 < line.length; i++) push(line[i]!, line[i + 1]!, cls);
  };

  const station =
    p.layout === 'grid'
      ? plannedStreets(p, rng, pushLine)
      : warpedStreets(seed, p, rng, push, pushLine);

  // --- Diagonal through-roads ---------------------------------------------
  // A plain grid on its own reads as a chessboard. A couple of straight
  // diagonals right across it are what real planned Japanese developments have
  // (usually an older road the grid was laid out around), and they give the lot
  // subdivider genuinely non-rectangular blocks to work with without
  // reintroducing the fine-grained wobble. The signs alternate so two diagonals
  // cross rather than running side by side.
  const flip = rng.chance(0.5) ? 1 : -1;
  for (let i = 0; i < p.diagonalCount; i++) {
    const sign = i % 2 === 0 ? flip : -flip;
    const angle = rng.range(28, 62) * (Math.PI / 180) * sign;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    // Offset perpendicular to the line so the diagonals are spread apart
    // instead of both landing near the middle.
    const t = p.diagonalCount > 1 ? (i / (p.diagonalCount - 1)) * 2 - 1 : 0;
    const through = V.addScaled({ x: 0, y: 0 }, V.perp(dir), t * E * 0.4 + rng.jitter(E * 0.12));
    const line = [V.addScaled(through, dir, -E * 2), V.addScaled(through, dir, E * 2)];
    for (const run of clipToSquare(resampleLine(line, 12), E)) pushLine(run, 'collector');
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
