import type { BuildingParams } from '../core/params.js';
import type { BuildingKind } from './types.js';

/**
 * The names of the numeric entries of `BuildingParams`.
 *
 * `keyof BuildingParams` would also admit `conformIrregular` and `roofHueMix`,
 * so `params[rule.coverage]` would come back as `number | boolean | RoofHueMix`
 * and every use of it would need a cast. Naming a coverage parameter that is not
 * a number should be a compile error, not a cast.
 */
type NumericParam = {
  [K in keyof BuildingParams]: BuildingParams[K] extends number ? K : never;
}[keyof BuildingParams];


/**
 * One row per use, holding every constant the rest of the pipeline branches on.
 *
 * The pipeline used to ask `spec.kind === 'house'` in eight places, each with an
 * implicit `else` meaning "apartment". That reads fine with three residential
 * uses. With eight it is a trap: a new use silently inherits balconies, an
 * exterior corridor, laundry poles and a garden, and nothing fails — the town
 * just quietly contains factories with washing hung out on the second floor.
 *
 * A `Record<BuildingKind, …>` turns every one of those into a compile error
 * instead. That is the whole reason this table exists, more than the tidiness.
 *
 * **It holds constants only, never a draw from an `Rng`.** That restriction is
 * load-bearing and the obvious refactor violates it. Three of the draws in
 * `makeBuildingSpec` are *conditional* — the floor-height jitter and the water
 * tank are drawn for マンション alone, the car pad for 戸建 alone — so a table of
 * `(params, rng) => T` thunks, which necessarily draws for every kind, shifts
 * the random stream for every house and apartment in the town. Every building
 * would change, for a refactor that was supposed to change nothing.
 */
export interface KindRule {
  /**
   * Which spec builder makes this use. The split is by builder rather than by
   * table entry precisely because of the conditional-draw problem above: the
   * residential builder is the original function, moved verbatim.
   */
  group: 'residential' | 'commercial' | 'industrial';

  coverage: NumericParam;
  far: NumericParam;
  heightLimit: NumericParam;
  floorHeight: NumericParam;

  /**
   * 北側斜線 base height, or `none` where the restriction does not apply.
   *
   * Not a shortcut: 北側斜線 exists only in 低層住専 and 中高層住専. A factory in
   * 工業地域 and a 雑居ビル in 商業地域 are genuinely not subject to it, and saying
   * so here is the same move the whole generator is built on — implement the
   * regulation as a geometric constraint and the silhouette follows.
   */
  slantBase: 'low' | 'mid' | 'none';

  /**
   * Multipliers on the three setbacks.
   *
   * This is how a 長屋 gets its party walls: side 0, and nothing else. The
   * envelope pipeline is setback-driven end to end, so a zero side setback
   * propagates by itself to the buildable area, the footprint clip, `Wall.room`,
   * the eaves clamp, balcony suppression and the boundary fence. A
   * `sharesWallWith` flag would have to re-implement every one of those, and it
   * would be a lie besides: adjacent lots are generated independently, so their
   * side boundaries are not exactly collinear after cleaning. Building *to the
   * boundary* is the honest statement, and the residual gap is millimetres.
   */
  setbackScale: { front: number; side: number; rear: number };

  /** Exterior access deck: none, or the アパート / マンション flavour. */
  corridor: 'none' | 'apart' | 'mansion';
  /** Rooftop plant: a 塔屋, or just condensers, or nothing. */
  roofPlant: 'none' | 'penthouse' | 'condensers';
  /** Washing out on the balconies. */
  laundry: boolean;
  /** Boundary treatment. */
  fence: 'residential' | 'mesh' | 'none';
  gate: boolean;
  planting: boolean;
  /** Probability of a 駐車スペース notched out of the front corner. */
  carPadChance: number;

  /** Window sill height above the floor, metres. */
  sill: number;
  /** 竪樋 spacing along a wall, metres. */
  downspoutSpacing: number;
  /** Shrubs and pots on the leftover ground: `[base, extra]`, extra is random. */
  plantingBudget: [number, number];
  /**
   * The entrances are the unit doors on the access deck, so no single wall
   * carries a front door.
   */
  entranceOnCorridor: boolean;
  /** Whole-lot hardstanding — a forecourt or a yard — rather than a garden. */
  pavedLot: boolean;
  /**
   * May the outline follow the lot boundary on an irregular parcel?
   *
   * Yes for anything domestic: a 変形地 house really is designed around its
   * boundaries, and that route is what lets a wedge parcel be built on at all.
   * No for a shed or a shop. Those are catalogue rectangles that get put down in
   * the middle of whatever they are given, and forcing one to conform produces
   * something absurd — a コンビニ on a triangular corner came out as a 25 m × 3 m
   * ribbon along the frontage, because the only way to shrink a wedge to its
   * coverage limit while keeping the street wall is to push the back wall in
   * until the building is a corridor.
   */
  conform: boolean;
}

const RESIDENTIAL = { front: 1, side: 1, rear: 1 };

