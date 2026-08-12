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
import type { Terrain } from '../terrain/Terrain.js';

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
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground';

  const terrain = city.terrain;
  const heights = city.roadHeights;

  if (terrain.field) {
    group.add(buildTerrainMesh(terrain, materials));
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
   * `extend` closes the gap at a junction by running the ribbon a little past
   * its node — but only where there is a second ribbon to close against. At a
   * dead end, and at both ends of a private lane, the node *is* the extent of
   * the land taken from the lots, and running past it puts asphalt over ground
   * a house is standing on.
   *
   * `ya`/`yb` are the design heights at the two nodes. Because every road
   * meeting at a junction was given the *same* height for that node, the
   * overshoots from all the arms land on one plane and the corner closes
   * exactly — which is the whole reason the profile is solved per node.
   */
  const addRibbon = (
    a: Vec2,
    b: Vec2,
    width: number,
    ya: number,
    yb: number,
    extend: { start: boolean; end: boolean },
  ) => {
    const d = V.sub(b, a);
    const l = V.len(d);
    if (l < 0.2) return;
    const dir = V.scale(d, 1 / l);
    const n = V.perp(dir);
    const half = width / 2;
    const over = half * 0.9;
    const a2 = V.addScaled(a, dir, extend.start ? -over : 0);
    const b2 = V.addScaled(b, dir, extend.end ? over : 0);

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

    if (terrain.field) {
      addEarthworks(earthworks, terrain, a2, b2, dir, n, half, surfaceY, params.platform.roadWallMin);
    }
  };

  // How many roads meet at each node, so a ribbon knows whether there is
  // anything at its end to close the gap against.
  const degree = new Map<number, number>();
  for (const e of city.roads.edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }

  for (const e of city.roads.edges) {
    const a = city.roads.graph.node(e.a).p;
    const b = city.roads.graph.node(e.b).p;
    // The overshoot fills the corner where two ribbons meet. At a dead end
    // there is no second ribbon and nothing to fill — the asphalt simply ran
    // 0.45 of a carriageway past the last node, onto the lot behind it. The
    // land there belongs to a house.
    addRibbon(a, b, e.width, heights.at(e.a), heights.at(e.b), {
      start: (degree.get(e.a) ?? 0) > 1,
      end: (degree.get(e.b) ?? 0) > 1,
    });
  }
  for (const lane of city.roads.privateLanes) {
    // A 私道 has no node in the road graph and therefore no solved profile. It
    // takes its ends from whatever the network nearby is doing, which is what
    // actually happens: the lane was graded to meet the street it opens off.
    const ya = heights.nearestRoadHeight(lane.a, 40) ?? terrain.heightAt(lane.a);
    const yb = heights.nearestRoadHeight(lane.b, 40) ?? terrain.heightAt(lane.b);
    addRibbon(lane.a, lane.b, lane.width, ya, yb, { start: false, end: false });
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
 * The cut and the fill along one carriageway edge.
 *
 * Where the road's design height and the ground disagree, something has to make
 * up the difference or there is a slot of daylight between the asphalt and the
 * hillside. Below `wallMin` it is an earth batter in the ground colour; above,
 * a concrete face. The threshold is not cosmetic — a 3 m batter at 1:1.5 would
 * be 4.5 m of ground, which is a whole lot's worth, and the reason real hillside
 * streets are walled rather than sloped.
 */
function addEarthworks(
  buf: GeometryBuffer,
  terrain: Terrain,
  a: Vec2,
  b: Vec2,
  dir: Vec2,
  n: Vec2,
  half: number,
  surfaceY: (p: Vec2, lift: number) => number,
  wallMin: number,
): void {
  void dir;
  const len = V.dist(a, b);
  const steps = Math.max(1, Math.round(len / 4));

  for (const side of [1, -1] as const) {
    for (let i = 0; i < steps; i++) {
      const p0 = V.addScaled(V.lerp(a, b, i / steps), n, half * side);
      const p1 = V.addScaled(V.lerp(a, b, (i + 1) / steps), n, half * side);
      const y0 = surfaceY(p0, 0.035);
      const y1 = surfaceY(p1, 0.035);
      const g0 = terrain.heightAt(p0);
      const g1 = terrain.heightAt(p1);
      const d0 = y0 - g0;
      const d1 = y1 - g1;
      if (Math.abs(d0) < 0.08 && Math.abs(d1) < 0.08) continue;

      const wall = Math.max(Math.abs(d0), Math.abs(d1)) >= wallMin;
      buf.setColor(wall ? { r: 0.66, g: 0.65, b: 0.62 } : { r: 0.44, g: 0.43, b: 0.36 });

      // A batter leans away from the road; a wall drops straight down. Either
      // way the quad runs from the kerb line to where it meets the ground.
      const lean = wall ? 0.04 : Math.min(2.5, Math.abs(d0) * 1.5);
      const q0 = V.addScaled(p0, n, lean * side);
      const q1 = V.addScaled(p1, n, lean * side);

      // Winding depends on which side and whether we are above or below the
      // ground, so the face is emitted both ways — this is a thin sliver seen
      // from one side in practice, and a wrongly-wound one is invisible.
      buf.pushWorldTriangle(
        { x: p0.x, y: y0, z: p0.y },
        { x: p1.x, y: y1, z: p1.y },
        { x: q1.x, y: g1, z: q1.y },
      );
      buf.pushWorldTriangle(
        { x: p0.x, y: y0, z: p0.y },
        { x: q1.x, y: g1, z: q1.y },
        { x: q0.x, y: g0, z: q0.y },
      );
    }
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
