import * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { MaterialLibrary } from '../material/materials.js';
import type { City } from '../city/City.js';
import type { BuiltBuilding } from '../building/Builder.js';
import { KIND_RULES } from '../building/kinds.js';
import { buildTerrainMesh } from '../terrain/GroundMesh.js';
import {
  drawnHalfWidth,
  junctionPlate,
  planJunctions,
  plateReach,
  type Junction,
} from '../city/RoadSurface.js';
import { gradeGround, type GradedGround } from '../terrain/Graded.js';
import type { Terrain } from '../terrain/Terrain.js';

/** Neither end held back: a 私道, and a road on flat ground with no junctions. */
const ZERO_TRIM = { start: 0, end: 0 };

/**
 * Ground, road surfaces, kerbs, cut-and-fill faces and the hardstanding on
 * paved lots.
 *
 * Roads are ribbons of quads with a light concrete gutter strip along each edge
 * — the 側溝 that runs beside every Japanese local street. No markings: this
 * build deliberately leaves out road paint, guardrails and street furniture.
 *
 * The ribbons sit at their *design* height, not on the ground. A road is a
 * graded surface — see `city/RoadProfile.ts` — so where the design height and
 * the land disagree the difference is made up here, with an embankment where it
 * is small and a retaining wall where it is not. That difference is most of what
 * makes a hillside town read as built rather than as draped.
 */
