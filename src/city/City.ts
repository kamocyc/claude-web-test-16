import type { CityParams } from '../core/params.js';
import {
  DEFAULT_BLOCK_OPTIONS,
  extractBlocks,
  type Block,
  type BlockExtraction,
} from './Blocks.js';
import { generateRoads, type RoadNetwork } from './Roads.js';
import { subdivideBlock, type Lot } from './Lots.js';
import { assignZoning, makeUrbanityField, type UrbanityField } from './Zoning.js';
import { makeTerrain, type Terrain } from '../terrain/Terrain.js';
import { makeObstacles, type ObstacleField } from '../terrain/Obstacles.js';
import {
  solveLaneProfiles,
  solveRoadProfile,
  type LaneHeights,
  type RoadHeights,
} from './RoadProfile.js';
import { assignPlatforms } from './Platform.js';

/** The generated city, before any geometry exists. */
export interface City {
  params: CityParams;
  /** The land. `FLAT_TERRAIN` when terrain is off — never null. */
  terrain: Terrain;
  obstacles: ObstacleField;
  roads: RoadNetwork;
  /** Design height of every road node. Zero everywhere on flat ground. */
  roadHeights: RoadHeights;
  /**
   * Design height along every 私道. Solved after the lots, because that is when
   * the lanes exist — they are cut by the subdivider, not by the road generator.
   */
  laneHeights: LaneHeights;
  blocks: Block[];
  lots: Lot[];
  urbanity: UrbanityField;
  spurEdgeIds: Set<number>;
  rejectedBlocks: BlockExtraction['rejected'];
  timings: Record<string, number>;
}

export function generateCity(params: CityParams): City {
  const t: Record<string, number> = {};
  const clock = <T,>(name: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    t[name] = performance.now() - t0;
    return r;
  };

  // The land comes first. Roads are routed around it, blocks are cut out of it,
  // and lots are levelled into it — so nothing downstream can be built until it
  // exists. When terrain is off this is `FLAT_TERRAIN` and every query answers
  // zero, which is exactly the town this generator used to make.
  const terrain = clock('terrain', () => makeTerrain(params.seed, params.terrain, params.roads.extent));
  const obstacles = clock('obstacles', () => makeObstacles(terrain, params.roads.growth));

  const roads = clock('roads', () =>
    generateRoads(params.seed, params.roads, params.landUse, params.lots, terrain, obstacles),
  );
  // Road heights are solved before the blocks are cut, because a lot's platform
  // is levelled to the height of the street it fronts, not to the ground it
  // stands on.
  const roadHeights = clock('profile', () => solveRoadProfile(roads, terrain, params.roads));

  const extraction = clock('blocks', () =>
    extractBlocks(roads, params.seed, {
      ...DEFAULT_BLOCK_OPTIONS,
      laneClearance: params.roads.roadClearance,
      obstacles,
    }),
  );
  const urbanity = clock('urbanity', () => makeUrbanityField(roads, params));

  const lots = clock('lots', () => {
    const out: Lot[] = [];
    for (const block of extraction.blocks) {
      out.push(...subdivideBlock(block, roads, params, out.length, obstacles));
    }
    return out;
  });

  clock('zoning', () => assignZoning(lots, extraction.blocks, urbanity, params));
  // The lanes only exist once the blocks have been subdivided, so their profile
  // is solved here rather than beside the road one — and before the platforms,
  // which level a lot fronting a lane to the lane.
  const laneHeights = clock('lanes', () =>
    solveLaneProfiles(roads, terrain, roadHeights, params.roads),
  );
  clock('platforms', () =>
    assignPlatforms(lots, roads, terrain, roadHeights, laneHeights, params.platform),
  );

  return {
    params,
    terrain,
    obstacles,
    roads,
    roadHeights,
    laneHeights,
    blocks: extraction.blocks,
    lots,
    urbanity,
    spurEdgeIds: extraction.spurEdgeIds,
    rejectedBlocks: extraction.rejected,
    timings: t,
  };
}
