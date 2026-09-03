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

/**
 * The rectangle a straight run of road covers.
 *
 * `overshoot` is in metres per end rather than a flag, because the two callers
 * want different amounts of it: the renderer stops the carriageway short of a
 * junction and lets `junctionPlate` fill it (so the overshoot is *negative*),
 * while the right of way overshoots by a full half width so that strips meet
 * cleanly at a block corner and cover the junction spill.
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

// --- Junctions --------------------------------------------------------------

/**
 * Roads used to be drawn as rectangles that ran *past* their own node — nine
 * tenths of a half width — and every junction was however many of those
 * happened to overlap. It is worth writing down what that cost, because all
 * three of the things wrong with a junction came out of the same decision:
 *
 * - **The 側溝 crossed the road.** A ribbon carries a pale concrete gutter along
 *   each of its edges for its whole length, overshoot included, so every arm
 *   drew two kerb strips straight across the mouth of every other arm. From the
 *   air an intersection was a lattice of kerbs, which is the single most visible
 *   thing wrong with it.
 * - **The overshoot was the road's own half width**, which is the wrong road's.
 *   The land a junction has to cover is set by what you are crossing, not by
 *   your own width: a 4 m lane meeting a 12 m arterial needed to run 6 m back to
 *   close the corner and ran 1.8, leaving a notch of bare ground; the arterial
 *   ending at that lane needed 2 m and ran 5.4, laying asphalt over the garden
 *   behind it.
 * - **The arms cut through each other.** Each ribbon is a plane through its two
 *   nodes' design heights, so two arms of different gradient meeting at a
 *   junction agree only at the node and diverge from there — on a 14% street
 *   that is most of a metre of one road standing proud of the other, in the
 *   middle of the intersection.
 *
 * So the carriageway now *stops short* of a junction and the junction itself is
 * one polygon: a fan from the node out to each arm's end edge. The plate meets
 * every arm exactly, because its boundary vertices are that arm's own two
 * corners at that arm's own height — there is nothing left to overlap, and
 * nothing left to z-fight.
 */

/** One road as seen from a node it meets. */
export interface JunctionArm {
  edgeId: number;
  /** Unit direction leading away from the node. */
  dir: Vec2;
  /** Half the carriageway of this arm. */
  half: number;
  /** How far from the node this arm's asphalt starts. */
  trim: number;
  /** The node at the far end, for whoever needs the arm's gradient. */
  far: number;
  /** Distance to the far node. */
  len: number;
}

/** Every arm of one junction, ordered anticlockwise. */
export interface Junction {
  node: number;
  p: Vec2;
  arms: JunctionArm[];
}

/** How far each end of each edge is held back, by edge id. */
export type RibbonTrims = Map<number, { start: number; end: number }>;

/**
 * The shortest piece of carriageway worth drawing between two junctions.
 *
 * Where two nodes are closer together than their junction radii the plates
 * already overlap and cover the ground between them, so the ribbon has nothing
 * left to do; below this the trims are scaled back rather than allowed to cross.
 */
const MIN_RIBBON = 0.5;