export function buildGround(
  city: City,
  params: CityParams,
  materials: MaterialLibrary,
  buildings: BuiltBuilding[] = [],
  graded?: GradedGround | null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground';

  const terrain = city.terrain;
  const heights = city.roadHeights;

  if (terrain.field) {
    // The ground is drawn *after* the earthworks, not before them — see
    // `terrain/Graded.ts`. Without this the town is buried in its own spoil.
    group.add(buildTerrainMesh(terrain, materials, (graded ?? gradeGround(city)) ?? undefined));
  } else {
    // Flat world: the original single plane, kept because turning terrain off
    // has to give back exactly the town this generator used to make.
    const extent = params.roads.extent + 300;
    const groundGeom = new THREE.PlaneGeometry(extent * 2, extent * 2, 1, 1);
    groundGeom.rotateX(-Math.PI / 2);
    const groundMat = materials.materials.ground as THREE.MeshStandardMaterial;
    if (groundMat.map) {
      groundMat.map.repeat.set((extent * 2) / 40, (extent * 2) / 40);
      groundMat.map.needsUpdate = true;
    }
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.receiveShadow = true;
    ground.position.y = -0.02;
    // The ground carries no vertex colours, so give it a uniform set.
    const count = groundGeom.attributes.position!.count;
    const colors = new Float32Array(count * 3);
    // A muted olive-grey, distinctly not asphalt — otherwise the ground and the
    // roads read as one continuous car park.
    for (let i = 0; i < count; i++) {
      colors[i * 3] = 0.46;
      colors[i * 3 + 1] = 0.48;
      colors[i * 3 + 2] = 0.38;
    }
    groundGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    group.add(ground);
  }

  // Road surfaces.
  const asphalt = new GeometryBuffer();
  const kerb = new GeometryBuffer();
  const earthworks = new GeometryBuffer();

  /**
   * One straight run of carriageway, between the junctions at its ends.
   *
   * `trim` is how much of each end belongs to a junction plate rather than to
   * this ribbon — see `city/RoadSurface.ts`. Everything a ribbon carries stops
   * with it: the 側溝 no longer runs across the mouth of the side street, and
   * neither does the cut face behind it.
   *
   * `ya`/`yb` are the design heights at the two *nodes*, so the surface is the
   * same plane whether or not the ends were trimmed — the plate is fanned from
   * the same heights and the two meet exactly along the trim line.
   */
  const addRibbon = (
    a: Vec2,
    b: Vec2,
    width: number,
    ya: number,
    yb: number,
    trim: { start: number; end: number },
  ) => {
    const d = V.sub(b, a);
    const l = V.len(d);
    if (l < 0.2) return;
    const dir = V.scale(d, 1 / l);
    const n = V.perp(dir);
    // From `city/RoadSurface.ts`, which is what the lot subdivider, the debug
    // overlay and the tests measure against. It used to be written out here and
    // copied into four other files.
    const half = drawnHalfWidth(width);
    const a2 = V.addScaled(a, dir, trim.start);
    const b2 = V.addScaled(b, dir, -trim.end);
    if (V.dot(V.sub(b2, a2), dir) < 0.2) return;

    // The carriageway is level across and linear along, so its surface is a
    // plane: `pushLiftedCap` is documented as exact for exactly this case.
    const slope = (yb - ya) / l;
    const surfaceY = (p: Vec2, lift: number): number =>
      ya + V.dot(V.sub(p, a), dir) * slope + lift;
    const nl = Math.hypot(slope, 1);
    const normal = { x: (-slope * dir.x) / nl, y: 1 / nl, z: (-slope * dir.y) / nl };

    const quad = (inner: number, outer: number, lift: number, buf: GeometryBuffer): void => {
      const p: Polygon = [
        V.addScaled(a2, n, inner),
        V.addScaled(b2, n, inner),
        V.addScaled(b2, n, outer),
        V.addScaled(a2, n, outer),
      ];
      buf.pushLiftedCap(p, (q) => surfaceY(q, lift), normal, true);
    };

    // 側溝: a pale concrete gutter strip along each edge. It sits *inside* the
    // nominal width — the lot subdivider already sets buildings back by
    // `roadWidth / 2 + gutterWidth`, so a gutter drawn outside `half` would lie
    // on private land for the whole length of the road.
    const gutter = Math.min(0.35, half * 0.16);
    asphalt.setColor({ r: 0.155, g: 0.157, b: 0.168 });
    quad(-half + gutter, half - gutter, 0.02, asphalt);

    kerb.setColor({ r: 0.72, g: 0.71, b: 0.68 });
    quad(half - gutter, half, 0.035, kerb);
    quad(-half, -half + gutter, 0.035, kerb);

    if (!terrain.field) return;

    // A road that crosses the water gets a deck rather than an embankment. It
    // is forty lines and it is the whole difference between "a bridge" and "the
    // road is floating"; an embankment drawn down to the riverbed would dam the
    // river instead.
    const crossing = city.obstacles.waterCrossing(a2, b2);
    if (crossing) {
      addBridge(earthworks, a2, b2, n, half, surfaceY, crossing);
      return;
    }
    for (const side of [1, -1] as const) {
      const p0 = V.addScaled(a2, n, half * side);
      const p1 = V.addScaled(b2, n, half * side);
      addFaceRun(
        earthworks,
        terrain,
        p0,
        p1,
        surfaceY(p0, 0.035),
        surfaceY(p1, 0.035),
        V.scale(n, side),
        params.platform.roadWallMin,
      );
    }
  };

  /**
   * The asphalt of one junction: a fan from the node out to every arm's end.
   *
   * Flat across each triangle and pinned at the arms' own end heights, so an
   * intersection between roads of different gradient is one continuous surface
   * rather than two planes crossing each other. Deliberately no 側溝 — a real
   * intersection has none, and the kerb is exactly what used to be drawn across
   * it.
   */
  const addJunction = (j: Junction) => {
    const plate = junctionPlate(j);
    if (!plate) return;
    const { ring, from } = plate;
    const yNode = heights.at(j.node);
    // Each arm's end edge is level across, at that arm's own design height where
    // it was cut — which is what makes the seam between the plate and the ribbon
    // exact rather than nearly exact.
    const armY = j.arms.map(
      (arm) => yNode + (heights.at(arm.far) - yNode) * (plateReach(arm) / arm.len),
    );
    // A mitre lies between two arms, so it takes the mean of what they are
    // doing; an arm's own corner names that arm twice. `f` is how far out along
    // them the vertex is, so a kerb point beside the node comes back to the
    // node's own height rather than to the arm's end.
    const ys = from.map(
      (v) => yNode + (v.f * (armY[v.a]! - yNode + (armY[v.b]! - yNode))) / 2,
    );

    asphalt.setColor({ r: 0.155, g: 0.157, b: 0.168 });
    const centre = { x: j.p.x, y: yNode + 0.02, z: j.p.y };
    for (let i = 0; i < ring.length; i++) {
      const k = (i + 1) % ring.length;
      const q0 = ring[i]!;
      const q1 = ring[k]!;
      asphalt.pushTriangle(
        centre,
        { x: q1.x, y: ys[k]! + 0.02, z: q1.y },
        { x: q0.x, y: ys[i]! + 0.02, z: q0.y },
      );
    }

    if (!terrain.field) return;
    // The run between one arm's end edge and the next's is an open edge of the
    // town's asphalt: the arms' own cut faces stop at their trim lines, so
    // without this the corner of every junction on a slope is a hole.
    for (let i = 0; i < ring.length; i++) {
      const k = (i + 1) % ring.length;
      // Not across an arm's own end edge — the ribbon is on the other side of
      // it, not the hillside.
      const fi = from[i]!;
      const fk = from[k]!;
      if (fi.a === fi.b && fk.a === fk.b && fi.a === fk.a && fi.f === 1 && fk.f === 1) continue;
      const q0 = ring[i]!;
      const q1 = ring[k]!;
      const d = V.sub(q1, q0);
      const len = V.len(d);
      if (len < 0.2) continue;
      addFaceRun(
        earthworks,
        terrain,
        q0,
        q1,
        ys[i]! + 0.035,
        ys[k]! + 0.035,
        // The ring is anticlockwise, so the outward side of an edge is to its
        // right.
        V.neg(V.perp(V.scale(d, 1 / len))),
        params.platform.roadWallMin,
      );
    }
  };

  // Which roads meet where, and how far short of each junction the asphalt
  // stops so the plate can fill it.
  const { junctions, trims } = planJunctions(city.roads);

  for (const e of city.roads.edges) {
    const a = city.roads.graph.node(e.a).p;
    const b = city.roads.graph.node(e.b).p;
    addRibbon(a, b, e.width, heights.at(e.a), heights.at(e.b), trims.get(e.id) ?? ZERO_TRIM);
  }
  for (const j of junctions) addJunction(j);

  // A 私道 is drawn station by station rather than as one plane between its ends.
  // It has no node in the road graph, so it is not in the profile solve with the
  // streets; `solveLaneProfiles` gives it one of its own, and the whole point of
  // that profile is that it follows the land — which one flat quad cannot do.
  // Consecutive stations are collinear and share their end heights exactly, so
  // the pieces meet without a plate between them.
  for (const prof of city.laneHeights.profiles) {
    for (let i = 0; i + 1 < prof.points.length; i++) {
      addRibbon(
        prof.points[i]!,
        prof.points[i + 1]!,
        prof.width,
        prof.heights[i]!,
        prof.heights[i + 1]!,
        ZERO_TRIM,
      );
    }
  }

  buildLotSurfaces(buildings, asphalt, kerb);

  for (const [buf, family] of [
    [asphalt, 'asphalt'],
    [kerb, 'concrete'],
    [earthworks, 'concrete'],
  ] as const) {
    if (buf.isEmpty) continue;
    const mesh = new THREE.Mesh(buf.toGeometry(), materials.materials[family]);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = `road:${family}`;
    group.add(mesh);
  }

  return group;
}

