import type * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import type { Frame, LocalRect } from '../geom/obb.js';
import type { MaterialFamily } from '../material/materials.js';

export type ArchetypeId =
  | 'houseGable2F'
  | 'houseHip2F'
  | 'houseShedModern'
  | 'houseFlat3FUrban'
  | 'houseTraditionalKawara'
  | 'apartWood2F'
  | 'apartSteel2F'
  | 'apartRC3F'
  | 'mansionRC5F'
  | 'mansionRC9F'
  | 'shophouseWood2F'
  | 'shophouseRC3F'
  | 'zakkyoRC5F'
  | 'zakkyoRC8F'
  | 'konbiniBox'
  | 'factoryShed'
  | 'factoryRC2F'
  | 'warehouseBox';

/**
 * What stands on a lot. `LotKind` is this plus `vacant`.
 *
 * Declared here rather than beside `LotKind` because it is a property of the
 * building, and `city/Lots.ts` already imports from this module.
 */
export type BuildingKind =
  | 'house'
  | 'apart'
  | 'mansion'
  | 'shophouse'
  | 'zakkyo'
  | 'konbini'
  | 'factory'
  | 'warehouse';

export type RoofType = 'flat' | 'shed' | 'gable' | 'hip';
export type FootprintShape = 'rect' | 'L' | 'U' | 'T';
export type BalconyStyle = 'concrete' | 'louvre' | 'glass' | 'steel';
export type FenceStyle = 'block' | 'blockAndAluminium' | 'mesh' | 'hedge' | 'lowBlock';

/**
 * Three correlated numbers, from which twenty parameters are *derived*.
 *
 * This is the difference between "varied" and "noisy". Sampling every parameter
 * independently produces implausible combinations up close (a 1975 house with a
 * glass balcony rail and a mono-pitch roof) while averaging to uniform mush at
 * distance. Deriving everything from three correlated axes makes an implausible
 * building impossible to generate.
 */
export interface StyleVector {
  /** 0 = ~1970, 1 = ~2022. Sampled bimodally: real neighbourhoods come in waves. */
  era: number;
  wealth: number;
  formality: number;
}

/** Everything needed to build one building, fully derived before geometry starts. */
export interface BuildingSpec {
  archetype: ArchetypeId;
  style: StyleVector;
  kind: BuildingKind;

  footprintShape: FootprintShape;
  mirrored: boolean;
  /** Orientation in radians: the street-facing direction plus a small jitter. */
  facingAngle: number;

  floors: number;
  floorHeight: number;
  coverage: number;
  far: number;
  heightLimit: number;

  roofType: RoofType;
  /** Rise over run. */
  roofPitch: number;
  eaves: number;
  /** Ridge runs parallel to the street (平入り) rather than into it. */
  ridgeAlongStreet: boolean;
  parapetHeight: number;

  wallFamily: MaterialFamily;
  roofFamily: MaterialFamily;
  wallColor: THREE.Color;
  /** Lower band of a two-tone wall, when present. */
  bandColor: THREE.Color | null;
  bandHeight: number;
  roofColor: THREE.Color;
  accentColor: THREE.Color;
  sashColor: THREE.Color;
  /** Per-building overall value shift, applied as a vertex-colour multiplier. */
  valueShift: number;

  /** アパート / マンション: exterior corridor on the north or rear face. */
  hasExteriorCorridor: boolean;
  corridorWidth: number;
  balconyStyle: BalconyStyle;
  balconyDepth: number;
  /**
   * Rooftop plant. A 塔屋 for a マンション or a 雑居ビル, bare condensers for a
   * single-storey shop, nothing for a house — this was a `hasPenthouse` boolean
   * until a コンビニ needed the third case, and a lift overrun on a 1F shop is
   * exactly the kind of detail that reads as wrong without being nameable.
   */
  roofPlant: 'none' | 'penthouse' | 'condensers';
  /** Water tanks only appear on older buildings. */
  hasWaterTank: boolean;
  /** Window grilles (面格子) on ground-floor windows. */
  windowGrilleChance: number;
  /** Unit width for apartments and mansions, metres. */
  unitWidth: number;

  fenceStyle: FenceStyle;
  fenceHeight: number;
  wantsCarPad: boolean;
  /**
   * Centre of the parking space, filled in by `computeEnvelope`. The façade
   * grammar needs it so a garage opening lands at the end of the wall the car is
   * actually parked at, rather than at a coin-flip end.
   */
  carPadAt: Vec2 | null;
}

export interface SlantPlane {
  origin: Vec2;
  /** Points into the buildable side. */
  inwardNormal: Vec2;
  baseHeight: number;
  slope: number;
}

/**
 * Why a lot ended up with no building on it.
 *
 * A lot that cannot be built on used to be a `null` returned from somewhere
 * deep in the footprint fitter and thrown away by the renderer, so a bald patch
 * in the middle of a block had no explanation and no way to get one. These are
 * the reasons, ordered from "the generator gave up" to "no building belongs
 * here". Only the last two are legitimate outcomes.
 */
