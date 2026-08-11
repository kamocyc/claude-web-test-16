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

  const addRibbon = (a: Vec2, b: Vec2, width: number) => {
    const d = V.sub(b, a);
    const l = V.len(d);
    if (l < 0.2) return;
    const dir = V.scale(d, 1 / l);
    const n = V.perp(dir);
    const half = width / 2;
    // Extend slightly past each end so junctions close up.
    const a2 = V.addScaled(a, dir, -half * 0.9);
    const b2 = V.addScaled(b, dir, half * 0.9);

    const quad = (inner: number, outer: number, y: number, buf: GeometryBuffer): void => {
      const p: Polygon = [
        V.addScaled(a2, n, inner),
        V.addScaled(b2, n, inner),
        V.addScaled(b2, n, outer),
        V.addScaled(a2, n, outer),
      ];
      buf.pushCap(p, y, true);
    };

    asphalt.setColor({ r: 0.155, g: 0.157, b: 0.168 });
    quad(-half, half, 0.02, asphalt);

    // 側溝: a pale concrete gutter strip along each edge.
    kerb.setColor({ r: 0.72, g: 0.71, b: 0.68 });
    quad(half, half + 0.35, 0.035, kerb);
    quad(-half - 0.35, -half, 0.035, kerb);
  };

  for (const e of city.roads.edges) {
    addRibbon(city.roads.graph.node(e.a).p, city.roads.graph.node(e.b).p, e.width);
  }
  for (const lane of city.roads.privateLanes) {
    addRibbon(lane.a, lane.b, lane.width);
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
