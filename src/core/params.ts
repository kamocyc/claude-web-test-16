/**
 * Every tunable number in one place, serialisable, and fed straight to the debug
 * UI. Distances are metres, angles degrees, probabilities [0, 1].
 */

/**
 * Roof colour families. Declared here rather than beside the palettes because
 * the mix between them is a setting, and `material/` already depends on `core/`
 * — the other direction would be a cycle.
 */
export type RoofHue = 'redBrown' | 'navy' | 'grey' | 'brown' | 'green';
export type RoofHueMix = Record<RoofHue, number>;

/**
 * How the street network is laid out. Both are the same generator — Tier-1
 * roads cut the town into districts, each district grids itself — differing
 * only in how much the districts are allowed to disagree with each other.
 *
 * `district` is the default: several districts at visibly different angles,
 * with dead ends and staggered junctions. An organically grown suburb, where
 * each development was fitted to the land it replaced.
 * `grid` is the planned 区画整理 alternative — one dominant orientation,
 * nothing deleted, nothing dead-ending, and a pair of diagonal through-roads.
 */
export type RoadLayout = 'district' | 'grid';

/**
 * Declared here rather than beside the road generator because `perimeterClass`
 * is a setting, and `city/` already depends on `core/` — the other direction
 * would be a cycle. `city/Roads.ts` re-exports it as the canonical name.
 */
export type RoadClass = 'arterial' | 'collector' | 'local' | 'private';

/**
 * 用途地域 — the use zone a *district* is designated as.
 *
 * Declared here for the same reason as `RoadClass`: the mix is a setting, and
 * `city/` already depends on `core/`. Keeping it here also lets `District`
 * carry its own zone without `RoadDistricts` importing the assignment.
 *
 * The distinction this type draws is the one Japanese planning already draws,
 * and the reason it is worth keeping in the type system: **用途地域 is the map**
 * — decided upstream, per district, before a single lot exists — while
 * `LotKind` is **what actually got built**, decided per lot from the geometry
 * the map made possible. A zone never places a building. It only says which
 * ones the geometric gates are allowed to consider.
 */
export type UseZone =
  | 'lowRise' // 第一種低層住居専用地域
  | 'midRise' // 第一種中高層住居専用地域・住居地域
  | 'neighbourCom' // 近隣商業地域
  | 'commercial' // 商業地域（駅前）
  | 'quasiIndust' // 準工業地域
  | 'industrial'; // 工業地域

export interface LandUseParams {
  /** Radius over which the station's pull on 商業地域 falls off, metres. */
  commercialCoreRadius: number;
  /** How far 近隣商業 may reach from the station along a wide road, metres. */
  neighbourhoodRadius: number;
  /** Target share of the town area given over to 工業地域, [0, 1]. */
  industrialShare: number;
  /** No industrial district may come closer than this to the station, metres. */
  industrialMinStationDist: number;
  /**
   * Street grid spacing inside an industrial district, metres.
   *
   * This is why land use has to be decided *inside* road generation rather than
   * after it. A factory parcel is 3,000–4,000 m²; the ordinary 45 m grid yields
   * blocks of 1,500–2,000 m², so no amount of lot-parameter tuning can produce
   * one. The zone has to reach back and coarsen the streets themselves.
   */
  industrialLocalSpacing: number;
  /** Ring 準工業 around the industrial belt, so a factory never abuts 低層住専. */
  quasiIndustrialRing: boolean;
  /** How much Tier-1 frontage counts toward being commercial, relative to the station. */
  arterialFrontageWeight: number;
  noiseScale: number;
  noiseWeight: number;
}

