import type { BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import type { Lot } from '../city/Lots.js';
import {
  type Palette,
  ACCENT,
  CONCRETE,
  ROOF_KAWARA,
  ROOF_METAL,
  ROOF_RIBBED,
  SASH,
  SHOPFRONT,
  WALL_ALC,
  WALL_INDUSTRIAL,
  WALL_MORTAR,
  WALL_RC_TILE,
  WALL_SIDING,
  sampleBandColor,
  sampleColor,
  sampleRoofColor,
  type Hsv,
} from '../material/palettes.js';
import type {
  ArchetypeId,
  BalconyStyle,
  BuildingKind,
  BuildingSpec,
  FenceStyle,
  RoofType,
  StyleVector,
} from './types.js';
import { KIND_RULES } from './kinds.js';

/**
 * Archetype selection and the correlated style vector.
 *
 * The most likely aesthetic failure for a generator like this is a city that
 * looks *noisy* rather than *varied*. Three mechanisms guard against that, in
 * order of impact: constrained per-archetype ranges, the derived style vector,
 * and 分譲地 cluster coherence.
 */

interface ArchetypeDef {
  id: ArchetypeId;
  kind: BuildingKind;
  weight: number;
  floors: [number, number];
  /**
   * Weighted, not uniform. 片流れ is the single most over-used roof in
   * procedural work — it is trivially exact on any polygon, so every fallback
   * path reaches for it — and a street of mono-pitches reads as generated. The
   * weights keep it a minority within each archetype that can carry one.
   */
  roof: [RoofType, number][];
  /** Era range this archetype plausibly belongs to. */
  era: [number, number];
}

const ARCHETYPES: ArchetypeDef[] = [
  { id: 'houseTraditionalKawara', kind: 'house', weight: 0.9, floors: [1, 2], roof: [['hip', 3], ['gable', 2]], era: [0.0, 0.35] },
  { id: 'houseGable2F', kind: 'house', weight: 3.0, floors: [2, 2], roof: [['gable', 1]], era: [0.1, 0.9] },
  { id: 'houseHip2F', kind: 'house', weight: 2.2, floors: [2, 2], roof: [['hip', 1]], era: [0.05, 0.8] },
  { id: 'houseShedModern', kind: 'house', weight: 0.9, floors: [2, 2], roof: [['shed', 1]], era: [0.6, 1.0] },
  { id: 'houseFlat3FUrban', kind: 'house', weight: 1.0, floors: [3, 3], roof: [['flat', 3], ['shed', 1]], era: [0.55, 1.0] },
  { id: 'apartWood2F', kind: 'apart', weight: 2.2, floors: [2, 2], roof: [['gable', 4], ['shed', 1]], era: [0.0, 0.5] },
  { id: 'apartSteel2F', kind: 'apart', weight: 1.8, floors: [2, 3], roof: [['flat', 2], ['shed', 1]], era: [0.35, 0.9] },
  { id: 'apartRC3F', kind: 'apart', weight: 1.2, floors: [3, 4], roof: [['flat', 1]], era: [0.45, 1.0] },
  { id: 'mansionRC5F', kind: 'mansion', weight: 2.0, floors: [4, 6], roof: [['flat', 1]], era: [0.2, 1.0] },
  { id: 'mansionRC9F', kind: 'mansion', weight: 1.0, floors: [7, 10], roof: [['flat', 1]], era: [0.35, 1.0] },
  // 店舗併用住宅: an old timber shop with a tiled roof, or a post-war RC one.
  { id: 'shophouseWood2F', kind: 'shophouse', weight: 1.6, floors: [2, 2], roof: [['gable', 3], ['shed', 1]], era: [0.0, 0.5] },
  { id: 'shophouseRC3F', kind: 'shophouse', weight: 1.4, floors: [3, 3], roof: [['flat', 1]], era: [0.4, 1.0] },
  { id: 'zakkyoRC5F', kind: 'zakkyo', weight: 2.0, floors: [4, 6], roof: [['flat', 1]], era: [0.25, 1.0] },
  { id: 'zakkyoRC8F', kind: 'zakkyo', weight: 1.0, floors: [6, 8], roof: [['flat', 1]], era: [0.4, 1.0] },
  { id: 'konbiniBox', kind: 'konbini', weight: 1.0, floors: [1, 1], roof: [['flat', 1]], era: [0.6, 1.0] },
  // 折板 sheds. `buildShedRoof` clamps the rise to 2.8 m, so a 30 m span comes
  // out at about 1:11 — which is exactly the pitch 折板 is laid at.
  { id: 'factoryShed', kind: 'factory', weight: 2.0, floors: [1, 1], roof: [['gable', 3], ['shed', 2]], era: [0.15, 1.0] },
  { id: 'factoryRC2F', kind: 'factory', weight: 0.8, floors: [2, 2], roof: [['flat', 1]], era: [0.3, 1.0] },
  { id: 'warehouseBox', kind: 'warehouse', weight: 1.5, floors: [1, 1], roof: [['shed', 2], ['flat', 1]], era: [0.3, 1.0] },
];

/**
 * Bimodal era: real neighbourhoods have generational waves (a 1975–1990 build-out
 * and a 2000–2020 one), not a flat spread.
 */
function sampleEra(rng: Rng): number {
  return rng.chance(0.45)
    ? rng.gaussClamped(0.22, 0.11, 0, 1)
    : rng.gaussClamped(0.78, 0.13, 0, 1);
}

/** The per-cluster style seed, shared by every lot in a 分譲地 run. */
export function clusterStyle(citySeed: string, clusterId: number): StyleVector {
  const rng = makeRng(subSeed(citySeed, 'cluster', clusterId));
  return {
    era: sampleEra(rng),
    wealth: rng.gaussClamped(0.5, 0.2, 0, 1),
    formality: rng.gaussClamped(0.5, 0.22, 0, 1),
  };
}

/**
 * A lot's style vector: the cluster's, with sigma cut by six.
 *
 * This deliberately reintroduces near-repetition, because that is what real
 * Japanese suburbs look like — five identical developer-built houses, then an
 * older varied stretch, then another run. It also makes the repetition that
 * does remain read as intentional rather than as a bug.
 */
export function lotStyle(base: StyleVector, rng: Rng): StyleVector {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    era: clamp01(base.era + rng.gauss(0, 0.035)),
    wealth: clamp01(base.wealth + rng.gauss(0, 0.05)),
    formality: clamp01(base.formality + rng.gauss(0, 0.06)),
  };
}

