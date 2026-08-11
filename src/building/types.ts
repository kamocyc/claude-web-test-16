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
  | 'mansionRC9F';

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
  kind: 'house' | 'apart' | 'mansion';

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
  /** マンション: rooftop plant. Water tanks only appear on older buildings. */
  hasPenthouse: boolean;
  hasWaterTank: boolean;
  /** Window grilles (面格子) on ground-floor windows. */
  windowGrilleChance: number;
  /** Unit width for apartments and mansions, metres. */
  unitWidth: number;

  fenceStyle: FenceStyle;
  fenceHeight: number;
  wantsCarPad: boolean;
}

export interface SlantPlane {
  origin: Vec2;
  /** Points into the buildable side. */
  inwardNormal: Vec2;
  baseHeight: number;
  slope: number;
}

export interface BuildEnvelope {
  buildable: Polygon | null;
  maxCoverage: number;
  maxFAR: number;
  absoluteHeightLimit: number;
  slantPlanes: SlantPlane[];
  /** Front setback area reserved for a car pad, if any. */
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
   * How far anything may project from this wall before crossing the lot
   * boundary, metres. Balconies (1.0–2.1 m) and exterior corridors (1.1–1.8 m)
   * were being built at full depth against a 0.5 m side setback, so a mansion's
   * corridor and its neighbour's balcony overlapped by around 2.5 m.
   */
  room: number;
}

export interface Footprint {
  outline: Polygon;
  /** Local-frame rectangles the shape was composed from; these drive the roof. */
  parts: LocalRect[];
  frame: Frame;
  clipped: boolean;
  /** Fraction of the composed shape that the buildable clip removed. */
  clippedFraction: number;
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
