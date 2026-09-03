import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import type { RoadNetwork } from './Roads.js';

/**
 * The land a road occupies — defined once, for everyone who needs it.
 *
 * There used to be five answers to that question, with three different half
 * widths between them: `props/Ground.ts` drew `width / 2`, `city/Lots.ts` took
 * `width / 2 + gutter` off the block, `clipToRoads` took `width / 2 + gutter −
 * 0.02`, and `test/overlap.test.ts` and `test/parcels.test.ts` each carried a
 * copy with a comment saying it had to mirror the renderer exactly. Five copies
 * of a rectangle is not a duplication problem, it is a *correctness* problem:
 * the gaps this module was written to find are precisely the places where two
 * of those answers disagreed, and no overlay drawn from a sixth copy could have
 * shown them.
 *
 * Two shapes, deliberately distinguished:
 *
 * - **Drawn** — the asphalt and kerb that actually appear on screen.
 * - **Right of way** — what a lot is set back by: the same carriageway plus the
 *   側溝 either side. It is always the wider of the two, and the difference
 *   between them is one gutter width. Anywhere it is visibly more than that,
 *   something upstream has taken land off a block that no road ever wanted.
 */

/** Half the drawn carriageway. */
export const drawnHalfWidth = (width: number): number => width / 2;

/** Half the right of way: carriageway plus a gutter each side. */
export const rightOfWayHalfWidth = (width: number, gutter: number): number => width / 2 + gutter;

/**
 * How far a ribbon runs past its own node so that two ribbons meeting at a
 * junction close the corner between them.
 *
 * Nine tenths of a half width, which is what `props/Ground.ts` has always
 * drawn. It is applied only where there is a second ribbon to close against —
 * at a dead end the node *is* the extent of the land taken from the lots, and
 * running past it puts asphalt on somebody's garden.
 */
export const JUNCTION_OVERSHOOT = 0.9;

/**
 * The direction to lay a ribbon along, when it is not simply `b - a`.
 *
 * A block edge is attributed to a road and then takes the *road's* frame rather
 * than its own — see `Blocks.attributeEdges`: face extraction and cleanup shift
 * a block edge by a fraction of a degree, differently for each one, and that
 * fraction propagates all the way to which way a house points. The right of way
 * taken off the block has to be laid along the same frame the frontage is, or
 * the strip and the frontage line it is supposed to sit behind diverge.
 */
export interface RibbonFrame {
  dir: Vec2;
  /** Perpendicular to `dir`. Sign is irrelevant — the ribbon is symmetric. */
  normal: Vec2;
}

/** Which ends of a ribbon run past their node. */
export interface RibbonEnds {
  start: boolean;
  end: boolean;
}

/**
 * The rectangle a straight run of road covers.
 *
 * `overshoot` is in metres per end rather than a flag, because the two callers
 * want different amounts of it: the renderer closes a junction corner with
 * `0.9 · half`, while the right of way overshoots by a full half width so that
 * strips meet cleanly at a block corner and cover the junction spill.
 */
export function ribbon(
  a: Vec2,
  b: Vec2,
  half: number,
  overshoot: { start: number; end: number },
  frame?: RibbonFrame,
): Polygon | null {
  // Where the caller supplies a frame it has already decided which way the
  // ribbon runs, so a short segment is not a problem — a 0.15 m block edge
  // attributed to an arterial still has that arterial's right of way over it,
  // and dropping it would leave a notch in the setback.
  let dir: Vec2;
  let n: Vec2;
  if (frame) {
    dir = frame.dir;
    n = frame.normal;
  } else {
    const d = V.sub(b, a);
    const l = V.len(d);
    // Shorter than this and the direction is noise, so the rectangle would be
    // pointed in an arbitrary direction rather than along the road.
    if (l < 0.2) return null;
    dir = V.scale(d, 1 / l);
    n = V.perp(dir);
  }
  const a2 = V.addScaled(a, dir, -overshoot.start);
  const b2 = V.addScaled(b, dir, overshoot.end);
  return [
    V.addScaled(a2, n, -half),
    V.addScaled(b2, n, -half),
    V.addScaled(b2, n, half),
    V.addScaled(a2, n, half),
  ];
}