/**
 * A single-span 桁橋 where a road crosses the river.
 *
 * No piers: a suburban crossing of a river this size is one span, and a pier in
 * the channel would be more geometry saying something less true. What it does
 * need is the three things that make a bridge legible from a distance — a deck
 * with visible thickness, a parapet along each side, and an abutment at each
 * bank so the deck plainly lands on something.
 */
function addBridge(
  buf: GeometryBuffer,
  a: Vec2,
  b: Vec2,
  n: Vec2,
  half: number,
  surfaceY: (p: Vec2, lift: number) => number,
  crossing: { t0: number; t1: number },
): void {
  // The deck runs a little past the wet part at each end, onto dry ground.
  const pad = 0.06;
  const from = V.lerp(a, b, Math.max(0, crossing.t0 - pad));
  const to = V.lerp(a, b, Math.min(1, crossing.t1 + pad));
  if (V.dist(from, to) < 1) return;

  const deck = (inner: number, outer: number, y0: (p: Vec2) => number, y1: (p: Vec2) => number) => {
    const c0 = V.addScaled(from, n, inner);
    const c1 = V.addScaled(to, n, inner);
    const c2 = V.addScaled(to, n, outer);
    const c3 = V.addScaled(from, n, outer);
    // A prism between two sloping planes is not expressible here, so the slab
    // is drawn at its two ends' heights — over a 30 m span the error is under a
    // centimetre and it is under the deck.
    buf.pushPrism([c0, c1, c2, c3], Math.min(y0(c0), y0(c1)), Math.max(y1(c0), y1(c1)), true, true);
  };

  // Soffit slab.
  buf.setColor({ r: 0.6, g: 0.6, b: 0.58 });
  deck(
    -half,
    half,
    (p) => surfaceY(p, -0.75),
    (p) => surfaceY(p, -0.02),
  );

  // 高欄 along each side.
  buf.setColor({ r: 0.72, g: 0.72, b: 0.7 });
  for (const side of [1, -1] as const) {
    deck(
      (half - 0.18) * side,
      half * side,
      (p) => surfaceY(p, 0.0),
      (p) => surfaceY(p, 0.95),
    );
  }
}

/**
 * The cut and the fill along one open edge of the town's asphalt.
 *
 * Where the design height and the ground disagree, something has to make up the
 * difference or there is a slot of daylight between the asphalt and the
 * hillside. Below `wallMin` it is an earth batter in the ground colour; above,
 * a concrete face. The threshold is not cosmetic — a 3 m batter at 1:1.5 would
 * be 4.5 m of ground, which is a whole lot's worth, and the reason real hillside
 * streets are walled rather than sloped.
 *
 * Written against a single segment with an explicit outward direction rather
 * than against a whole carriageway, because a junction has open edges too: the
 * chamfer between two arms of an intersection is asphalt with nothing under it
 * in exactly the same way a kerb line is.
 */