function pickArchetype(kind: BuildingKind, style: StyleVector, rng: Rng): ArchetypeDef {
  const candidates = ARCHETYPES.filter((a) => a.kind === kind).map((a) => {
    // Weight by how well the archetype's era range covers the sampled era.
    const mid = (a.era[0] + a.era[1]) / 2;
    const half = Math.max(0.05, (a.era[1] - a.era[0]) / 2);
    const fit = Math.exp(-Math.pow((style.era - mid) / half, 2));
    return [a, a.weight * (0.12 + fit)] as [ArchetypeDef, number];
  });
  return rng.weighted(candidates);
}

/**
 * Dispatch to the builder for this use.
 *
 * Split by group rather than folded into one table-driven function, and the
 * reason is specific: three of the draws below are *conditional* — the
 * floor-height jitter and the water tank for マンション, the car pad for 戸建 —
 * so a table of `(params, rng) => T` thunks would draw for every kind and shift
 * the random stream for every house and apartment in the town. `residentialSpec`
 * is the original function moved unchanged, which is what keeps the existing
 * town byte-identical; the constants the *rest* of the pipeline needs live in
 * `KIND_RULES`, consulted by all three builders.
 */
export function makeBuildingSpec(
  lot: Lot,
  clusterBase: StyleVector,
  params: BuildingParams,
): BuildingSpec | null {
  if (lot.kind === 'vacant') return null;
  switch (KIND_RULES[lot.kind].group) {
    case 'residential':
      return residentialSpec(lot, clusterBase, params);
    case 'commercial':
      return commercialSpec(lot, clusterBase, params);
    case 'industrial':
      return industrialSpec(lot, clusterBase, params);
  }
}