/** The asphalt-and-kerb rectangle `props/Ground.ts` draws for one road edge. */
export function drawnRibbon(a: Vec2, b: Vec2, width: number, ends: RibbonEnds): Polygon | null {
  const half = drawnHalfWidth(width);
  const over = half * JUNCTION_OVERSHOOT;
  return ribbon(a, b, half, { start: ends.start ? over : 0, end: ends.end ? over : 0 });
}

/**
 * The right of way of one road: what a lot beside it is set back by.
 *
 * `shrink` pulls the strip in by a hair. `Lots.clipToRoads` needs it and says
 * why: a correctly-placed lot boundary lies exactly on the strip edge, and
 * coincident edges are what `polygon-clipping` is worst at — on the grid layout
 * every lot line lay on one, the clipper threw, and the retry turned a one
 * second subdivision into thirteen.
 */
export function rightOfWayStrip(
  a: Vec2,
  b: Vec2,
  width: number,
  gutter: number,
  shrink = 0,
  frame?: RibbonFrame,
): Polygon | null {
  const half = rightOfWayHalfWidth(width, gutter) - shrink;
  return ribbon(a, b, half, { start: half, end: half }, frame);
}

/** How many roads meet at each node — whether a ribbon has anything to close against. */
export function nodeDegrees(net: RoadNetwork): Map<number, number> {
  const degree = new Map<number, number>();
  for (const e of net.edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  return degree;
}

/** A 私道 drawn station by station, the way `props/Ground.ts` draws it. */
export interface LaneStations {
  points: readonly Vec2[];
  width: number;
}

/**
 * Every rectangle of asphalt in the town.
 *
 * Pass `laneStations` (from `city.laneHeights.profiles`) to get the 私道 as the
 * renderer actually lays them — a chain of short ribbons that follows the land.
 * Without it they come out as one straight rectangle end to end, which is what
 * the road network alone knows about them.
 */
export function drawnRoadSurfaces(
  net: RoadNetwork,
  laneStations?: readonly LaneStations[],
): Polygon[] {
  const degree = nodeDegrees(net);
  const out: Polygon[] = [];
  for (const e of net.edges) {
    const r = drawnRibbon(net.graph.node(e.a).p, net.graph.node(e.b).p, e.width, {
      start: (degree.get(e.a) ?? 0) > 1,
      end: (degree.get(e.b) ?? 0) > 1,
    });
    if (r) out.push(r);
  }
  // A lane never overshoots: both its ends are the extent of the land taken
  // from the lots behind it.
  if (laneStations) {
    for (const prof of laneStations) {
      for (let i = 0; i + 1 < prof.points.length; i++) {
        const r = drawnRibbon(prof.points[i]!, prof.points[i + 1]!, prof.width, {
          start: false,
          end: false,
        });
        if (r) out.push(r);
      }
    }
  } else {
    for (const lane of net.privateLanes) {
      const r = drawnRibbon(lane.a, lane.b, lane.width, { start: false, end: false });
      if (r) out.push(r);
    }
  }
  return out;
}

/** Every rectangle of right of way in the town — roads and 私道 alike. */
export function rightOfWaySurfaces(net: RoadNetwork, gutter: number, shrink = 0): Polygon[] {
  const out: Polygon[] = [];
  for (const e of net.edges) {
    const s = rightOfWayStrip(
      net.graph.node(e.a).p,
      net.graph.node(e.b).p,
      e.width,
      gutter,
      shrink,
    );
    if (s) out.push(s);
  }
  for (const lane of net.privateLanes) {
    const s = rightOfWayStrip(lane.a, lane.b, lane.width, gutter, shrink);
    if (s) out.push(s);
  }
  return out;
}
