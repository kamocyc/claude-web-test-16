import * as THREE from 'three';
import type { Polygon } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import { makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import type { City } from '../city/City.js';
import { buildBuilding, type BuiltBuilding } from '../building/Builder.js';
import { makeBuildingSpec, clusterStyle } from '../building/style.js';
import type { StyleVector, VacancyReason } from '../building/types.js';
import type { Lot } from '../city/Lots.js';
import { buildGround } from '../props/Ground.js';
import { buildSiteProps } from '../props/SiteProps.js';
import { buildCommercialProps } from '../props/CommercialProps.js';
import { buildIndustrialProps } from '../props/IndustrialProps.js';
import { buildRetaining } from '../props/Retaining.js';
import { KIND_RULES } from '../building/kinds.js';
import { PropRegistry } from '../props/PropRegistry.js';
import type { MaterialLibrary } from '../material/materials.js';
import { ChunkedMeshBuilder } from './MeshMerger.js';
import { generationAge } from '../city/RoadGrowth.js';

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
    /** Lots that got no building, and why. */
    vacant: number;
    vacancyReasons: Partial<Record<VacancyReason, number>>;
  };
}

/** Generate all geometry for a city and merge it into renderable meshes. */
/** What the building pass decided, independently of any geometry. */
export interface BuildingPlan {
  buildings: BuiltBuilding[];
  vacant: number;
  vacancyReasons: Partial<Record<VacancyReason, number>>;
}

/**
 * Decide what stands on every lot.
 *
 * Separated from mesh building because it used to be *inside* it: whether a lot
 * got a building was settled while writing vertex buffers, the answer was
 * thrown away, and so no headless caller — no test, no statistic — could see
 * that a lot had been left empty, let alone why. Materials and a DOM are needed
 * to draw a town; they are not needed to know what is in it.
 */
export function planBuildings(city: City, params: CityParams): BuildingPlan {
  // One style vector per 分譲地 cluster, shared by every lot in the run.
  const clusterStyles = new Map<number, StyleVector>();
  const styleOf = (clusterId: number): StyleVector => {
    let s = clusterStyles.get(clusterId);
    if (!s) clusterStyles.set(clusterId, (s = clusterStyle(params.seed, clusterId)));
    return s;
  };

  const buildings: BuiltBuilding[] = [];
  const vacancyReasons: Partial<Record<VacancyReason, number>> = {};
  const note = (lot: Lot, reason: VacancyReason) => {
    lot.kind = 'vacant';
    lot.vacancyReason = reason;
    vacancyReasons[reason] = (vacancyReasons[reason] ?? 0) + 1;
  };

  const growth = params.roads.growth;

  for (const lot of city.lots) {
    // `kind` is mutated in place below, so a second pass over the same city
    // would see last time's 'vacant' and refuse a spec — leaving the lot empty
    // for good, whatever the parameters now say. Clear it before asking.
    if (lot.kind === 'vacant') lot.kind = lot.zonedKind;
    lot.vacancyReason = null;

    // Has anyone bought this plot yet?
    //
    // The newest districts are laid out but not sold out, and this is the
    // clearest single expression of the thing growth exists to produce: a town
    // that is solid in the middle and thins toward the edge. Nothing else does
    // it as directly — lot *sizes* also grow outward, so counting parcels per
    // hectare actually reads the wrong way round without this.
    if (growth.enabled && growth.fringeVacancy > 0) {
      const age = generationAge(lot.generation, growth);
      // Its own sub-seed namespace, so changing the fringe rule cannot reshuffle
      // which roof colour every house in the town got.
      if (makeRng(subSeed(lot.seed, 'developed')).chance(growth.fringeVacancy * age)) {
        note(lot, 'not-yet-developed');
        continue;
      }
    }

    const spec = makeBuildingSpec(lot, styleOf(lot.clusterId), params.buildings);
    if (!spec) {
      note(lot, 'not-attempted');
      continue;
    }

    const attempt = buildBuilding(lot, spec, params.buildings);
    if (!attempt.ok) {
      note(lot, attempt.reason);
      continue;
    }
    buildings.push(attempt.building);
  }

  return { buildings, vacant: city.lots.length - buildings.length, vacancyReasons };
}

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
  const buildableDebug: Polygon[] = [];
  const footprintDebug: Polygon[] = [];

  const plan = planBuildings(city, params);
  const { buildings, vacancyReasons } = plan;

  for (const built of buildings) {
    const lot = built.lot;
    // The building was authored flat and is lifted onto its platform here. See
    // `ChunkedMeshBuilder.add` and `city/Platform.ts` for why that is the whole
    // of what a hillside costs the building code.
    const padY = lot.platform.padY;
    chunks.add(lot.centroid, built.buffers, padY);
    if (built.envelope.buildable) buildableDebug.push(built.envelope.buildable);
    footprintDebug.push(built.footprint.outline);
    props.withBase(padY, () => {
      buildSiteProps(props, lot, built.spec, built, params, makeRng(subSeed(lot.seed, 'props')));
      // A separate sub-seed namespace, so adding street furniture to the shops
      // cannot move the random stream that decides where a house's shrubs go.
      const kindGroup = KIND_RULES[built.spec.kind].group;
      if (kindGroup === 'commercial') {
        buildCommercialProps(props, lot, built.spec, built, params, makeRng(subSeed(lot.seed, 'shopProps')));
      } else if (kindGroup === 'industrial') {
        buildIndustrialProps(props, lot, built.spec, built, params, makeRng(subSeed(lot.seed, 'yardProps')));
      }
    });
  }

  // 擁壁, batters and the steps up from the street. Emitted for every lot, not
  // just the built ones: an empty parcel on a slope was still cut and still
  // needs holding up, and leaving those out puts a notch in every terrace.
  buildRetaining(chunks, city, params.platform);

  group.add(chunks.build(materials));
  group.add(buildGround(city, params, materials, buildings));
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
      vacant: plan.vacant,
      vacancyReasons,
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