export const KIND_RULES: Record<BuildingKind, KindRule> = {
  house: {
    group: 'residential',
    coverage: 'houseCoverage',
    far: 'houseFar',
    heightLimit: 'houseHeightLimit',
    floorHeight: 'floorHeightHouse',
    slantBase: 'low',
    setbackScale: RESIDENTIAL,
    corridor: 'none',
    roofPlant: 'none',
    laundry: false,
    fence: 'residential',
    gate: true,
    planting: true,
    carPadChance: 0.82,
    sill: 0.95,
    downspoutSpacing: 5.5,
    plantingBudget: [3, 4],
    entranceOnCorridor: false,
    pavedLot: false,
    conform: true,
  },
  apart: {
    group: 'residential',
    coverage: 'apartCoverage',
    far: 'apartFar',
    heightLimit: 'houseHeightLimit',
    floorHeight: 'floorHeightApart',
    slantBase: 'low',
    setbackScale: RESIDENTIAL,
    corridor: 'apart',
    roofPlant: 'none',
    laundry: true,
    fence: 'residential',
    gate: true,
    planting: true,
    carPadChance: 0,
    sill: 0.9,
    downspoutSpacing: 5.5,
    plantingBudget: [2, 3],
    entranceOnCorridor: true,
    pavedLot: false,
    conform: true,
  },
  mansion: {
    group: 'residential',
    coverage: 'mansionCoverage',
    far: 'mansionFar',
    heightLimit: 'mansionHeightLimit',
    floorHeight: 'floorHeightMansion',
    slantBase: 'mid',
    setbackScale: RESIDENTIAL,
    corridor: 'mansion',
    roofPlant: 'penthouse',
    laundry: true,
    fence: 'residential',
    gate: true,
    planting: true,
    carPadChance: 0,
    sill: 0.9,
    downspoutSpacing: 7,
    plantingBudget: [2, 3],
    entranceOnCorridor: false,
    pavedLot: false,
    conform: true,
  },

  // --- Commercial -----------------------------------------------------------
  shophouse: {
    group: 'commercial',
    coverage: 'shopCoverage',
    far: 'shopFar',
    heightLimit: 'houseHeightLimit',
    floorHeight: 'floorHeightShop',
    slantBase: 'low',
    // 長屋. The front is set back a token amount rather than zero: `clipToRoads`
    // already keeps the lot a 0.5 m gutter clear of the carriageway, so 0.32 m
    // is safe with margin, whereas zero makes the no-building-on-a-road test a
    // coin flip against the cleaning tolerances.
    setbackScale: { front: 0.4, side: 0, rear: 1 },
    corridor: 'none',
    roofPlant: 'none',
    laundry: true,
    fence: 'none',
    gate: false,
    planting: false,
    carPadChance: 0,
    sill: 0.9,
    downspoutSpacing: 5,
    plantingBudget: [0, 2],
    entranceOnCorridor: false,
    pavedLot: false,
    conform: true,
  },
  zakkyo: {
    group: 'commercial',
    coverage: 'zakkyoCoverage',
    far: 'zakkyoFar',
    heightLimit: 'zakkyoHeightLimit',
    floorHeight: 'floorHeightTenant',
    slantBase: 'none',
    setbackScale: { front: 0.5, side: 0.3, rear: 0.6 },
    corridor: 'apart',
    roofPlant: 'penthouse',
    laundry: false,
    fence: 'none',
    gate: false,
    planting: false,
    carPadChance: 0,
    sill: 0.7,
    downspoutSpacing: 7,
    plantingBudget: [0, 1],
    entranceOnCorridor: false,
    pavedLot: true,
    conform: false,
  },
  konbini: {
    group: 'commercial',
    coverage: 'konbiniCoverage',
    far: 'shopFar',
    heightLimit: 'houseHeightLimit',
    floorHeight: 'floorHeightShop',
    slantBase: 'none',
    // Pushed right to the back of its plot. This is the defining move of a
    // roadside コンビニ and not a detail: the car park goes in front, and a shop
    // sitting on the pavement with its parking behind it is a different building
    // in a different decade. 8 × 0.8 m ≈ 6.4 m, a bay plus the aisle. The
    // concession ladder still pulls it forward on a plot too shallow to hold that.
    setbackScale: { front: 8, side: 1, rear: 0.4 },
    corridor: 'none',
    // Two or three condensers on the roof, not a 塔屋 — a single-storey shop has
    // no lift and no water tank, and giving it one is the sort of detail that
    // reads as wrong without the viewer being able to say why.
    roofPlant: 'condensers',
    laundry: false,
    fence: 'none',
    gate: false,
    planting: false,
    carPadChance: 0,
    sill: 0.3,
    downspoutSpacing: 6,
    plantingBudget: [0, 0],
    entranceOnCorridor: false,
    pavedLot: true,
    conform: false,
  },

  // --- Industrial -----------------------------------------------------------
  factory: {
    group: 'industrial',
    coverage: 'industrialCoverage',
    far: 'industrialFar',
    heightLimit: 'industrialHeightLimit',
    floorHeight: 'floorHeightFactory',
    slantBase: 'none',
    // A real 工場 sits well inside its fence, and this is what leaves room for
    // the yard the trucks turn in.
    setbackScale: { front: 2.5, side: 2, rear: 1 },
    corridor: 'none',
    roofPlant: 'none',
    laundry: false,
    fence: 'mesh',
    gate: false,
    planting: false,
    carPadChance: 0,
    sill: 1.4,
    downspoutSpacing: 9,
    plantingBudget: [0, 2],
    entranceOnCorridor: false,
    pavedLot: true,
    conform: false,
  },
  warehouse: {
    group: 'industrial',
    coverage: 'industrialCoverage',
    far: 'industrialFar',
    heightLimit: 'industrialHeightLimit',
    floorHeight: 'floorHeightWarehouse',
    slantBase: 'none',
    setbackScale: { front: 2.5, side: 2, rear: 1 },
    corridor: 'none',
    roofPlant: 'none',
    laundry: false,
    fence: 'mesh',
    gate: false,
    planting: false,
    carPadChance: 0,
    sill: 1.6,
    downspoutSpacing: 10,
    plantingBudget: [0, 0],
    entranceOnCorridor: false,
    pavedLot: true,
    conform: false,
  },
};

export const ruleFor = (kind: BuildingKind): KindRule => KIND_RULES[kind];