export interface RoadParams {
  layout: RoadLayout;
  /** Straight through-roads cutting across the grid. Used by the `grid` layout. */
  diagonalCount: number;
  /** Half-extent of the generated town, metres. */
  extent: number;
  arterialCount: number;
  arterialWidth: number;
  collectorWidth: number;
  collectorSpacing: number;
  localWidth: number;
  /** Nominal spacing of the local street grid before warping. */
  localSpacing: number;
  /**
   * `grid` layout only: how much neighbouring street spacings differ, as a
   * fraction of `localSpacing`. 0 is a perfectly even grid; 0.2 gives blocks
   * between 0.8× and 1.2× the nominal size, which is what a real 区画整理
   * development looks like once it has been fitted to the parcels it replaced.
   */
  gridSpacingVariation: number;
  /** Fraction of street spans deleted outright. */
  deleteFraction: number;
  /** Fraction of terminal spans truncated into dead ends. */
  deadEndFraction: number;
  nodeSnap: number;
  minEdgeLength: number;

  // --- District layout ------------------------------------------------------
  /** One grain for the whole town: how far the base axis tilts off north, degrees. */
  townAxisJitter: number;
  /** Bends per Tier-1 road. A real 幹線道路 has two or three, not ninety. */
  tier1BendCount: number;
  /** Hard cap on a single Tier-1 bend, degrees. */
  tier1MaxBend: number;
  /** Two Tier-1 roads may never come closer than this except where they cross, metres. */
  tier1MinSpacing: number;
  /**
   * Junctions sharper than this are not built. Acute crossings are what produce
   * the overlapping asphalt and the sliver blocks that get discarded, so this
   * is a hard constraint on the skeleton rather than a preference.
   */
  minJunctionAngle: number;
  /** How far a district's grid may rotate off its dominant boundary road, degrees. */
  districtAxisJitter: number;
  /** Faces below this get no local grid and stay a single block, m². */
  minDistrictArea: number;
  /** Floor on a local grid gap, metres. */
  minLocalSpacing: number;
  /** Share of local street lines given a 食い違い offset. */
  staggerFraction: number;
  staggerDistance: number;
  /** Probability a local street bends once, at one of its junctions. */
  localBendChance: number;
  /**
   * Cap on that bend, degrees. The bend sits *on* a junction, so every block
   * edge stays straight and every lot along a run keeps one exact frontage
   * direction — the street reads as bent without the houses fanning out.
   */
  localBendAngle: number;
  /** Gap required between the ribbons of two roads that do not share a node, metres. */
  roadClearance: number;
  /**
   * Close the town square with a road. Effectively mandatory: `extractFaces`
   * discards the single clockwise outer cycle, so without a ring the outermost
   * region is not a face and there are no boundary districts at all.
   */
  perimeterRoad: boolean;
  perimeterClass: RoadClass;
  /** Assign the road hierarchy to the district's own grid lines. */
  promoteGridLines: boolean;
}

export interface LotParams {
  minLotArea: number;
  maxLotArea: number;
  /**
   * Cap for parcels with wide frontage on an arterial or collector. Those
   * parcels are consolidated in reality, and they are the only places a
   * マンション can physically go — so the zoning rules never have to name one.
   */
  maxLotAreaMajor: number;
  /** Lot width and depth are larger along wide roads. */
  widthMeanMajor: number;
  depthMeanMajor: number;
  /**
   * Minimum street frontage, metres. Japan's 接道義務 is 2 m, but this doubles
   * as the acceptance test for leftover scraps, and a suburb is full of parcels
   * that never had to satisfy it — 未接道 slivers between two developments, the
   * corner a road widening left behind. Kept below the legal figure so those
   * survive as ground rather than vanishing.
   */
  minFrontage: number;
  /** Mean and spread of lot depth. */
  depthMean: number;
  depthSigma: number;
  depthMin: number;
  depthMax: number;
  /** Mean and spread of lot width along the street. */
  widthMean: number;
  widthSigma: number;
  widthMin: number;
  widthMax: number;
  /** Non-parallel side boundaries: sigma of the cut-direction jitter, degrees. */
  cutAngleJitter: number;
  /** A block core at least this large can be opened up with a private lane. */
  minCoreArea: number;
  /** A smaller core still supports flag lots reached by a pole. */
  flagLotMinCore: number;
  /** Width of a 私道 (designated private road). */
  privateLaneWidth: number;
  /** Width of a flag lot's pole (竿). */
  poleWidth: number;
  flagLotChance: number;
  /**
   * Parcels whose largest inscribed circle is smaller than this are discarded.
   * This, not `minLotArea`, is what actually rejects a scrap: a 3 m × 4 m corner
   * is 12 m² but only holds a 1.5 m circle. Lowering `minLotArea` without
   * lowering this changes nothing.
   */
  minInscribedRadius: number;
  /** Gutter allowance added to each road's half width. */
  gutterWidth: number;
  maxRecursionDepth: number;
}

