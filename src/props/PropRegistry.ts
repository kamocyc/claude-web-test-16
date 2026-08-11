import * as THREE from 'three';
import type { Vec2 } from '../core/types.js';
import type { MaterialFamily, MaterialLibrary } from '../material/materials.js';

/**
 * Repeated site objects go through `InstancedMesh`: fence posts, gate posts,
 * mailboxes, planters, shrubs, car bodies, carport columns. A dozen instanced
 * meshes carry tens of thousands of objects for a dozen draw calls.
 *
 * Per-instance colour lives in `instanceColor`, mirroring the vertex-colour
 * approach used for buildings, so one material serves every variant.
 */

export type PropType =
  | 'fencePost'
  | 'aluminiumPanel'
  | 'meshPanel'
  | 'gatePost'
  | 'mailbox'
  | 'shrub'
  | 'pot'
  | 'hedgeUnit'
  | 'carportColumn'
  | 'carBody'
  | 'carCabin'
  | 'acUnit'
  | 'bicycle';

interface PropInstance {
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

interface PropDef {
  geometry: () => THREE.BufferGeometry;
  family: MaterialFamily;
  castShadow: boolean;
}

const DEFS: Record<PropType, PropDef> = {
  fencePost: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'concrete', castShadow: true },
  aluminiumPanel: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: false },
  meshPanel: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: false },
  gatePost: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'concrete', castShadow: true },
  mailbox: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: false },
  shrub: { geometry: () => new THREE.IcosahedronGeometry(0.5, 1), family: 'foliage', castShadow: true },
  pot: { geometry: () => new THREE.CylinderGeometry(0.4, 0.3, 1, 7), family: 'concrete', castShadow: false },
  hedgeUnit: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'foliage', castShadow: true },
  carportColumn: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: false },
  carBody: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: true },
  carCabin: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'glass', castShadow: false },
  acUnit: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: false },
  bicycle: { geometry: () => new THREE.BoxGeometry(1, 1, 1), family: 'metal', castShadow: false },
};

/**
 * The prop materials share the building material library, where every material
 * has `vertexColors: true`. Three defines `USE_COLOR` from the material flag,
 * but reads `vColor` from the geometry's `color` attribute — a primitive
 * geometry has none, so the attribute reads as zero and every instance renders
 * black regardless of its `instanceColor`. Filling in a unit colour attribute
 * makes `instanceColor` the only thing that tints them.
 */
function withUnitColors(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geometry.attributes.position!.count;
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geometry;
}

const UP = new THREE.Vector3(0, 1, 0);
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

export class PropRegistry {
  private instances = new Map<PropType, PropInstance[]>();

  /**
   * Add a box-like prop in plan coordinates. `dir` is the in-plane facing;
   * `w` runs across it, `d` along it.
   */
  add(
    type: PropType,
    at: Vec2,
    y: number,
    size: { w: number; h: number; d: number },
    dir: Vec2,
    color: { r: number; g: number; b: number },
  ): void {
    const m = new THREE.Matrix4();
    scratchPos.set(at.x, y, at.y);
    // The unit box's local +Z is the `d` axis and must end up along `dir`.
    // Rotating by `a` about +Y sends local +Z to (sin a, 0, cos a), and plan
    // `dir` maps to world (dir.x, 0, dir.y) — so a = atan2(dir.x, dir.y).
    scratchQuat.setFromAxisAngle(UP, Math.atan2(dir.x, dir.y));
    scratchScale.set(size.w, size.h, size.d);
    m.compose(scratchPos, scratchQuat, scratchScale);

    let list = this.instances.get(type);
    if (!list) this.instances.set(type, (list = []));
    list.push({ matrix: m, color: new THREE.Color(color.r, color.g, color.b) });
  }

  build(materials: MaterialLibrary): THREE.Group {
    const group = new THREE.Group();
    group.name = 'props';

    for (const [type, list] of this.instances) {
      if (list.length === 0) continue;
      const def = DEFS[type];
      const mesh = new THREE.InstancedMesh(
        withUnitColors(def.geometry()),
        materials.materials[def.family],
        list.length,
      );
      mesh.name = `prop:${type}`;
      mesh.castShadow = def.castShadow;
      mesh.receiveShadow = true;
      for (let i = 0; i < list.length; i++) {
        mesh.setMatrixAt(i, list[i]!.matrix);
        mesh.setColorAt(i, list[i]!.color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    return group;
  }

  get instanceCount(): number {
    let n = 0;
    for (const list of this.instances.values()) n += list.length;
    return n;
  }

  /** Approximate triangle count, for the stats readout. */
  get triangleCount(): number {
    let n = 0;
    for (const [type, list] of this.instances) {
      const per = type === 'shrub' ? 80 : type === 'pot' ? 28 : 12;
      n += list.length * per;
    }
    return n;
  }
}
