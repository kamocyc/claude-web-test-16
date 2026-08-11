import * as THREE from 'three';
import {
  makeConcreteBlockTexture,
  makeGroundTexture,
  makeKawaraTexture,
  makeMetalRoofTexture,
  makeMortarTexture,
  makeSidingTexture,
  makeTileTexture,
} from './textures.js';

/**
 * Material families.
 *
 * The load-bearing decision: **per-building colour lives in vertex colours, not
 * in materials.** That is what lets thousands of differently-coloured buildings
 * share one material and therefore merge into a handful of draw calls. Textures
 * are greyscale patterns centred on 1.0, so the vertex tint comes through
 * faithfully.
 */

export type MaterialFamily =
  | 'siding'
  | 'sidingVertical'
  | 'mortar'
  | 'tile'
  | 'concrete'
  | 'roofMetal'
  | 'roofKawara'
  | 'glass'
  | 'metal'
  | 'ground'
  | 'asphalt'
  | 'foliage';

export interface MaterialLibrary {
  materials: Record<MaterialFamily, THREE.Material>;
  /** Families that participate in building/prop merging, in a stable order. */
  buildingFamilies: MaterialFamily[];
  setEnvironment(env: THREE.Texture | null): void;
  setTexturesEnabled(on: boolean): void;
  dispose(): void;
}

function std(
  map: THREE.Texture | null,
  opts: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
    ...(map ? { map } : {}),
    ...opts,
  });
}

export function createMaterials(anisotropy: number): MaterialLibrary {
  const tex = {
    siding: makeSidingTexture('horizontal', anisotropy),
    sidingVertical: makeSidingTexture('vertical', anisotropy),
    mortar: makeMortarTexture(anisotropy),
    tile: makeTileTexture(anisotropy),
    concrete: makeConcreteBlockTexture(anisotropy),
    roofMetal: makeMetalRoofTexture(anisotropy),
    roofKawara: makeKawaraTexture(anisotropy),
    ground: makeGroundTexture(anisotropy),
  };

  const materials: Record<MaterialFamily, THREE.Material> = {
    siding: std(tex.siding.map, { normalMap: tex.siding.normal, normalScale: new THREE.Vector2(0.6, 0.6) }),
    sidingVertical: std(tex.sidingVertical.map, {
      normalMap: tex.sidingVertical.normal,
      normalScale: new THREE.Vector2(0.6, 0.6),
    }),
    mortar: std(tex.mortar.map, { normalMap: tex.mortar.normal, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.95 }),
    tile: std(tex.tile.map, { normalMap: tex.tile.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.6 }),
    concrete: std(tex.concrete.map, { normalMap: tex.concrete.normal, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.92 }),
    roofMetal: std(tex.roofMetal.map, {
      normalMap: tex.roofMetal.normal,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 0.5,
      metalness: 0.25,
    }),
    roofKawara: std(tex.roofKawara.map, { normalMap: tex.roofKawara.normal, normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.65 }),
    // Glass is the one family that does not take a vertex tint — what makes it
    // read as glass is the environment reflection, so it gets its own material.
    glass: new THREE.MeshStandardMaterial({
      color: 0x141c26,
      roughness: 0.06,
      metalness: 0.0,
      envMapIntensity: 2.0,
      vertexColors: false,
    }),
    metal: std(null, { roughness: 0.42, metalness: 0.55 }),
    ground: std(tex.ground.map, { roughness: 1.0 }),
    asphalt: std(null, { roughness: 0.96 }),
    foliage: std(null, { roughness: 0.95 }),
  };

  const textured = [
    ['siding', tex.siding],
    ['sidingVertical', tex.sidingVertical],
    ['mortar', tex.mortar],
    ['tile', tex.tile],
    ['concrete', tex.concrete],
    ['roofMetal', tex.roofMetal],
    ['roofKawara', tex.roofKawara],
    ['ground', tex.ground],
  ] as const;

  return {
    materials,
    buildingFamilies: [
      'siding',
      'sidingVertical',
      'mortar',
      'tile',
      'concrete',
      'roofMetal',
      'roofKawara',
      'glass',
      'metal',
      'foliage',
    ],
    setEnvironment(env) {
      for (const m of Object.values(materials)) {
        if (m instanceof THREE.MeshStandardMaterial) {
          m.envMap = env;
          m.needsUpdate = true;
        }
      }
    },
    setTexturesEnabled(on) {
      for (const [name, t] of textured) {
        const m = materials[name];
        if (m instanceof THREE.MeshStandardMaterial) {
          m.map = on ? t.map : null;
          m.normalMap = on ? t.normal : null;
          m.needsUpdate = true;
        }
      }
    },
    dispose() {
      for (const m of Object.values(materials)) m.dispose();
      for (const [, t] of textured) {
        t.map.dispose();
        t.normal?.dispose();
      }
    },
  };
}