export interface ZoningParams {
  stationRadius: number;
  arterialRadius: number;
  collectorRadius: number;
  noiseScale: number;
  noiseWeight: number;
  mansionMinArea: number;
  mansionMinFrontage: number;
  mansionMinUrbanity: number;
  apartMinArea: number;
  apartMinFrontage: number;
  apartUrbanityLo: number;
  apartUrbanityHi: number;
  /** Probability of cutting the flood fill when growing a 分譲地 cluster. */
  clusterCutChance: number;
}

export interface BuildingParams {
  /** Half-ken module. Everything in a façade snaps to this. */
  module: number;
  frontSetback: number;
  sideSetback: number;
  rearSetback: number;
  /**
   * Depth of the parking space from the street boundary. The pad is a rectangle
   * in one front corner of the lot, *not* a band across the whole frontage —
   * setting the whole front elevation back by a car's length wasted about 17% of
   * a median lot, and the wider the frontage the more it wasted.
   */
  carPadDepth: number;
  /** Width of the parking space along the street. */
  carPadWidth: number;
  /**
   * Fraction of the buildable area a footprint aims to occupy, before the
   * archetype's notch and the lot clip take their share. Together with the
   * coverage limit this is what actually decides how much garden is left; the
   * 建ぺい率 alone does not, because the setbacks usually bind first.
   */
  footprintFill: number;
  houseCoverage: number;
  houseFar: number;
  houseHeightLimit: number;
  apartCoverage: number;
  apartFar: number;
  mansionCoverage: number;
  mansionFar: number;
  mansionHeightLimit: number;
  /** 北側斜線: base height and slope for low-rise and mid-rise zones. */
  northSlantBaseLow: number;
  northSlantBaseMid: number;
  northSlantSlope: number;
  /** 道路斜線 slope. */
  roadSlantSlope: number;
  floorHeightHouse: number;
  floorHeightApart: number;
  floorHeightMansion: number;
  minFloorArea: number;
  /**
   * Build the outline from the buildable area itself on an irregular lot, rather
   * than composing module rectangles and clipping them.
   */
  conformIrregular: boolean;
  /**
   * Switch to the conforming outline when the largest inscribed rectangle covers
   * less than this fraction of the buildable area. A rectangle scores ~0.95, a
   * trapezoid ~0.8, a triangle ~0.5 — so 0.62 picks out triangles and strong
   * wedges and leaves every ordinary lot on the rectangle path.
   */
  conformFillThreshold: number;
  /** Corners sharper than this get a 隅切り chamfer, degrees. */
  conformCornerAngle: number;
  /** Length of the wall the chamfer leaves behind, metres. */
  conformCornerCut: number;
  /** Probability that an upper-floor bay aligns with the floor below. */
  bayAlignChance: number;
  /** Probability of mirroring the whole building. */
  mirrorChance: number;
  /** Building orientation jitter about the street normal, degrees. */
  orientationJitter: number;
  /**
   * How closely a lot-aligned footprint frame must still agree with the street
   * before it may be used, as |cos| of the angle between them. The footprint
   * fitter searches several frames and keeps whichever holds the largest
   * rectangle, so this is what stops a skewed side boundary from turning the
   * house away from the road it fronts. 0.97 is about 14°.
   */
  frameAlignMin: number;
  eavesMin: number;
  eavesMax: number;
  /**
   * Share of pitched roofs going to each colour family, as relative parts.
   *
   * The mix between these is the most visible single setting in the generator —
   * a town of 赤錆茶 and a town of 銀黒 read as different places from the air —
   * and the right answer is a matter of which suburb you have in mind, so it is
   * exposed rather than tuned. `sampleRoofColor` draws the family from these
   * before it draws a shade, so rejecting a shade for being too pale against its
   * wall can no longer move weight to another family — the numbers hold to
   * within a couple of points, and `test/buildings.test.ts` reports what
   * actually landed. The exception is 瓦, which carries no plain brown: that
   * share redistributes among the families the palette does have.
   */
  roofHueMix: RoofHueMix;
}

