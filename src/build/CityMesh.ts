import * as THREE from 'three';
import type { Polygon } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import { makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import type { City } from '../city/City.js';
import { buildBuilding, type BuiltBuilding } from '../building/Builder.js';
import { makeBuildingSpec, clusterStyle } from '../building/style.js';
import type { StyleVector } from '../building/types.js';
import { buildGround } from '../props/Ground.js';
import { buildSiteProps } from '../props/SiteProps.js';
import { PropRegistry } from '../props/PropRegistry.js';
import type { MaterialLibrary } from '../material/materials.js';
import { ChunkedMeshBuilder } from './MeshMerger.js';

export interface CityMeshResult {
  group: THREE.Group;
  buildings: BuiltBuilding[];
  buildableDebug: Polygon[];
  footprintDebug: Polygon[];
  stats: {
    buildings: number;
    triangles: number;
    meshes: number;
    chunks: number;
    propInstances: number;
    buildMs: number;
  };
}

/** Generate all geometry for a city and merge it into renderable meshes. */
export function buildCityMesh(
  city: City,
  params: CityParams,
  materials: MaterialLibrary,
): CityMeshResult {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'city';

  const chunks = new ChunkedMeshBuilder();
  const props = new PropRegistry();
  const buildings: BuiltBuilding[] = [];
  const buildableDebug: Polygon[] = [];
  const footprintDebug: Polygon[] = [];

  // One style vector per 分譲地 cluster, shared by every lot in the run.
  const clusterStyles = new Map<number, StyleVector>();
  const styleOf = (clusterId: number): StyleVector => {
    let s = clusterStyles.get(clusterId);
    if (!s) clusterStyles.set(clusterId, (s = clusterStyle(params.seed, clusterId)));
    return s;
  };

  for (const lot of city.lots) {
    const spec = makeBuildingSpec(lot, styleOf(lot.clusterId), params.buildings);
    if (!spec) continue;

    const built = buildBuilding(lot, spec, params.buildings);
    if (!built) {
      lot.kind = 'vacant';
      continue;
    }

    buildings.push(built);
    chunks.add(lot.centroid, built.buffers);
    if (built.envelope.buildable) buildableDebug.push(built.envelope.buildable);
    footprintDebug.push(built.footprint.outline);

    buildSiteProps(props, lot, spec, built, params, makeRng(subSeed(lot.seed, 'props')));
  }

  group.add(chunks.build(materials));
  group.add(buildGround(city, params, materials));
  group.add(props.build(materials));

  return {
    group,
    buildings,
    buildableDebug,
    footprintDebug,
    stats: {
      buildings: buildings.length,
      triangles: chunks.triangleCount + props.triangleCount,
      meshes: chunks.meshCount,
      chunks: chunks.chunkCount,
      propInstances: props.instanceCount,
      buildMs: performance.now() - t0,
    },
  };
}

/** Recursively dispose the geometry under a generated city group. */
export function disposeCityMesh(group: THREE.Object3D): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
  void V;
}
