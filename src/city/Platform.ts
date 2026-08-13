import type { Vec2 } from '../core/types.js';
import type { PlatformParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import type { Terrain } from '../terrain/Terrain.js';
import type { LaneHeights, RoadHeights } from './RoadProfile.js';
import type { RoadNetwork } from './Roads.js';
import type { Lot } from './Lots.js';

/**
 * 造成 — how a lot is levelled into the slope, and what holds the result up.
 *
 * Split from the geometry that draws it for the same reason `planBuildings` was
 * split out of the mesh builder: a headless caller has to be able to ask whether
 * a platform is supported without a WebGL context. `test/platform.test.ts` reads
 * these structures, not triangles.
 *
 * Two decisions carry the whole look:
 *
 * **The pad is levelled to the street, not to the ground.** A Japanese house
 * sits at the height of the road it fronts, plus a plinth and maybe a step or
 * two — never at the mean of the hillside it happens to occupy. Since the road
 * profile is already solved, this comes almost free.
 *
 * **Pad heights snap to a stair riser.** That is what turns a row of lots down a
 * sloping street into a staircase of level platforms with walls between them —
 * 雛壇造成 — rather than a smooth ramp of subtly tilted gardens. Without the
 * quantisation the walls all come out different heights by a few centimetres and
 * the whole hillside reads as melted.
 */

export interface PlatformEdge {
  /** Index of the lot boundary edge this describes. */
  i: number;
  kind: 'wall' | 'batter' | 'flush';
  /** Pad height minus ground height at the edge midpoint. Positive = fill. */
  drop: number;
  /** Largest |drop| anywhere along the edge — what the wall has to cover. */
  worst: number;
}

export interface LotPlatform {
  /** Height of the levelled platform. */
  padY: number;
  /** Design height of the road at the primary frontage. */
  streetY: number;
  edges: PlatformEdge[];
  /** Risers from the street up (or down) to the pad. */
  steps: number;
  /** Rough earthwork volumes, for the statistics printout. */
  cut: number;
  fill: number;
}

/** A lot on flat ground: everything at zero, nothing to hold up. */
export const FLAT_PLATFORM: LotPlatform = {
  padY: 0,
  streetY: 0,
  edges: [],
  steps: 0,
  cut: 0,
  fill: 0,
};

const SAMPLES_PER_EDGE = 5;

export function assignPlatforms(
  lots: Lot[],
  net: RoadNetwork,
  terrain: Terrain,
  heights: RoadHeights,
  lanes: LaneHeights,
  p: PlatformParams,
): void {
  if (!p.enabled || heights.flat) {
    for (const lot of lots) lot.platform = FLAT_PLATFORM;
    return;
  }
  for (const lot of lots) lot.platform = computePlatform(lot, net, terrain, heights, lanes, p);
}

export function computePlatform(
  lot: Lot,
  net: RoadNetwork,
  terrain: Terrain,
  heights: RoadHeights,
  lanes: LaneHeights,
  p: PlatformParams,
): LotPlatform {
  const streetY = frontageHeight(lot, net, heights, lanes, terrain);
  const ground = terrain.extremesOver(lot.polygon, 3);

  // Level to the street, within a cut and a fill the site could plausibly take,
  // then raise by the plinth and snap to a riser.
  const wanted = ground.mean + p.plinth;
  const clamped = Math.min(
    streetY + p.maxRiseAboveStreet,
    Math.max(streetY - p.maxCutBelowStreet, wanted),
  );
  const padY = Math.round(clamped / p.riserQuantum) * p.riserQuantum;

  const edges: PlatformEdge[] = [];
  let cut = 0;
  let fill = 0;
  const n = lot.polygon.length;
  for (let i = 0; i < n; i++) {
    const a = lot.polygon[i]!;
    const b = lot.polygon[(i + 1) % n]!;
    let worst = 0;
    let sum = 0;
    for (let k = 0; k <= SAMPLES_PER_EDGE; k++) {
      const q = V.lerp(a, b, k / SAMPLES_PER_EDGE);
      const d = padY - terrain.heightAtXY(q.x, q.y);
      if (Math.abs(d) > Math.abs(worst)) worst = d;
      sum += d;
    }
    const drop = sum / (SAMPLES_PER_EDGE + 1);
    const len = V.dist(a, b);
    if (drop > 0) fill += drop * len;
    else cut -= drop * len;

    const kind: PlatformEdge['kind'] =
      Math.abs(worst) >= p.wallMin ? 'wall' : Math.abs(worst) >= 0.12 ? 'batter' : 'flush';
    edges.push({ i, kind, drop, worst });
  }

  const rise = padY - streetY;
  const steps = Math.abs(rise) > 0.35 ? Math.max(1, Math.ceil(Math.abs(rise) / p.stepRiser)) : 0;
  return { padY, streetY, edges, steps, cut, fill };
}

/**
 * The design height of the road at the lot's primary frontage.
 *
 * A lot fronting a 私道 is levelled to the *lane*, which now has a profile of its
 * own. It used to borrow the height of whatever road was within 30 m — the same
 * borrowing that put the lane itself inside the hill — so a house behind a block
 * could be levelled to a street it does not front and cannot see.
 */
function frontageHeight(
  lot: Lot,
  net: RoadNetwork,
  heights: RoadHeights,
  lanes: LaneHeights,
  terrain: Terrain,
): number {
  const f = lot.frontages[0];
  if (!f) return terrain.heightAtXY(lot.centroid.x, lot.centroid.y);

  if (f.roadEdgeId !== null) {
    const e = net.edgeById.get(f.roadEdgeId);
    if (e) {
      const a = net.graph.node(e.a).p;
      const b = net.graph.node(e.b).p;
      const t = projectOnto(f.mid, a, b);
      return heights.alongEdge(e, t);
    }
  }
  // Half the lane width plus the setback the subdivider left, with a little to
  // spare: far enough to find the lane in front, not far enough to reach the
  // next street over.
  const onLane = lanes.nearestLaneHeight(f.mid, 8);
  if (onLane !== null) return onLane;
  const near = heights.nearestRoadHeight(f.mid, 30);
  return near ?? terrain.heightAtXY(f.mid.x, f.mid.y);
}

function projectOnto(p: Vec2, a: Vec2, b: Vec2): number {
  return V.closestOnSegment(p, a, b).t;
}