export interface PropParams {
  fences: boolean;
  parking: boolean;
  gates: boolean;
  vegetation: boolean;
  laundry: boolean;
  /** Fraction of house lots that get a parked car. */
  carChance: number;
  /** Fraction of house lots that get a carport roof. */
  carportChance: number;
  /** Fraction of balconies with laundry out. */
  laundryChance: number;
}

export interface RenderParams {
  shadows: boolean;
  shadowMapSize: number;
  shadowExtent: number;
  fog: boolean;
  fogDensity: number;
  /** Hour of day, 0–24, driving sun elevation and azimuth. */
  timeOfDay: number;
  exposure: number;
  textures: boolean;
}

export interface CityParams {
  seed: string;
  roads: RoadParams;
  landUse: LandUseParams;
  lots: LotParams;
  zoning: ZoningParams;
  buildings: BuildingParams;
  props: PropParams;
  render: RenderParams;
}

export const DEFAULT_PARAMS: CityParams = {
  seed: 'sakura-3',
  roads: {
    layout: 'district',
    diagonalCount: 2,
    extent: 320,
    arterialCount: 2,
    arterialWidth: 13,
    collectorWidth: 7,
    collectorSpacing: 170,
    localWidth: 4.8,
    localSpacing: 45,
    gridSpacingVariation: 0.18,
    deleteFraction: 0.1,
    deadEndFraction: 0.14,
    nodeSnap: 2.5,
    minEdgeLength: 7,
    townAxisJitter: 10,
    tier1BendCount: 2,
    tier1MaxBend: 12,
    tier1MinSpacing: 110,
    minJunctionAngle: 32,
    districtAxisJitter: 10,
    minDistrictArea: 3000,
    minLocalSpacing: 28,
    staggerFraction: 0.3,
    staggerDistance: 7,
    localBendChance: 0.3,
    localBendAngle: 4,
    roadClearance: 2.0,
    perimeterRoad: true,
    perimeterClass: 'local',
    promoteGridLines: false,
  },
  landUse: {
    commercialCoreRadius: 180,
    neighbourhoodRadius: 320,
    industrialShare: 0.18,
    industrialMinStationDist: 260,
    industrialLocalSpacing: 95,
    quasiIndustrialRing: true,
    arterialFrontageWeight: 0.4,
    noiseScale: 260,
    noiseWeight: 0.25,
  },
  lots: {
    minLotArea: 10,
    maxLotArea: 340,
    maxLotAreaMajor: 1500,
    widthMeanMajor: 21,
    depthMeanMajor: 24,
    minFrontage: 1.0,
    depthMean: 13.5,
    depthSigma: 2.5,
    depthMin: 9.5,
    depthMax: 24,
    widthMean: 8.5,
    widthSigma: 2,
    widthMin: 5,
    widthMax: 22,
    cutAngleJitter: 2.5,
    minCoreArea: 520,
    flagLotMinCore: 110,
    privateLaneWidth: 4,
    poleWidth: 2.6,
    flagLotChance: 0.55,
    minInscribedRadius: 0.9,
    gutterWidth: 0.5,
    maxRecursionDepth: 2,
  },
  zoning: {
    stationRadius: 700,
    arterialRadius: 90,
    collectorRadius: 60,
    noiseScale: 220,
    noiseWeight: 0.15,
    mansionMinArea: 400,
    mansionMinFrontage: 14,
    mansionMinUrbanity: 0.55,
    apartMinArea: 180,
    apartMinFrontage: 8,
    apartUrbanityLo: 0.3,
    apartUrbanityHi: 0.75,
    clusterCutChance: 0.25,
  },
  buildings: {
    module: 0.91,
    frontSetback: 0.8,
    sideSetback: 0.5,
    rearSetback: 0.8,
    carPadDepth: 5.0,
    carPadWidth: 3.0,
    footprintFill: 0.93,
    houseCoverage: 0.66,
    houseFar: 1.25,
    houseHeightLimit: 10,
    apartCoverage: 0.7,
    apartFar: 2.1,
    mansionCoverage: 0.7,
    mansionFar: 3.6,
    mansionHeightLimit: 31,
    northSlantBaseLow: 5,
    northSlantBaseMid: 10,
    northSlantSlope: 1.25,
    roadSlantSlope: 1.25,
    floorHeightHouse: 2.9,
    floorHeightApart: 2.75,
    floorHeightMansion: 3.0,
    minFloorArea: 19,
    conformIrregular: true,
    conformFillThreshold: 0.62,
    conformCornerAngle: 55,
    conformCornerCut: 1.2,
    bayAlignChance: 0.8,
    mirrorChance: 0.5,
    orientationJitter: 1.5,
    frameAlignMin: 0.97,
    eavesMin: 0.45,
    eavesMax: 0.75,
    roofHueMix: { redBrown: 22, navy: 18, grey: 38, brown: 12, green: 10 },
  },
  props: {
    fences: true,
    parking: true,
    gates: true,
    vegetation: true,
    laundry: true,
    carChance: 0.7,
    carportChance: 0.15,
    laundryChance: 0.45,
  },
  render: {
    shadows: true,
    shadowMapSize: 4096,
    shadowExtent: 260,
    fog: true,
    fogDensity: 0.0009,
    timeOfDay: 10.5,
    exposure: 1.0,
    textures: true,
  },
};

