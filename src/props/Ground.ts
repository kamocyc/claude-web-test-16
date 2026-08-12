import * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import * as V from '../geom/vec2.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { MaterialLibrary } from '../material/materials.js';
import type { City } from '../city/City.js';

/**
 * Ground plane, road surfaces and kerbs.
 *
 * Roads are ribbons of quads at y = 0.02 with a light concrete gutter strip
 * along each edge — the 側溝 that runs beside every Japanese local street. No
 * markings: this build deliberately leaves out road paint, guardrails and
 * street furniture.
 */
export function buildGround(city: City, params: CityParams, materials: MaterialLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground';

  const extent = params.roads.extent + 300;

  // Base plane.
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

  // Road surfaces.
  const asphalt = new GeometryBuffer();
  const kerb = new GeometryBuffer();

  /**
   * `extend` closes the gap at a junction by running the ribbon a little past
   * its node — but only where there is a second ribbon to close against. At a
   * dead end, and at both ends of a private lane, the node *is* the extent of
   * the land taken from the lots, and running past it puts asphalt over ground
   * a house is standing on.
   */
  const addRibbon = (a: Vec2, b: Vec2, width: number, extend: { start: boolean; end: boolean }) => {
    const d = V.sub(b, a);
    const l = V.len(d);
    if (l < 0.2) return;
    const dir = V.scale(d, 1 / l);
    const n = V.perp(dir);
    const half = width / 2;
    const over = half * 0.9;
    const a2 = V.addScaled(a, dir, extend.start ? -over : 0);
    const b2 = V.addScaled(b, dir, extend.end ? over : 0);

    const quad = (inner: number, outer: number, y: number, buf: GeometryBuffer): void => {
      const p: Polygon = [
        V.addScaled(a2, n, inner),
        V.addScaled(b2, n, inner),
        V.addScaled(b2, n, outer),
        V.addScaled(a2, n, outer),
      ];
      buf.pushCap(p, y, true);
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
    addRibbon(a, b, e.width, {
      start: (degree.get(e.a) ?? 0) > 1,
      end: (degree.get(e.b) ?? 0) > 1,
    });
  }
  for (const lane of city.roads.privateLanes) {
    addRibbon(lane.a, lane.b, lane.width, { start: false, end: false });
  }

  for (const [buf, family] of [
    [asphalt, 'asphalt'],
    [kerb, 'concrete'],
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