function residentialSpec(
  lot: Lot,
  clusterBase: StyleVector,
  params: BuildingParams,
): BuildingSpec | null {
  if (lot.kind === 'vacant') return null;
  const kind = lot.kind;
  const rng = makeRng(subSeed(lot.seed, 'style'));
  const style = lotStyle(clusterBase, rng);
  const arch = pickArchetype(kind, style, rng);

  // --- Materials, all derived from era and wealth --------------------------
  // era: mortar/spray -> siding -> large-format siding & ガルバ
  // wealth: siding -> tile (for RC), deeper gardens, garage over open carport
  let wallFamily: BuildingSpec['wallFamily'];
  let wallPalette: Palette;
  if (kind === 'mansion' || arch.id === 'apartRC3F') {
    wallFamily = style.wealth > 0.45 ? 'tile' : 'concrete';
    wallPalette = wallFamily === 'tile' ? WALL_RC_TILE : CONCRETE;
  } else if (style.era < 0.3) {
    wallFamily = 'mortar';
    wallPalette = WALL_MORTAR;
  } else {
    wallFamily = style.era > 0.75 && rng.chance(0.35) ? 'sidingVertical' : 'siding';
    wallPalette = WALL_SIDING;
  }

  const wall = sampleColor(wallPalette, rng, { h: 0.02, s: 0.06, v: 0.05 });

  // Roof material follows era: 瓦 -> coloured steel -> dark standing seam -> flat.
  const roofType: RoofType = rng.weighted(arch.roof);
  const useKawara = roofType !== 'flat' && style.era < 0.3 && rng.chance(0.75);
  const roofFamily: BuildingSpec['roofFamily'] = useKawara ? 'roofKawara' : roofType === 'flat' ? 'concrete' : 'roofMetal';
  const roof =
    roofType === 'flat'
      ? sampleColor(CONCRETE, rng, { h: 0.01, s: 0.03, v: 0.05 })
      : sampleRoofColor(useKawara ? ROOF_KAWARA : ROOF_METAL, params.roofHueMix, wall.hsv as Hsv, rng);

  // Two-tone walls split at the 1F/2F line.
  const wantsBand = kind !== 'mansion' && style.era > 0.45 && rng.chance(0.38);
  const band = wantsBand ? sampleBandColor(wall.hsv as Hsv, rng) : null;

  const floorHeight =
    kind === 'house'
      ? params.floorHeightHouse
      : kind === 'apart'
        ? params.floorHeightApart
        : params.floorHeightMansion + rng.jitter(0.1);

  // --- Shape ---------------------------------------------------------------
  const footprintShape: BuildingSpec['footprintShape'] =
    kind === 'house'
      ? rng.weighted([
          ['rect', 5],
          ['L', 3],
          ['T', 1],
        ])
      : kind === 'apart'
        ? rng.weighted([
            ['rect', 8],
            ['L', 2],
          ])
        : rng.weighted([
            ['rect', 6],
            ['L', 3],
            ['U', 2],
          ]);

  const balconyStyle: BalconyStyle =
    kind === 'mansion'
      ? style.era < 0.35
        ? 'concrete'
        : style.era < 0.75
          ? 'louvre'
          : rng.chance(0.5)
            ? 'glass'
            : 'louvre'
      : 'steel';

  const fenceStyle: FenceStyle = rng.weighted<FenceStyle>(
    style.era < 0.4
      ? [
          ['block', 5],
          ['blockAndAluminium', 2],
          ['hedge', 1.5],
          ['mesh', 1],
        ]
      : [
          ['blockAndAluminium', 4],
          ['lowBlock', 3],
          ['hedge', 2],
          ['block', 1.5],
          ['mesh', 1],
        ],
  );

  const isRC = kind === 'mansion' || arch.id === 'apartRC3F';

  return {
    archetype: arch.id,
    style,
    kind,
    footprintShape,
    // Mirroring doubles apparent variety for zero cost, and is literally what
    // developers do with a house plan.
    mirrored: rng.chance(params.mirrorChance),
    facingAngle: 0, // filled in by the footprint fitter, which knows the street
    floors: rng.int(arch.floors[1] - arch.floors[0] + 1) + arch.floors[0],
    floorHeight,
    coverage:
      kind === 'house' ? params.houseCoverage : kind === 'apart' ? params.apartCoverage : params.mansionCoverage,
    far: kind === 'house' ? params.houseFar : kind === 'apart' ? params.apartFar : params.mansionFar,
    heightLimit: kind === 'mansion' ? params.mansionHeightLimit : params.houseHeightLimit,

    roofType,
    // Tile wants a steeper pitch than metal.
    roofPitch: useKawara ? rng.range(0.45, 0.6) : rng.range(0.15, 0.3),
    eaves: (useKawara ? 1.15 : 1) * rng.range(params.eavesMin, params.eavesMax) * (style.era > 0.7 ? 0.75 : 1),
    // 平入り vs 妻入り.
    ridgeAlongStreet: rng.chance(0.65),
    parapetHeight: kind === 'mansion' ? rng.range(0.95, 1.2) : rng.range(0.45, 0.7),

    wallFamily,
    roofFamily,
    wallColor: wall.color,
    bandColor: band?.color ?? null,
    bandHeight: floorHeight,
    roofColor: roof.color,
    accentColor: sampleColor(ACCENT, rng, { h: 0.03, s: 0.08, v: 0.06 }).color,
    sashColor: sampleColor(SASH, rng, { h: 0.01, s: 0.04, v: 0.04 }).color,
    valueShift: 1 + rng.jitter(0.06),

    hasExteriorCorridor: kind !== 'house',
    corridorWidth: kind === 'mansion' ? rng.range(1.5, 1.8) : rng.range(1.1, 1.35),
    balconyStyle,
    balconyDepth: kind === 'mansion' ? rng.range(1.7, 2.1) : rng.range(1.0, 1.35),
    roofPlant: kind === 'mansion' ? 'penthouse' : 'none',
    // The 塔屋 + 高置水槽 silhouette is the strongest マンション signal at distance.
    hasWaterTank: kind === 'mansion' && style.era < 0.55 && rng.chance(0.7),
    windowGrilleChance: style.era < 0.5 ? 0.42 : 0.16,
    unitWidth: kind === 'mansion' ? rng.range(6.2, 8.0) : rng.range(3.3, 4.0),

    fenceStyle,
    fenceHeight: fenceStyle === 'lowBlock' ? rng.range(0.5, 0.8) : rng.range(1.2, 1.85),
    wantsCarPad: kind === 'house' && rng.chance(0.82),
    carPadAt: null, // filled in by computeEnvelope, which knows the lot
    ...(isRC ? {} : {}),
  };
}