/**
 * Road-layout presets. Switching layout has to move several parameters at once —
 * a grid with the warped layout's 45 m spacing still reads as far too fine — so
 * the presets are kept here and applied as a group.
 */
export const ROAD_LAYOUT_PRESETS: Record<RoadLayout, Partial<RoadParams>> = {
  district: {
    localSpacing: 45,
    gridSpacingVariation: 0.18,
    arterialCount: 2,
    // The diagonals are the main source of districts that disagree with each
    // other: a district with one bounding road at 40° inherits an axis nothing
    // else in the town shares.
    diagonalCount: 2,
    collectorSpacing: 170,
    deleteFraction: 0.1,
    deadEndFraction: 0.14,
    staggerFraction: 0.3,
    localBendChance: 0.3,
    districtAxisJitter: 10,
    promoteGridLines: false,
  },
  grid: {
    // One orientation for the whole town, nothing deleted and nothing
    // dead-ending, plus two diagonal through-roads. Coarser than the district
    // layout: without the staggers and dead ends a 45 m grid still reads as
    // calm, and the blocks have to be deep enough for two back-to-back rows of
    // lots plus whatever the private lanes reach.
    localSpacing: 52,
    gridSpacingVariation: 0.2,
    // No arterials of its own: the hierarchy is assigned to the grid lines
    // instead, so a wide road never slices a block it was not part of.
    arterialCount: 0,
    diagonalCount: 2,
    collectorSpacing: 210,
    deleteFraction: 0,
    deadEndFraction: 0,
    staggerFraction: 0,
    localBendChance: 0,
    districtAxisJitter: 0,
    promoteGridLines: true,
  },
};

/** Apply a layout preset in place, leaving unrelated road parameters alone. */
export function applyRoadLayout(roads: RoadParams, layout: RoadLayout): RoadParams {
  Object.assign(roads, ROAD_LAYOUT_PRESETS[layout], { layout });
  return roads;
}

export function cloneParams(p: CityParams): CityParams {
  return structuredClone(p);
}

export const DEG = Math.PI / 180;
