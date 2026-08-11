/**
 * Every tunable number in one place, serialisable, and fed straight to the debug
 * UI. Distances are metres, angles degrees, probabilities [0, 1].
 */

export interface RoadParams {
  /** Half-extent of the generated town, metres. */
  extent: number;
  arterialCount: number;
  arterialWidth: number;
  collectorWidth: number;
  collectorSpacing: number;
  localWidth: number;
  /** Nominal spacing of the local street grid before warping. */
  localSpacing: number;
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
  /** Minimum street frontage, metres. Japan's 接道義務 is 2 m. */
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
  /** Parcels whose largest inscribed circle is smaller than this are discarded. */
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
  /** Extra front setback when a car pad is wanted. */
  carPadDepth: number;
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
  /** Probability that an upper-floor bay aligns with the floor below. */
  bayAlignChance: number;
  /** Probability of mirroring the whole building. */
  mirrorChance: number;
  /** Building orientation jitter about the street normal, degrees. */
  orientationJitter: number;
  eavesMin: number;
  eavesMax: number;
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
    extent: 320,
    arterialCount: 2,
    arterialWidth: 13,
    collectorWidth: 7,
    collectorSpacing: 120,
    localWidth: 4.8,
    localSpacing: 45,
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
    minLotArea: 52,
    maxLotArea: 340,
    maxLotAreaMajor: 1500,
    widthMeanMajor: 21,
    depthMeanMajor: 24,
    minFrontage: 4.0,
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
    minInscribedRadius: 1.8,
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
    carPadDepth: 2.6,
    houseCoverage: 0.62,
    houseFar: 1.25,
    houseHeightLimit: 10,
    apartCoverage: 0.68,
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
    bayAlignChance: 0.8,
    mirrorChance: 0.5,
    orientationJitter: 1.5,
    eavesMin: 0.45,
    eavesMax: 0.75,
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

export function cloneParams(p: CityParams): CityParams {
  return structuredClone(p);
}

export const DEG = Math.PI / 180;
