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
 * How the street network is laid out.
 *
 * `warped` is the default: a grid built in a warped parameter space, thinned
 * and jogged, which is what an organically grown Japanese suburb looks like.
 * `grid` is the planned-development alternative — a plain orthogonal grid with
 * a couple of diagonal through-roads, coarser and much calmer.
 */
export type RoadLayout = 'warped' | 'grid';

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
  /** Long-wavelength warp: amplitude and wavelength. */
  warpAmplitude1: number;
  warpWavelength1: number;
  warpAmplitude2: number;
  warpWavelength2: number;
  /** Fraction of local edges deleted outright. */
  deleteFraction: number;
  /** Fraction of remaining local edges truncated into dead ends. */
  deadEndFraction: number;
  /** Fraction of 4-way junctions jogged into offset T-junctions. */
  jogFraction: number;
  jogDistance: number;
  nodeSnap: number;
  minEdgeLength: number;
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
  lots: LotParams;
  zoning: ZoningParams;
  buildings: BuildingParams;
  props: PropParams;
  render: RenderParams;
}

export const DEFAULT_PARAMS: CityParams = {
  seed: 'sakura-3',
  roads: {
    layout: 'warped',
    diagonalCount: 0,
    extent: 320,
    arterialCount: 2,
    arterialWidth: 13,
    collectorWidth: 7,
    collectorSpacing: 120,
    localWidth: 4.8,
    localSpacing: 45,
    gridSpacingVariation: 0.2,
    warpAmplitude1: 14,
    warpWavelength1: 180,
    warpAmplitude2: 4,
    warpWavelength2: 60,
    deleteFraction: 0.18,
    deadEndFraction: 0.12,
    jogFraction: 0.15,
    jogDistance: 6,
    nodeSnap: 2.5,
    minEdgeLength: 7,
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
    cutAngleJitter: 4,
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
  warped: {
    localSpacing: 45,
    warpAmplitude1: 14,
    warpAmplitude2: 4,
    deleteFraction: 0.18,
    deadEndFraction: 0.12,
    jogFraction: 0.15,
    diagonalCount: 0,
    collectorSpacing: 120,
  },
  grid: {
    // A complete orthogonal grid — every street runs the full width of the
    // town, nothing is deleted and nothing dead-ends — with the spacing between
    // neighbouring streets varying by ±20%, plus two diagonal through-roads.
    // Coarser than the warped layout: without the jogs and dead ends a 45 m
    // grid still reads as calm, and the blocks have to be deep enough for two
    // back-to-back rows of lots plus whatever the private lanes reach.
    localSpacing: 52,
    gridSpacingVariation: 0.2,
    warpAmplitude1: 0,
    warpAmplitude2: 0,
    deleteFraction: 0,
    deadEndFraction: 0,
    jogFraction: 0,
    diagonalCount: 2,
    // Every 4th grid line becomes a collector. Closer than that and too much of
    // the town fronts a wide road, which pushes the mix towards apartments.
    collectorSpacing: 210,
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