/**
 * 店舗併用住宅, 雑居ビル and コンビニ.
 *
 * A separate function from the residential one rather than more branches inside
 * it, so that neither disturbs the other's random stream. The style vector still
 * comes from the 分譲地 cluster, which matters most for a shophouse row: the run
 * that went up together shares an era, and the terrace reads as one development.
 */
function commercialSpec(
  lot: Lot,
  clusterBase: StyleVector,
  params: BuildingParams,
): BuildingSpec | null {
  if (lot.kind === 'vacant') return null;
  const kind = lot.kind;
  const rule = KIND_RULES[kind];
  const rng = makeRng(subSeed(lot.seed, 'style'));
  const style = lotStyle(clusterBase, rng);
  const arch = pickArchetype(kind, style, rng);

  const isRC = arch.id !== 'shophouseWood2F';
  const wallFamily: BuildingSpec['wallFamily'] = !isRC
    ? style.era < 0.35
      ? 'mortar'
      : 'siding'
    : style.wealth > 0.5
      ? 'tile'
      : 'alcPanel';
  const wallPalette: Palette =
    wallFamily === 'tile'
      ? WALL_RC_TILE
      : wallFamily === 'alcPanel'
        ? WALL_ALC
        : wallFamily === 'mortar'
          ? WALL_MORTAR
          : WALL_SIDING;
  const wall = sampleColor(wallPalette, rng, { h: 0.02, s: 0.05, v: 0.05 });

  const roofType: RoofType = rng.weighted(arch.roof);
  const useKawara = roofType !== 'flat' && style.era < 0.35 && rng.chance(0.7);
  const roofFamily: BuildingSpec['roofFamily'] = useKawara
    ? 'roofKawara'
    : roofType === 'flat'
      ? 'concrete'
      : 'roofMetal';
  const roof =
    roofType === 'flat'
      ? sampleColor(CONCRETE, rng, { h: 0.01, s: 0.03, v: 0.05 })
      : sampleRoofColor(useKawara ? ROOF_KAWARA : ROOF_METAL, params.roofHueMix, wall.hsv as Hsv, rng);

  const floorHeight = params[rule.floorHeight];

  return {
    archetype: arch.id,
    style,
    kind,
    // Never notched. A shophouse fills its frontage wall to wall — that is what
    // makes the row a row — and a コンビニ is a plain box by construction.
    footprintShape: 'rect',
    mirrored: rng.chance(params.mirrorChance),
    facingAngle: 0,
    floors: rng.int(arch.floors[1] - arch.floors[0] + 1) + arch.floors[0],
    floorHeight,
    coverage: params[rule.coverage],
    far: params[rule.far],
    heightLimit: params[rule.heightLimit],

    roofType,
    roofPitch: useKawara ? rng.range(0.4, 0.55) : rng.range(0.12, 0.25),
    eaves: rng.range(params.eavesMin, params.eavesMax) * 0.8,
    ridgeAlongStreet: true,
    parapetHeight: kind === 'konbini' ? rng.range(1.0, 1.15) : rng.range(0.6, 1.1),

    wallFamily,
    roofFamily,
    wallColor: wall.color,
    bandColor: null,
    bandHeight: floorHeight,
    roofColor: roof.color,
    // The 看板 band and the shopfront frames take their colour from here, which
    // is why commercial accents come off their own, louder palette.
    accentColor: sampleColor(SHOPFRONT, rng, { h: 0.02, s: 0.07, v: 0.05 }).color,
    sashColor: sampleColor(SASH, rng, { h: 0.01, s: 0.04, v: 0.04 }).color,
    valueShift: 1 + rng.jitter(0.05),

    hasExteriorCorridor: rule.corridor !== 'none',
    corridorWidth: rng.range(1.2, 1.5),
    balconyStyle: style.era < 0.5 ? 'concrete' : 'steel',
    balconyDepth: rng.range(0.9, 1.3),
    roofPlant: rule.roofPlant,
    hasWaterTank: kind === 'zakkyo' && style.era < 0.5 && rng.chance(0.6),
    windowGrilleChance: style.era < 0.5 ? 0.3 : 0.1,
    // One tenant frontage for a 雑居ビル, one shop bay for a 長屋.
    unitWidth: kind === 'zakkyo' ? rng.range(5.5, 8.0) : rng.range(3.6, 5.4),

    fenceStyle: 'lowBlock',
    fenceHeight: 0.4,
    wantsCarPad: false,
    carPadAt: null,
  };
}