export type VacancyReason =
  /** Setbacks, the flag-lot pole and the car pad between them left nothing. */
  | 'no-buildable-area'
  /** There is buildable land, but less than a room's worth of it. */
  | 'buildable-too-small'
  /** Every composed mass, at every scale, clipped away to less than a room. */
  | 'no-footprint-fits'
  /** Long and thin: a building here would be a corridor, not a house. */
  | 'too-narrow'
  /** The lot was not offered a building at all — a bug if it ever appears. */
  | 'not-attempted'
  /**
   * The estate is laid out but this parcel has not been sold yet.
   *
   * The fringe of a growing suburb is full of these — a 分譲地 with its roads
   * and its 擁壁 already built, half its plots still 資材置場 or waiting for a
   * buyer. It is the most legible sign that the middle of the town is older
   * than the edge, and it is a *decision*, not a failure, which is why it goes
   * in `UNAVOIDABLE_VACANCY`: colouring it red on the debug overlay would mean
   * the generator had failed at the entire fringe.
   */
  | 'not-yet-developed';

/** Reasons that represent land genuinely not worth building on. */
export const UNAVOIDABLE_VACANCY: readonly VacancyReason[] = [
  'too-narrow',
  'buildable-too-small',
  'not-yet-developed',
];

export interface BuildEnvelope {
  buildable: Polygon | null;
  /** Set when `buildable` is null or unusably small; null when it is fine. */
  reason: VacancyReason | null;
  maxCoverage: number;
  maxFAR: number;
  absoluteHeightLimit: number;
  slantPlanes: SlantPlane[];
  /**
   * The parking space: a rectangle in one front corner of the lot, if any.
   * It used to be computed as lot-minus-buildable, which is an annulus whose
   * hole this pipeline drops — so it came back as the whole lot, parking the car
   * inside the house and suppressing every shrub on the lot.
   */
  carPad: Polygon | null;
}

export type WallRole = 'front' | 'side' | 'rear';

export interface Wall {
  a: Vec2;
  b: Vec2;
  len: number;
  /** Outward normal in plan. */
  normal: Vec2;
  dir: Vec2;
  role: WallRole;
  /** dot(normal, south) > 0.4 — where balconies and big windows go. */
  sunFacing: boolean;
  /** The face carrying the exterior corridor, for apartments. */
  isCorridorSide: boolean;
  /**
   * The one wall carrying the front door.
   *
   * Chosen once for the whole building rather than decided wall by wall. The
   * façade grammar used to put an entrance on *every* wall whose outward normal
   * came within 57° of the street, which gave 28% of the houses two or three
   * front doors and regularly put one on a wall several metres back from the
   * street behind the parking space — while a house whose street-facing wall was
   * a metre and a half long got none at all.
   */
  isEntrance: boolean;
  /**
   * How far anything may project from this wall before crossing the lot
   * boundary, metres. Balconies (1.0–2.1 m) and exterior corridors (1.1–1.8 m)
   * were being built at full depth against a 0.5 m side setback, so a mansion's
   * corridor and its neighbour's balcony overlapped by around 2.5 m.
   */
  room: number;
}

export interface Footprint {
  outline: Polygon;
  /**
   * Local-frame rectangles the shape was composed from; these drive the roof.
   * Empty on a conforming outline, which was not composed from rectangles and
   * therefore cannot carry a gable or a hip.
   */
  parts: LocalRect[];
  frame: Frame;
  clipped: boolean;
  /** Fraction of the composed shape that the buildable clip removed. */
  clippedFraction: number;
  /** The outline follows the lot boundary instead of being a clipped rectangle. */
  conform: boolean;
  walls: Wall[];
  area: number;
}

export interface Floor {
  polygon: Polygon;
  /** Walls derived from `polygon`, roles inherited from the base footprint. */
  walls: Wall[];
  y0: number;
  y1: number;
  index: number;
}

/**
 * A plan region carrying a uniform number of floors, from the ground up.
 *
 * 斜線制限 used to be expressed by clipping every floor into an arbitrary
 * polygon, which left the roof — built from the base footprint — hanging over a
 * shrunken top floor. Expressing it as *parts of the building having different
 * floor counts* is both what real buildings do and what keeps every roof sized
 * to the walls beneath it.
 */
export interface Stack {
  polygon: Polygon;
  /** Walls derived from `polygon`, roles inherited from the base footprint. */
  walls: Wall[];
  floors: number;
  y0: number;
  y1: number;
  /** The tallest stack keeps the archetype's roof; stepped-down parts go flat. */
  roofType: RoofType;
  /** Rectangles driving a pitched roof, expressed in `frame`. */
  parts: LocalRect[];
  frame: Frame;
  /** `polygon` is materially smaller than the union of `parts`: clip roof faces. */
  cut: boolean;
  /** Stepped down by a slant plane, so its top is a roof terrace. */
  stepped: boolean;
  /** 0 = tallest. */
  index: number;
}

export interface BuildingMass {
  /** Level-by-level plan outlines. Consumed by the façade builder. */
  floors: Floor[];
  /** Plan regions of uniform floor count, tallest first. Union == the footprint. */
  stacks: Stack[];
  /** Height of the tallest stack, excluding the roof. */
  height: number;
}