export function planJunctions(net: RoadNetwork): { junctions: Junction[]; trims: RibbonTrims } {
  interface Incident {
    edgeId: number;
    dir: Vec2;
    half: number;
    far: number;
    len: number;
  }
  const incident = new Map<number, Incident[]>();
  const push = (node: number, i: Incident): void => {
    const list = incident.get(node);
    if (list) list.push(i);
    else incident.set(node, [i]);
  };

  for (const e of net.edges) {
    const pa = net.graph.node(e.a).p;
    const pb = net.graph.node(e.b).p;
    const len = V.dist(pa, pb);
    if (len < 1e-6) continue;
    const dir = V.scale(V.sub(pb, pa), 1 / len);
    const half = drawnHalfWidth(e.width);
    push(e.a, { edgeId: e.id, dir, half, far: e.b, len });
    push(e.b, { edgeId: e.id, dir: V.neg(dir), half, far: e.a, len });
  }

  // The radius of a junction is set by the *widest* road in it: every arm has to
  // reach the far kerb of whatever it crosses, and they all have to stop at the
  // same distance or the plate would have to fill an L-shaped hole.
  const radius = new Map<number, number>();
  for (const [node, list] of incident) {
    if (list.length < 2) continue; // A dead end is the end of the asphalt.
    let r = 0;
    for (const i of list) r = Math.max(r, i.half);
    radius.set(node, r);
  }

  const trims: RibbonTrims = new Map();
  for (const e of net.edges) {
    const len = V.dist(net.graph.node(e.a).p, net.graph.node(e.b).p);
    let start = radius.get(e.a) ?? 0;
    let end = radius.get(e.b) ?? 0;
    const room = len - MIN_RIBBON;
    if (start + end > room) {
      const k = Math.max(0, room) / (start + end);
      start *= k;
      end *= k;
    }
    trims.set(e.id, { start, end });
  }

  const junctions: Junction[] = [];
  for (const [node, list] of incident) {
    if (list.length < 2) continue;
    const arms = list
      .map((i) => {
        const t = trims.get(i.edgeId)!;
        const edge = net.edgeById.get(i.edgeId)!;
        return { ...i, trim: edge.a === node ? t.start : t.end };
      })
      .sort((x, y) => V.angleOf(x.dir) - V.angleOf(y.dir));
    junctions.push({ node, p: net.graph.node(node).p, arms });
  }
  return { junctions, trims };
}

/**
 * The smallest trim that still gives an arm two distinguishable corners.
 *
 * An arm held back by nothing has both of its corners on the node, and a fan
 * built through them is degenerate. Half a metre is under the tolerance of
 * anything that measures this and keeps the plate a polygon.
 */
const MIN_PLATE_REACH = 0.5;

/**
 * How far out a mitre is allowed to run, as a multiple of the junction radius.
 *
 * Two arms leaving a node at a narrow angle have kerb lines that meet a long
 * way off, and following them there would draw a spike of asphalt down the gap
 * between two roads. Past this the corner is chamfered instead, which is what a
 * real 隅切り is.
 */
const MITRE_LIMIT = 2.2;

/** How far along an arm its end edge sits, as the plate sees it. */
export const plateReach = (arm: JunctionArm): number => Math.max(arm.trim, MIN_PLATE_REACH);

/** The junction's asphalt, and where each of its vertices got its height from. */
export interface JunctionPlate {
  ring: Polygon;
  /**
   * Per vertex, the two arms whose grades it sits between and how far along
   * them it is. A vertex on one arm's end edge names that arm twice with
   * `f = 1`; one on its kerb beside the node names it twice with `f = 0`; a
   * mitre names the arms either side of it.
   */
  from: { a: number; b: number; f: number }[];
}

/**
 * The asphalt of one junction: the convex hull of every arm's two end corners,
 * of the mitres between them, and of the node itself.
 *
 * Every arm's end edge is inside the hull by construction — both of its
 * endpoints are hull inputs — so the plate always meets the carriageway it is
 * filling in for, whatever the arms are doing. That is the whole reason for the
 * hull rather than the obvious thing, which is to walk the arms in angular order
 * and join them up: two arms 40° apart and wider than they are trimmed have
 * *interleaved* corners, and a ring in that order crosses itself.
 *
 * The mitre is not decoration either. Without it the hull runs straight from one
 * arm's corner to the next's, and on the *outside* of a bend that chord cuts
 * across the carriageway itself — a road turning a right angle would lose the
 * outer quarter of its own corner. Where two kerbs meet too far out to be a
 * corner, which is what a narrow fork does, the chord is what is wanted after
 * all, and `MITRE_LIMIT` is what chooses between them.
 */
