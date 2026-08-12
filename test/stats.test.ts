import { describe, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { clearanceViolations } from '../src/city/RoadClearance.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { UNAVOIDABLE_VACANCY } from '../src/building/types.js';

/**
 * Not an assertion suite — a printout of what the generator actually produces,
 * so the shape of the city can be checked at a glance while tuning.
 */
describe('city statistics', () => {
  for (const layout of ['district', 'grid'] as RoadLayout[]) {
  it(`reports counts and timings (${layout} layout)`, () => {
    const params = cloneParams(DEFAULT_PARAMS);
    applyRoadLayout(params.roads, layout);
    const t0 = performance.now();
    const city = generateCity(params);
    const total = performance.now() - t0;

    // Run the building pass too. `kinds` used to be counted straight off the
    // zoning, so it summed to every lot and could not show a vacancy however
    // many there were — whether a lot got built on was decided later, inside the
    // mesh builder, and thrown away.
    const plan = planBuildings(city, params);
    const counts: Record<string, number> = {};
    for (const l of city.lots) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
    const unavoidable = city.lots.filter(
      (l) => l.vacancyReason !== null && UNAVOIDABLE_VACANCY.includes(l.vacancyReason),
    ).length;
    const flag = city.lots.filter((l) => l.isFlagLot).length;
    const lotsPerBlock = new Map<number, number>();
    for (const l of city.lots) lotsPerBlock.set(l.blockId, (lotsPerBlock.get(l.blockId) ?? 0) + 1);
    const empty = city.blocks.filter((b) => !lotsPerBlock.has(b.id));
    const emptyArea = empty.reduce((s2, b) => s2 + b.area, 0);
    const noFrontage = city.blocks.filter((b) => b.edges.every((e) => e.cls === null)).length;
    const areas = city.lots.map((l) => l.area).sort((a, b) => a - b);
    const q = (f: number) => areas[Math.floor(areas.length * f)]?.toFixed(0) ?? '-';

    // The district axes are the single number to watch while tuning: the town
    // is meant to read as a patchwork, and if every district lands within a
    // couple of degrees of the same angle it is one grid wearing a disguise.
    const axes = city.roads.districts.map((d) => ((d.axis * 180) / Math.PI + 360) % 90);
    // Grid axes live mod 90°, so 1° and 89° are two degrees apart, not 88.
    // Reporting the naive range makes an almost-uniform town look varied.
    let spread = 0;
    for (const a of axes) {
      for (const b of axes) {
        const d = Math.abs(a - b) % 90;
        spread = Math.max(spread, Math.min(d, 90 - d));
      }
    }
    // District *size* decides whether land use can be assigned per district at
    // all: a use zone is only as fine-grained as the faces it is painted on, and
    // a 工業団地 has to be one or two of these to read as a district rather than
    // a stray parcel.
    const dAreas = city.roads.districts.map((d) => d.area).sort((a, b) => a - b);
    const dq = (f: number) => dAreas[Math.floor(dAreas.length * f)]?.toFixed(0) ?? '-';

    const tier1 = city.roads.edges.filter((e) => e.cls !== 'local').length;
    const violations = clearanceViolations(city.roads, {
      clearance: params.roads.roadClearance,
      includeLanes: true,
    });

    console.log(
      [
        '',
        `layout:     ${layout}`,
        `roads:      ${city.roads.edges.length} edges (${tier1} tier-1), ${city.roads.privateLanes.length} private lanes`,
        `districts:  ${city.roads.districts.length}, axes ${axes.map((a) => a.toFixed(0)).join('/')} (spread ${spread.toFixed(0)}°)`,
        `dist area:  p10=${dq(0.1)} p50=${dq(0.5)} p90=${dq(0.9)} max=${dAreas[dAreas.length - 1]?.toFixed(0)} m²`,
        `clearance:  ${violations.length} violations`,
        `blocks:     ${city.blocks.length} (rejected ${city.rejectedBlocks.length})`,
        `lots:       ${city.lots.length}  flag lots: ${flag}`,
        `kinds:      ${JSON.stringify(counts)}`,
        `lot area:   p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${areas[areas.length - 1]?.toFixed(0)}`,
        `clusters:   ${new Set(city.lots.map((l) => l.clusterId)).size}`,
        `empty lots: ${plan.vacant}/${city.lots.length}` +
          ` (${((plan.vacant / city.lots.length) * 100).toFixed(1)}%),` +
          ` ${unavoidable} unavoidable — ${JSON.stringify(plan.vacancyReasons)}`,
        `empty blks: ${empty.length}/${city.blocks.length} covering ${emptyArea.toFixed(0)} m²` +
          ` (largest ${Math.max(0, ...empty.map((b) => b.area)).toFixed(0)} m²)`,
        `no frontage:${noFrontage} blocks`,
        `blk area:   max ${Math.max(...city.blocks.map((b) => b.area)).toFixed(0)} m²`,
        `timings:    ${Object.entries(city.timings).map(([k, v]) => `${k}=${v.toFixed(0)}ms`).join(' ')}`,
        `total:      ${total.toFixed(0)}ms`,
        '',
      ].join('\n'),
    );
  }, 60000);
  }
});
