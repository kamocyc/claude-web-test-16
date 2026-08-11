import { describe, it } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';

/**
 * Not an assertion suite — a printout of what the generator actually produces,
 * so the shape of the city can be checked at a glance while tuning.
 */
describe('city statistics', () => {
  it('reports counts and timings', () => {
    const params = cloneParams(DEFAULT_PARAMS);
    const t0 = performance.now();
    const city = generateCity(params);
    const total = performance.now() - t0;

    const counts: Record<string, number> = {};
    for (const l of city.lots) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
    const flag = city.lots.filter((l) => l.isFlagLot).length;
    const lotsPerBlock = new Map<number, number>();
    for (const l of city.lots) lotsPerBlock.set(l.blockId, (lotsPerBlock.get(l.blockId) ?? 0) + 1);
    const empty = city.blocks.filter((b) => !lotsPerBlock.has(b.id));
    const emptyArea = empty.reduce((s2, b) => s2 + b.area, 0);
    const noFrontage = city.blocks.filter((b) => b.edges.every((e) => e.cls === null)).length;
    const areas = city.lots.map((l) => l.area).sort((a, b) => a - b);
    const q = (f: number) => areas[Math.floor(areas.length * f)]?.toFixed(0) ?? '-';

    console.log(
      [
        '',
        `roads:      ${city.roads.edges.length} edges, ${city.roads.privateLanes.length} private lanes`,
        `blocks:     ${city.blocks.length} (rejected ${city.rejectedBlocks.length})`,
        `lots:       ${city.lots.length}  flag lots: ${flag}`,
        `kinds:      ${JSON.stringify(counts)}`,
        `lot area:   p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${areas[areas.length - 1]?.toFixed(0)}`,
        `clusters:   ${new Set(city.lots.map((l) => l.clusterId)).size}`,
        `empty blks: ${empty.length}/${city.blocks.length} covering ${emptyArea.toFixed(0)} m²` +
          ` (largest ${Math.max(0, ...empty.map((b) => b.area)).toFixed(0)} m²)`,
        `no frontage:${noFrontage} blocks`,
        `blk area:   max ${Math.max(...city.blocks.map((b) => b.area)).toFixed(0)} m²`,
        `timings:    ${Object.entries(city.timings).map(([k, v]) => `${k}=${v.toFixed(0)}ms`).join(' ')}`,
        `total:      ${total.toFixed(0)}ms`,
        '',
      ].join('\n'),
    );
  });
});