/**
 * 工場 and 倉庫.
 *
 * Deliberately the least varied of the three. An industrial estate genuinely is
 * repetitive — pale ribbed sheds of much the same height, in much the same
 * grey-blue and sage — and pushing variety into it would be the "noisy rather
 * than varied" failure the whole generator is arranged against.
 */
function industrialSpec(
  lot: Lot,
  clusterBase: StyleVector,
  params: BuildingParams,
): BuildingSpec | null {
  if (lot.kind === 'vacant') return null;
  const kind = lot.kind;
  const rule = KIND_RULES[kind];
  const rng = makeRng(subSeed(lot.seed, 'style'));
  const style = lotStyle(clusterBase, rng);
  const arch = pickArchetype(kind, style, rng);

  const wallFamily: BuildingSpec['wallFamily'] =
    arch.id === 'factoryRC2F' ? 'concrete' : style.era > 0.5 ? 'alcPanel' : 'roofRibbed';
  const wall = sampleColor(
    wallFamily === 'concrete' ? CONCRETE : wallFamily === 'alcPanel' ? WALL_ALC : WALL_INDUSTRIAL,
    rng,
    { h: 0.015, s: 0.04, v: 0.05 },
  );

  const roofType: RoofType = rng.weighted(arch.roof);
  // 折板. Tagged with the same `RoofHue` families as the domestic palettes, so
  // `roofHueMix` still governs what the town reads as from the air.
  const roofFamily: BuildingSpec['roofFamily'] = roofType === 'flat' ? 'concrete' : 'roofRibbed';
  const roof =
    roofType === 'flat'
      ? sampleColor(CONCRETE, rng, { h: 0.01, s: 0.03, v: 0.05 })
      : sampleRoofColor(ROOF_RIBBED, params.roofHueMix, wall.hsv as Hsv, rng);

  const floorHeight = params[rule.floorHeight] * (0.85 + rng.next() * 0.3);

  return {
    archetype: arch.id,
    style,
    kind,
    footprintShape: 'rect',
    mirrored: rng.chance(params.mirrorChance),
    facingAngle: 0,
    floors: rng.int(arch.floors[1] - arch.floors[0] + 1) + arch.floors[0],
    floorHeight,
    coverage: params[rule.coverage],
    far: params[rule.far],
    heightLimit: params[rule.heightLimit],

    roofType,
    // 3/100 to 15/100. `buildShedRoof` clamps the rise to 2.8 m anyway, so a
    // wide span flattens further on its own — which is what 折板 is for.
    roofPitch: rng.range(0.05, 0.15),
    eaves: rng.range(0.25, 0.5),
    ridgeAlongStreet: rng.chance(0.5),
    parapetHeight: roofType === 'flat' ? rng.range(0.8, 1.0) : 0.3,

    wallFamily,
    roofFamily,
    wallColor: wall.color,
    bandColor: null,
    bandHeight: floorHeight,
    roofColor: roof.color,
    accentColor: sampleColor(ACCENT, rng, { h: 0.03, s: 0.06, v: 0.05 }).color,
    sashColor: sampleColor(SASH, rng, { h: 0.01, s: 0.04, v: 0.04 }).color,
    valueShift: 1 + rng.jitter(0.04),

    hasExteriorCorridor: false,
    corridorWidth: 0,
    balconyStyle: 'steel',
    balconyDepth: 0,
    roofPlant: rule.roofPlant,
    hasWaterTank: false,
    windowGrilleChance: 0,
    // Structural bay, not a dwelling — this drives the louvre and dock rhythm.
    unitWidth: rng.range(6.0, 9.0),

    fenceStyle: 'mesh',
    fenceHeight: rng.range(1.8, 2.2),
    wantsCarPad: false,
    carPadAt: null,
  };
}