export function junctionPlate(j: Junction): JunctionPlate | null {
  if (j.arms.length < 2) return null;
  let radius = 0;
  for (const arm of j.arms) radius = Math.max(radius, arm.half, plateReach(arm));

  const pts: { p: Vec2; a: number; b: number; f: number }[] = [];
  const ends = j.arms.map((arm, i) => {
    const end = V.addScaled(j.p, arm.dir, plateReach(arm));
    const n = V.perp(arm.dir);
    pts.push(
      { p: V.addScaled(end, n, -arm.half), a: i, b: i, f: 1 },
      { p: V.addScaled(end, n, arm.half), a: i, b: i, f: 1 },
      // And the same kerbs back at the node. Without these the hull is only the
      // wedge its arms happen to span: two arms 40° apart both point the same
      // way, and the hull edge from the node out to one of them cuts a triangle
      // off that arm's own carriageway.
      { p: V.addScaled(j.p, n, -arm.half), a: i, b: i, f: 0 },
      { p: V.addScaled(j.p, n, arm.half), a: i, b: i, f: 0 },
    );
    return { n };
  });
  // The node itself, so a hairpin's tip is inside the plate rather than behind
  // the chord across its two arms.
  pts.push({ p: j.p, a: 0, b: 0, f: 0 });

  for (let i = 0; i < j.arms.length; i++) {
    const k = (i + 1) % j.arms.length;
    if (k === i) continue;
    const a = j.arms[i]!;
    const b = j.arms[k]!;
    // Anticlockwise, the left kerb of this arm runs into the right kerb of the
    // next one. Where they cross, that crossing is the corner of the junction.
    const m = V.lineIntersection(
      V.addScaled(j.p, ends[i]!.n, a.half),
      a.dir,
      V.addScaled(j.p, ends[k]!.n, -b.half),
      b.dir,
    );
    if (!m || V.dist(m, j.p) > radius * MITRE_LIMIT) continue;
    pts.push({ p: m, a: i, b: k, f: 1 });
  }

  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  return {
    ring: hull.map((h) => h.p),
    from: hull.map((h) => ({ a: h.a, b: h.b, f: h.f })),
  };
}

/** Andrew's monotone chain, anticlockwise, carrying each point's tag along. */
function convexHull<T extends { p: Vec2 }>(input: readonly T[]): T[] {
  const pts = [...input].sort((x, y) => x.p.x - y.p.x || x.p.y - y.p.y);
  if (pts.length < 3) return pts;
  const cross = (o: T, a: T, b: T): number =>
    (a.p.x - o.p.x) * (b.p.y - o.p.y) - (a.p.y - o.p.y) * (b.p.x - o.p.x);

  const lower: T[] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) {
      lower.pop();
    }
    lower.push(q);
  }
  const upper: T[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) {
      upper.pop();
    }
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * The asphalt-and-kerb rectangle `props/Ground.ts` draws for one road edge.
 *
 * `trim` is how much is left to the junction plate at each end — zero at a dead
 * end and at both ends of a 私道, where the node *is* the extent of the land
 * taken from the lots and there is nothing to meet.
 */
export function drawnRibbon(
  a: Vec2,
  b: Vec2,
  width: number,
  trim: { start: number; end: number } = { start: 0, end: 0 },
): Polygon | null {
  if (V.dist(a, b) - trim.start - trim.end < 1e-6) return null;
  return ribbon(a, b, drawnHalfWidth(width), { start: -trim.start, end: -trim.end });
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
  const { junctions, trims } = planJunctions(net);
  const out: Polygon[] = [];
  for (const e of net.edges) {
    const r = drawnRibbon(
      net.graph.node(e.a).p,
      net.graph.node(e.b).p,
      e.width,
      trims.get(e.id),
    );
    if (r) out.push(r);
  }
  for (const j of junctions) {
    const plate = junctionPlate(j);
    if (plate) out.push(plate.ring);
  }
  // A lane has no junctions: both its ends are the extent of the land taken
  // from the lots behind it, so it is never trimmed and never plated.
  if (laneStations) {
    for (const prof of laneStations) {
      for (let i = 0; i + 1 < prof.points.length; i++) {
        const r = drawnRibbon(prof.points[i]!, prof.points[i + 1]!, prof.width);
        if (r) out.push(r);
      }
    }
  } else {
    for (const lane of net.privateLanes) {
      const r = drawnRibbon(lane.a, lane.b, lane.width);
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
