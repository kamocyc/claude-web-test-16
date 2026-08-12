import type { Vec2 } from '../core/types.js';
import { DEG, type GrowthParams, type RoadClass, type RoadParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { EdgeGrid } from '../geom/edgeGrid.js';
import type { Terrain } from '../terrain/Terrain.js';
import type { ObstacleField } from '../terrain/Obstacles.js';
import { clipToSquare, PERIMETER_OVERSHOOT, type Skeleton, type SkeletonLine } from './RoadSkeleton.js';

/**
 * Tier-1, grown outward from the station instead of placed all at once.
 *
 * The one-shot skeleton draws every arterial and collector from the same
 * distribution, so a town has no history: the road at the edge is the same age,
 * the same length and the same straightness as the one through the middle. A
 * real suburb is not like that. It started as a road through a valley and a
 * station on it; everything else was attached to what was already there, and the
 * further out you go the later, the coarser and the more it had to negotiate
 * with the land.
 *
 * **Only Tier-1 is grown.** Districts and their grids are untouched — the
 * bounded faces of the grown graph are still cut into 区画整理 blocks by the
 * existing machinery. That is deliberate rather than lazy: growing every last
 * cul-de-sac gives a network that reads as a river delta, while growing the
 * *frame* and letting each enclosure be developed to the standard of its day
 * gives fine early districts near the station and coarse late ones at the
 * fringe, which is the actual shape of the thing.
 *
 * Three properties are load-bearing:
 *
 * - **Roads follow the land.** A candidate is scored on the earthworks it would
 *   need, not just its gradient, so a road would rather wrap round a hill than
 *   cut through it. That single term is what makes hillside streets curve.
 * - **Roads close loops.** A chain that comes near an existing junction snaps to
 *   it. Without that the network is a tree, and a tree does not look like a town.
 * - **Spacing falls off with radius.** New Tier-1 has to keep further from its
 *   neighbours the further out it is, so districts near the station are small
 *   and districts at the edge are large before a single lot exists.
 */

/** Generation of a road that was never grown — the perimeter, and a flat town. */
export const UNGROWN = -1;

export interface GrownSkeleton extends Skeleton {
  lines: (SkeletonLine & { gen: number })[];
}

interface GrowEdge {
  a: number;
  b: number;
  cls: RoadClass;
  gen: number;
  /** Set by the closure pass rather than spliced out, so edge ids stay stable. */
  dead?: boolean;
}

interface GrowState {
  pts: Vec2[];
  edges: GrowEdge[];
  /** Edge ids incident on each node. */
  inc: number[][];
  /**
   * Spatial index over the same edges, added in the same order — so an index
   * entry's id *is* the edge id, which is what lets a spacing query say "every
   * road but this one".
   */
  index: EdgeGrid;
}

/** How long one growth increment is. Short enough to bend, long enough to be a road. */
const SEGMENT = 52;
/** Most increments in one chain before it must stop. */
const MAX_SEGMENTS = 26;
/** How far a chain end will reach to snap onto something that already exists. */
const SNAP_RADIUS = 46;

const CLASS_WIDTH_RANK: Record<RoadClass, number> = {
  arterial: 3,
  collector: 2,
  local: 1,
  private: 0,
};

function newState(): GrowState {
  return { pts: [], edges: [], inc: [], index: new EdgeGrid(60) };
}

function addNode(s: GrowState, p: Vec2): number {
  s.pts.push(p);
  s.inc.push([]);
  return s.pts.length - 1;
}

function nodeNear(s: GrowState, p: Vec2, radius: number): number {
  let best = -1;
  let bestD = radius;
  for (let i = 0; i < s.pts.length; i++) {
    const d = V.dist(s.pts[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function addEdge(s: GrowState, a: number, b: number, cls: RoadClass, gen: number): void {
  if (a === b) return;
  const id = s.edges.length;
  s.edges.push({ a, b, cls, gen });
  s.inc[a]?.push(id);
  s.inc[b]?.push(id);
  s.index.add(s.pts[a]!, s.pts[b]!);
}

/** Directions of every road leaving `node`. */
function armsAt(s: GrowState, node: number): Vec2[] {
  const out: Vec2[] = [];
  for (const id of s.inc[node] ?? []) {
    const e = s.edges[id];
    if (!e || e.dead) continue;
    const other = e.a === node ? e.b : e.a;
    out.push(V.normalize(V.sub(s.pts[other]!, s.pts[node]!)));
  }
  return out;
}

/**
 * May a road leave `node` in direction `dir`?
 *
 * Junction angle is a hard constraint on this generator, not a preference —
 * `test/roads.test.ts` asserts it directly, and the README explains why: two
 * roads meeting at 10° produce overlapping asphalt and a sliver block that no
 * downstream stage can repair. The one-shot skeleton got this by rejection
 * sampling whole lines; growth has to get it one attachment at a time.
 */
function attachOk(s: GrowState, node: number, dir: Vec2, minAngle: number): boolean {
  for (const arm of armsAt(s, node)) {
    if (V.angleBetween(arm, dir) < minAngle) return false;
  }
  return true;
}

/**
 * May this segment be built, given what it would cross?
 *
 * Crossings are allowed — the planariser will split both roads and make a real
 * junction — but only square ones. A shallow crossing is the other half of the
 * acute-junction problem, and it is easy to miss because neither road has a node
 * there yet.
 */
function crossingOk(s: GrowState, a: Vec2, b: Vec2, minAngle: number): boolean {
  const mid = V.lerp(a, b, 0.5);
  for (const i of s.index.near(mid, V.dist(a, b))) {
    const seg = s.index.segment(i);
    const x = V.segmentIntersection(a, b, seg.a, seg.b, 1e-9);
    if (!x) continue;
    // A crossing right at the start is the parent junction, already checked by
    // `attachOk` against the real arm directions.
    if (x.ta < 0.06) continue;
    const raw = V.angleBetween(V.sub(b, a), V.sub(seg.b, seg.a));
    if (Math.min(raw, Math.PI - raw) < minAngle) return false;
  }
  return true;
}

/**
 * Distance from `p` to the nearest road, ignoring a set of edges.
 *
 * The exclusion is the entire point. A new road is *supposed* to start on an
 * existing one, so measuring how far its first segment lands from "the nearest
 * road" measures how far it got from its own parent — which at one segment out
 * is exactly `SEGMENT`, below every spacing threshold in the file. Every sprout
 * was rejected on those grounds and the town came out as the perimeter plus a
 * couple of arterials: two districts covering ninety per cent of it.
 */
function clearanceFrom(s: GrowState, p: Vec2, radius: number, exclude: Set<number>): number {
  let best = Infinity;
  for (const i of s.index.near(p, radius)) {
    if (exclude.has(i)) continue;
    const e = s.edges[i];
    if (e?.dead) continue;
    const seg = s.index.segment(i);
    const d = V.distToSegment(p, seg.a, seg.b);
    if (d < best) best = d;
  }
  return best;
}

/** Every edge on the chain we are growing, plus the ones it started from. */
function chainExclusion(s: GrowState, from: number): Set<number> {
  const out = new Set<number>(s.inc[from] ?? []);
  // One step further back as well: a chain that has just turned is still within
  // a segment's length of the road it left, and that is not a spacing failure.
  for (const id of [...out]) {
    const e = s.edges[id];
    if (!e) continue;
    for (const n of [e.a, e.b]) for (const j of s.inc[n] ?? []) out.add(j);
  }
  return out;
}

/** Join two existing nodes, if the land and the junction angles allow it. */
function joinNodes(
  s: GrowState,
  a: number,
  b: number,
  cls: RoadClass,
  gen: number,
  obstacles: ObstacleField,
  minAngle: number,
): boolean {
  if (a === b) return false;
  const pa = s.pts[a]!;
  const pb = s.pts[b]!;
  const dir = V.normalize(V.sub(pb, pa));
  if (!attachOk(s, a, dir, minAngle)) return false;
  if (!attachOk(s, b, V.neg(dir), minAngle)) return false;
  if (!crossingOk(s, pa, pb, minAngle)) return false;
  if (!obstacles.probe(pa, pb, cls).ok) return false;
  addEdge(s, a, b, cls, gen);
  return true;
}

const liveDegree = (s: GrowState, node: number): number =>
  (s.inc[node] ?? []).filter((id) => !s.edges[id]?.dead).length;

/**
 * Leave no Tier-1 road stranded.
 *
 * This is the one place growth could break the generator outright, and the
 * failure is silent. `extractFaces` prunes dead-end chains before walking, so a
 * collector that stops in the middle of a field is not merely a cosmetic loose
 * end — the two districts it was supposed to separate merge into one, and a
 * single grid direction then governs twice the town it should. The README
 * documents this as a past bug and `test/roads.test.ts` asserts against it.
 *
 * Two passes, in this order because the first is always better than the second:
 * reach out and connect what can be connected, then delete whatever still
 * dangles. Deletion cascades — removing an edge can strand the one behind it —
 * so it runs to a fixpoint.
 */
function closeNetwork(
  s: GrowState,
  p: RoadParams,
  obstacles: ObstacleField,
): void {
  const minAngle = p.minJunctionAngle * DEG;

  for (let pass = 0; pass < 2; pass++) {
    for (let node = 0; node < s.pts.length; node++) {
      if (liveDegree(s, node) !== 1) continue;
      const here = s.pts[node]!;

      // The nearest node that is worth reaching, preferring the ones roughly
      // ahead: a dead end wants to carry on, not to double back beside itself.
      const armList = armsAt(s, node);
      const ahead = armList.length > 0 ? V.neg(armList[0]!) : { x: 1, y: 0 };
      let bestTarget = -1;
      let bestScore = Infinity;
      for (let other = 0; other < s.pts.length; other++) {
        if (other === node) continue;
        const d = V.dist(here, s.pts[other]!);
        if (d > SEGMENT * 3.2) continue;
        if (liveDegree(s, other) === 0) continue;
        const dir = V.normalize(V.sub(s.pts[other]!, here));
        const score = d * (1.6 - V.dot(dir, ahead) * 0.6);
        if (score < bestScore) {
          bestScore = score;
          bestTarget = other;
        }
      }
      if (bestTarget >= 0) {
        const cls = s.edges[s.inc[node]![0]!]!.cls;
        const gen = s.edges[s.inc[node]![0]!]!.gen;
        joinNodes(s, node, bestTarget, cls, gen, obstacles, minAngle);
      }
    }
  }

  // Whatever is still a dead end was not connectable. Cut it back, and keep
  // cutting: removing the last edge of a chain strands the one before it.
  for (;;) {
    let cut = 0;
    for (let node = 0; node < s.pts.length; node++) {
      if (liveDegree(s, node) !== 1) continue;
      for (const id of s.inc[node] ?? []) {
        const e = s.edges[id];
        if (e && !e.dead) {
          e.dead = true;
          cut++;
        }
      }
    }
    if (cut === 0) break;
  }
}

/**
 * How far out a point is, measured the way the town is shaped.
 *
 * Chebyshev, not Euclidean. The town is a square, and under a Euclidean radius
 * its corners sit at 1.41 × extent — so the perimeter nodes there scored as
 * permanently *outside* the growth frontier and were never once chosen to sprout
 * from. The result was one enormous undivided face in each corner of every town.
 */
const townRadius = (q: Vec2): number => Math.max(Math.abs(q.x), Math.abs(q.y));

/**
 * The Tier-1 spacing wanted at radius `r`.
 *
 * This is the first of the two levers that make the middle of the town denser
 * than the edge, and it acts before a single block exists: it decides how big
 * the enclosed faces are. The second lever is `districtStreets`, which grids
 * each face according to when it was enclosed.
 */
function tier1Spacing(r: number, extent: number, p: RoadParams): number {
  const t = Math.min(1, r / Math.max(1, extent));
  const s = t * t * (3 - 2 * t);
  return p.collectorSpacing * (0.32 + 0.62 * s);
}

/** Target local-street spacing for a district enclosed at generation `gen`. */
export function spacingForGeneration(gen: number, g: GrowthParams): number {
  const t = Math.min(1, Math.max(0, gen / Math.max(1, g.steps - 1)));
  return g.coreSpacing + (g.fringeSpacing - g.coreSpacing) * (t * t * (3 - 2 * t));
}

/**
 * The station: the flattest buildable spot near the middle of the town.
 *
 * Not a random point on a random arterial. A station goes where a line could be
 * laid and a forecourt levelled, which on this land means off the flood plain,
 * off the scarps and out of anything steep — and every road in the town is then
 * grown from it.
 */
function pickStation(terrain: Terrain, obstacles: ObstacleField, extent: number): Vec2 {
  const r = extent * 0.3;
  const step = 12;
  let best: Vec2 = { x: 0, y: 0 };
  let bestScore = Infinity;
  for (let y = -r; y <= r; y += step) {
    for (let x = -r; x <= r; x += step) {
      const p = { x, y };
      if (!obstacles.buildable(p)) continue;
      const score = terrain.slopeAt(p) * 8 + V.len(p) / Math.max(1, extent);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * Grow one road outward from a node until it leaves the town, meets something
 * it can join, or runs out of anywhere acceptable to go.
 */
function growChain(
  s: GrowState,
  rng: Rng,
  from: number,
  dir0: Vec2,
  cls: RoadClass,
  gen: number,
  p: RoadParams,
  g: GrowthParams,
  terrain: Terrain,
  obstacles: ObstacleField,
  reach: number,
): number {
  const E = p.extent;
  let at = from;
  let dir = dir0;
  let placed = 0;
  const own = chainExclusion(s, from);

  for (let seg = 0; seg < MAX_SEGMENTS; seg++) {
    const here = s.pts[at]!;
    if (Math.abs(here.x) >= E || Math.abs(here.y) >= E) break;

    let best: { to: Vec2; dir: Vec2; cost: number } | null = null;
    const fan = Math.max(3, g.candidatesPerStreet);
    const maxTurn = p.tier1MaxBend * DEG * 2.2;
    const minAngle = p.minJunctionAngle * DEG;

    for (let i = 0; i < fan; i++) {
      // A deterministic fan of directions, symmetric about straight ahead.
      const turn = ((i / (fan - 1)) * 2 - 1) * maxTurn;
      const d = V.rotate(dir, turn);
      const to = V.addScaled(here, d, SEGMENT);
      // Chains stay strictly inside the town square. They used to be allowed a
      // little way past it, on the theory that `generateRoads` drops the stubs
      // — but dropping them is exactly what strands the chain that was still
      // attached on the inside, and a stranded Tier-1 road merges two districts
      // without saying so.
      if (Math.abs(to.x) > E || Math.abs(to.y) > E) continue;

      const verdict = obstacles.probe(here, to, cls);
      if (!verdict.ok) continue;
      if (seg === 0 && !attachOk(s, at, d, minAngle)) continue;
      if (!crossingOk(s, here, to, minAngle)) continue;

      // --- the cost --------------------------------------------------------
      const grade = obstacles.gradient(here, to);
      const limit = g.maxGradient[cls];
      let cost = g.slopeWeight * (grade.mean / limit);

      // Earthworks. A road holds a smooth profile, so what it costs to build is
      // the ground it has to move to get one — and preferring the cheap line is
      // exactly what makes a road wrap round a hill instead of climbing it.
      // Without this term nothing distinguishes a contour from a fall line as
      // long as both are inside the gradient limit.
      const mid = V.lerp(here, to, 0.5);
      const straightY = (terrain.heightAtXY(here.x, here.y) + terrain.heightAtXY(to.x, to.y)) / 2;
      cost += g.cutFillWeight * (Math.abs(terrain.heightAtXY(mid.x, mid.y) - straightY) / 4);

      // Cross slope: a road benched into a steep sidehill needs a big cut on
      // one side and a big fill on the other.
      const nrm = V.perp(d);
      const l = terrain.heightAtXY(mid.x - nrm.x * 12, mid.y - nrm.y * 12);
      const rgt = terrain.heightAtXY(mid.x + nrm.x * 12, mid.y + nrm.y * 12);
      cost += g.crossSlopeWeight * (Math.abs(l - rgt) / 24 / limit) * 0.4;

      // Straightness. A real 幹線道路 runs for hundreds of metres and then turns
      // once, decisively. Charging for every degree means it only bends when the
      // land makes bending genuinely cheaper.
      cost += 2.6 * Math.abs(turn / maxTurn);

      // Outward pressure, so a chain spends itself extending the town rather
      // than curling back into the part that already exists.
      const outward = V.dot(d, V.normalize(here)) * (V.len(here) > 1 ? 1 : 0);
      cost += g.reachWeight * (1 - outward) * 0.5;
      if (townRadius(to) > reach) cost += g.reachWeight * ((townRadius(to) - reach) / Math.max(1, reach));

      // Keep off the roads that are already there — except the one we are
      // growing from, which is behind us.
      const spacing = tier1Spacing(townRadius(to), E, p);
      const gap = clearanceFrom(s, mid, spacing, own);
      if (gap < p.tier1MinSpacing * 0.45) continue;
      if (gap < spacing) cost += g.spacingWeight * (1 - gap / spacing) * 2.2;

      if (verdict.bridge) cost += g.bridgeCost;

      if (!best || cost < best.cost) best = { to, dir: d, cost };
    }

    if (!best) break;

    // Loop closure. A chain that has come within reach of an existing junction
    // joins it. Without this the grown network is a tree — every face open,
    // every district merged with its neighbour — and it reads as a river delta
    // rather than as a town.
    const snap = nodeNear(s, best.to, SNAP_RADIUS);
    if (snap >= 0 && snap !== at && placed > 0) {
      if (joinNodes(s, at, snap, cls, gen, obstacles, minAngle)) return placed + 1;
    }

    const next = addNode(s, best.to);
    own.add(s.edges.length);
    addEdge(s, at, next, cls, gen);
    at = next;
    dir = best.dir;
    placed++;

    // Occasionally stop short of the frontier, so the town has honest loose ends
    // rather than every road running the full radius.
    if (placed >= 4 && townRadius(best.to) > reach && rng.chance(0.45)) break;
  }
  return placed;
}

export function growSkeleton(
  seed: string,
  p: RoadParams,
  terrain: Terrain,
  obstacles: ObstacleField,
): GrownSkeleton {
  const g = p.growth;
  const E = p.extent;
  const rng = makeRng(subSeed(seed, 'roads', 'growth'));
  const townAxis = rng.jitter(p.townAxisJitter * DEG);
  const s = newState();

  // The perimeter goes in *before* growth, not after. It is the town's outer
  // road and chains have to be able to see it: to meet it squarely, to keep
  // their distance from it, and above all to terminate on it instead of dying
  // just inside it. (It is also structurally mandatory — `extractFaces` throws
  // away the single clockwise outer cycle, so without a ring the outermost
  // region is not a face and the town has no boundary districts at all.)
  // The ring is not a growth event, and must not be read as one. Marking it
  // with the last generation made every district that touches the town edge —
  // in a small town, most of them — read as the newest thing in the place and
  // take the coarsest grid, whatever had actually happened inside it. `-1`
  // means "this side was always here"; `partitionDistricts` skips it when
  // dating a face.
  const ringGen = UNGROWN;
  if (p.perimeterRoad) {
    const corner: Vec2[] = [
      { x: -E, y: -E },
      { x: E, y: -E },
      { x: E, y: E },
      { x: -E, y: E },
    ];
    const ids = corner.map((c) => addNode(s, c));
    for (let i = 0; i < 4; i++) {
      // Split into segments so a chain arriving mid-side has a node to snap to.
      const a = corner[i]!;
      const b = corner[(i + 1) % 4]!;
      const n = Math.max(2, Math.round(V.dist(a, b) / SEGMENT));
      let prev = ids[i]!;
      for (let k = 1; k < n; k++) {
        const mid = addNode(s, V.lerp(a, b, k / n));
        addEdge(s, prev, mid, p.perimeterClass, ringGen);
        prev = mid;
      }
      addEdge(s, prev, ids[(i + 1) % 4]!, p.perimeterClass, ringGen);
    }
  }

  const station = pickStation(terrain, obstacles, E);
  const hub = addNode(s, station);

  // Generation 0: a cross of arterials through the station. Everything else in
  // the town is attached, directly or not, to these two roads.
  for (let i = 0; i < 4; i++) {
    const dir = V.fromAngle(townAxis + (i * Math.PI) / 2);
    growChain(s, rng, hub, dir, 'arterial', 0, p, g, terrain, obstacles, E * 0.45);
  }

  for (let step = 1; step < g.steps; step++) {
    const reach = E * Math.pow((step + 1) / g.steps, g.spreadExponent);

    // What is being built this year. Arterials are rare and early, collectors
    // are the ordinary business of a growing town.
    const cls: RoadClass =
      step % g.arterialInterval === 0 ? 'arterial' : 'collector';

    for (let attempt = 0; attempt < g.streetsPerStep; attempt++) {
      const aRng = makeRng(subSeed(seed, 'roads', 'growth', step, attempt));

      // Sprout from somewhere on the existing network, preferring nodes near
      // the frontier — but not exclusively, or the core never gets its later
      // infill and the density gradient comes out backwards.
      const candidates: number[] = [];
      for (let i = 0; i < s.pts.length; i++) {
        const r = townRadius(s.pts[i]!);
        if (r > reach + SEGMENT) continue;
        if ((s.inc[i]?.length ?? 0) >= 4) continue;
        candidates.push(i);
      }
      if (candidates.length === 0) break;
      const from = aRng.pick(candidates);
      const here = s.pts[from]!;

      // Leave the parent road at a right angle where it can, which is what
      // makes the grown network read as streets rather than as a fracture
      // pattern — and keeps `minJunctionAngle` satisfiable downstream.
      const parent = s.inc[from]?.[0];
      let base: Vec2;
      if (parent !== undefined) {
        const e = s.edges[parent]!;
        const along = V.normalize(V.sub(s.pts[e.b]!, s.pts[e.a]!));
        base = aRng.chance(0.75) ? V.perp(along) : along;
      } else {
        base = V.fromAngle(townAxis);
      }
      if (aRng.chance(0.5)) base = V.neg(base);
      // Point it away from the middle, so the town grows outward.
      if (V.len(here) > 1 && V.dot(base, V.normalize(here)) < -0.3) base = V.neg(base);
      base = V.rotate(base, aRng.jitter(p.districtAxisJitter * DEG));

      // Enough room out here for another Tier-1 road? Measured against every
      // road except the one being left, which is by construction one segment
      // away and is not what "too close" is supposed to mean.
      const probe = V.addScaled(here, base, SEGMENT);
      const want = tier1Spacing(townRadius(probe), E, p);
      if (clearanceFrom(s, probe, want, chainExclusion(s, from)) < want * 0.62) continue;

      growChain(s, aRng, from, base, cls, step, p, g, terrain, obstacles, reach);
    }
  }

  // --- Close the town ------------------------------------------------------
  closeNetwork(s, p, obstacles);

  const lines: (SkeletonLine & { gen: number })[] = [];
  for (const e of s.edges) {
    if (e.dead) continue;
    const a = s.pts[e.a]!;
    const b = s.pts[e.b]!;
    for (const run of clipToSquare([a, b], E + PERIMETER_OVERSHOOT)) {
      if (run.length > 1) lines.push({ pts: run, cls: e.cls, gen: e.gen });
    }
  }

  return { lines, station, townAxis };
}

/** Widest class among a set — used when a face inherits from its boundary. */
export const widestClass = (classes: RoadClass[]): RoadClass =>
  classes.reduce((best, c) => (CLASS_WIDTH_RANK[c] > CLASS_WIDTH_RANK[best] ? c : best), 'private');
