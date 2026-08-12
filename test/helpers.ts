import type { CityParams } from '../src/core/params.js';
import { makeTerrain } from '../src/terrain/Terrain.js';
import { makeObstacles } from '../src/terrain/Obstacles.js';
import { generateRoads, type RoadNetwork } from '../src/city/Roads.js';

/**
 * Build a road network the way `generateCity` does.
 *
 * Road generation needs the land it is routed over, and there are five call
 * sites in the suite that only want the network. Repeating the two-line
 * preamble at each of them is how one of them ends up quietly testing flat
 * ground for ever.
 */
export function roadsFor(params: CityParams): RoadNetwork {
  const terrain = makeTerrain(params.seed, params.terrain, params.roads.extent);
  const obstacles = makeObstacles(terrain, params.roads.growth);
  return generateRoads(params.seed, params.roads, params.landUse, terrain, obstacles);
}