function addFaceRun(
  buf: GeometryBuffer,
  terrain: Terrain,
  p0: Vec2,
  p1: Vec2,
  y0: number,
  y1: number,
  outward: Vec2,
  wallMin: number,
): void {
  const len = V.dist(p0, p1);
  if (len < 1e-6) return;
  const steps = Math.max(1, Math.round(len / 4));

  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const s0 = V.lerp(p0, p1, t0);
    const s1 = V.lerp(p0, p1, t1);
    const ya = y0 + (y1 - y0) * t0;
    const yb = y0 + (y1 - y0) * t1;
    const g0 = terrain.heightAt(s0);
    const g1 = terrain.heightAt(s1);
    const d0 = ya - g0;
    const d1 = yb - g1;
    if (Math.abs(d0) < 0.08 && Math.abs(d1) < 0.08) continue;

    const wall = Math.max(Math.abs(d0), Math.abs(d1)) >= wallMin;
    buf.setColor(wall ? { r: 0.66, g: 0.65, b: 0.62 } : { r: 0.44, g: 0.43, b: 0.36 });

    // A batter leans away from the road; a wall drops straight down. Either
    // way the quad runs from the kerb line to where it meets the ground.
    const lean = wall ? 0.04 : Math.min(2.5, Math.abs(d0) * 1.5);
    const q0 = V.addScaled(s0, outward, lean);
    const q1 = V.addScaled(s1, outward, lean);

    // Winding depends on which side and whether we are above or below the
    // ground, so the face is emitted both ways — this is a thin sliver seen
    // from one side in practice, and a wrongly-wound one is invisible.
    buf.pushWorldTriangle(
      { x: s0.x, y: ya, z: s0.y },
      { x: s1.x, y: yb, z: s1.y },
      { x: q1.x, y: g1, z: q1.y },
    );
    buf.pushWorldTriangle(
      { x: s0.x, y: ya, z: s0.y },
      { x: q1.x, y: g1, z: q1.y },
      { x: q0.x, y: g0, z: q0.y },
    );
  }
}

/**
 * Asphalt over the whole of a コンビニ, 工場 or 倉庫 lot, plus parking bays.
 *
 * **The whole lot, deliberately not the lot minus the building.** That
 * difference is an annulus, and this pipeline drops holes — the same trap that
 * once made `carPad` come back as the entire lot, parked the car inside the
 * house and suppressed every shrub on the parcel. Capping the lot and letting
 * the building's own plinth sit on top of it sidesteps the boolean entirely,
 * and is also what the real thing looks like: the slab was poured first.
 */
function buildLotSurfaces(
  buildings: BuiltBuilding[],
  asphalt: GeometryBuffer,
  lines: GeometryBuffer,
): void {
  for (const b of buildings) {
    if (!KIND_RULES[b.spec.kind].pavedLot) continue;

    asphalt.setColor({ r: 0.185, g: 0.187, b: 0.196 });
    asphalt.pushCap(b.lot.polygon, b.lot.platform.padY + 0.025, true);

    // Bays along the frontage, only for the shop — a factory yard is not marked
    // out in spaces, it is turning room for a lorry.
    if (b.spec.kind !== 'konbini') continue;
    const f = b.lot.frontages[0];
    if (!f) continue;
    const inward = V.neg(f.outward);
    const bayWidth = 2.5;
    // Only as deep as the gap actually is. The building is set well back, but a
    // shallow plot makes the concession ladder pull it forward, and a bay drawn
    // to its nominal depth would then run under the shop.
    let clear = Infinity;
    for (const p of b.footprint.outline) {
      clear = Math.min(clear, V.dot(V.sub(p, f.mid), inward));
    }
    const bayDepth = Math.min(5.0, Math.max(0, clear - 0.3));
    if (bayDepth < 2.0) continue;
    const n = Math.floor((f.len - 1.0) / bayWidth);
    lines.setColor({ r: 0.86, g: 0.86, b: 0.83 });
    for (let i = 0; i <= n; i++) {
      const u = 0.5 + i * bayWidth;
      if (u > f.len - 0.5) break;
      const p = V.addScaled(f.a, f.dir, u);
      const q = V.addScaled(p, inward, bayDepth);
      const side = V.scale(f.dir, 0.06);
      lines.pushCap(
        [
          { x: p.x - side.x, y: p.y - side.y },
          { x: p.x + side.x, y: p.y + side.y },
          { x: q.x + side.x, y: q.y + side.y },
          { x: q.x - side.x, y: q.y - side.y },
        ],
        b.lot.platform.padY + 0.032,
        true,
      );
    }
  }
}
