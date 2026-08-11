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

/** The generated city, before any geometry exists. */
export interface City {
  params: CityParams;
  roads: RoadNetwork;
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

  const roads = clock('roads', () => generateRoads(params.seed, params.roads));
  const extraction = clock('blocks', () =>
    extractBlocks(roads, params.seed, {
      ...DEFAULT_BLOCK_OPTIONS,
      laneClearance: params.roads.roadClearance,
    }),
  );
  const urbanity = clock('urbanity', () => makeUrbanityField(roads, params));

  const lots = clock('lots', () => {
    const out: Lot[] = [];
    for (const block of extraction.blocks) {
      out.push(...subdivideBlock(block, roads, params, out.length));
    }
    return out;
  });

  clock('zoning', () => assignZoning(lots, extraction.blocks, urbanity, params));

  return {
    params,
    roads,
    blocks: extraction.blocks,
    lots,
    urbanity,
    spurEdgeIds: extraction.spurEdgeIds,
    rejectedBlocks: extraction.rejected,
    timings: t,
  };
}
