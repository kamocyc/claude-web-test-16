import * as THREE from 'three';
import {
  makeAlcPanelTexture,
  makeConcreteBlockTexture,
  makeGroundTexture,
  makeKawaraTexture,
  makeMetalRoofTexture,
  makeMortarTexture,
  makeRibbedMetalTexture,
  makeShutterTexture,
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
  | 'alcPanel'
  | 'shutter'
  | 'roofMetal'
  | 'roofKawara'
  | 'roofRibbed'
  | 'glass'
  | 'metal'
  | 'ground'
  | 'asphalt'
  | 'water'
  | 'foliage';

export interface MaterialLibrary {
  materials: Record<MaterialFamily, THREE.Material>;
  /** Families that participate in building/prop merging, in a stable order. */
  buildingFamilies: MaterialFamily[];
  setEnvironment(env: THREE.Texture | null): void;
  setTexturesEnabled(on: boolean): void;
  /**
   * Glass reads as glass because of what it reflects. With no image-based
   * lighting there is nothing to reflect and every window becomes a black
   * hole, so switch it to a lighter, more diffuse glazing instead.
   */
  setIblAvailable(on: boolean): void;
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
    roofRibbed: makeRibbedMetalTexture(anisotropy),
    alcPanel: makeAlcPanelTexture(anisotropy),
    shutter: makeShutterTexture(anisotropy),
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
    roofRibbed: std(tex.roofRibbed.map, {
      normalMap: tex.roofRibbed.normal,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.55,
      metalness: 0.3,
    }),
    alcPanel: std(tex.alcPanel.map, {
      normalMap: tex.alcPanel.normal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.88,
    }),
    shutter: std(tex.shutter.map, {
      normalMap: tex.shutter.normal,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.55,
      metalness: 0.35,
    }),
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
    // The river. Smooth enough to take a sky reflection — which is the only
    // thing that makes a flat horizontal plane read as water rather than as
    // blue tarmac — and not quite opaque, so the bed shows through at the edges
    // where it is shallow.
    water: new THREE.MeshStandardMaterial({
      color: 0x33454a,
      roughness: 0.08,
      metalness: 0.1,
      envMapIntensity: 1.6,
      transparent: true,
      opacity: 0.86,
      vertexColors: false,
    }),
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
    ['roofRibbed', tex.roofRibbed],
    ['alcPanel', tex.alcPanel],
    ['shutter', tex.shutter],
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
      // Appended rather than slotted in beside their relatives: the order is the
      // chunk-merge order, and moving an existing family changes every mesh.
      'roofRibbed',
      'alcPanel',
      'shutter',
    ],
    setEnvironment(env) {
      for (const m of Object.values(materials)) {
        if (m instanceof THREE.MeshStandardMaterial) {
          m.envMap = env;
          m.needsUpdate = true;
        }
      }
    },
    setIblAvailable(on) {
      const glass = materials.glass as THREE.MeshStandardMaterial;
      glass.color.setHex(on ? 0x141c26 : 0x3f4a57);
      glass.roughness = on ? 0.06 : 0.22;
      glass.envMapIntensity = on ? 2.0 : 1.0;
      glass.needsUpdate = true;
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
