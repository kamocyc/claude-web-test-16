import { describe, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { clearanceViolations } from '../src/city/RoadClearance.js';
import { districtAdjacency } from '../src/city/LandUse.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { UNBUILDABLE_VACANCY, UNSOLD_VACANCY } from '../src/building/types.js';
import { LAND_LOSS_REASONS, auditLand } from '../src/city/LandLoss.js';

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
    // Three figures, not one. "Unavoidable" summed the plot that has not sold
    // yet with the sliver no house could ever stand on, and they answer
    // different questions: one of them goes away if you age the town.
    const inGroup = (group: readonly typeof city.lots[number]['vacancyReason'][]) =>
      city.lots.filter((l) => l.vacancyReason !== null && group.includes(l.vacancyReason)).length;
    const unsold = inGroup(UNSOLD_VACANCY);
    const unbuildable = inGroup(UNBUILDABLE_VACANCY);
    const suspect = plan.vacant - unsold - unbuildable;
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

    // 用途地域. The two numbers that matter are the industrial share — the fill
    // is area-targeted and the districts are very uneven, so overshoot is the
    // failure mode — and whether the belt came out as one piece.
    const zones: Record<string, number> = {};
    for (const d of city.roads.districts) zones[d.zone] = (zones[d.zone] ?? 0) + 1;
    const indust = city.roads.districts.filter((d) => d.zone === 'industrial');
    const industArea = indust.reduce((s2, d) => s2 + d.area, 0);
    const townArea = Math.pow(2 * params.roads.extent, 2);
    const adj = districtAdjacency(city.roads.districts);
    const industIdx = new Set(indust.map((d) => city.roads.districts.indexOf(d)));
    let reached = 0;
    if (industIdx.size > 0) {
      const stack = [[...industIdx][0]!];
      const seen = new Set(stack);
      while (stack.length > 0) {
        const i = stack.pop()!;
        reached++;
        for (const j of adj[i]!) {
          if (!industIdx.has(j) || seen.has(j)) continue;
          seen.add(j);
          stack.push(j);
        }
      }
    }
    const stationDist = Math.min(
      ...indust.flatMap((d) => d.polygon.map((p) => Math.hypot(p.x - city.roads.station.x, p.y - city.roads.station.y))),
    );

    const tier1 = city.roads.edges.filter((e) => e.cls !== 'local').length;
    // What happened to every square metre of every block. The three columns
    // must add up to the block area by construction, so the interesting number
    // is `???` — land nobody recorded a decision about.
    const land = auditLand(city);
    const lostBy = LAND_LOSS_REASONS.filter((r) => land.byReason[r] >= 1)
      .sort((a, b) => land.byReason[b] - land.byReason[a])
      .map((r) => `${r}=${land.byReason[r].toFixed(0)}`)
      .join(' ');

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
        `zones:      ${JSON.stringify(zones)}`,
        `industrial: ${indust.length} districts / ${industArea.toFixed(0)} m²` +
          ` (${((industArea / townArea) * 100).toFixed(1)}%, target ${(params.landUse.industrialShare * 100).toFixed(0)}%),` +
          ` contiguous=${indust.length === 0 ? 'n/a' : reached === indust.length ? 'yes' : `NO (${reached}/${indust.length})`},` +
          ` station ${Number.isFinite(stationDist) ? stationDist.toFixed(0) : '-'} m`,
        `clearance:  ${violations.length} violations`,
        `blocks:     ${city.blocks.length} (rejected ${city.rejectedBlocks.length})`,
        `lots:       ${city.lots.length}  flag lots: ${flag}`,
        `kinds:      ${JSON.stringify(counts)}`,
        `lot area:   p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${areas[areas.length - 1]?.toFixed(0)}`,
        `clusters:   ${new Set(city.lots.map((l) => l.clusterId)).size}`,
        `empty lots: ${plan.vacant}/${city.lots.length}` +
          ` (${((plan.vacant / city.lots.length) * 100).toFixed(1)}%):` +
          ` ${unsold} unsold, ${unbuildable} unbuildable, ${suspect} suspect` +
          ` — ${JSON.stringify(plan.vacancyReasons)}`,
        `empty blks: ${empty.length}/${city.blocks.length} covering ${emptyArea.toFixed(0)} m²` +
          ` (largest ${Math.max(0, ...empty.map((b) => b.area)).toFixed(0)} m²)`,
        `no frontage:${noFrontage} blocks`,
        `blk area:   max ${Math.max(...city.blocks.map((b) => b.area)).toFixed(0)} m²`,
        `land:       ${land.blockArea.toFixed(0)} m² of blocks =` +
          ` ${land.lotArea.toFixed(0)} lots +` +
          ` ${land.rowArea.toFixed(0)} road +` +
          ` ${(land.blockArea - land.lotArea - land.rowArea).toFixed(0)} unused` +
          ` — waste ${(land.wasteShare * 100).toFixed(1)}%,` +
          ` ??? ${land.byReason.unaccounted.toFixed(0)} m² in ${land.unaccounted.length} pieces`,
        `land lost:  ${lostBy}`,
        `outside:    ${land.preBlockArea.toFixed(0)} m² discarded before any block`,
        `timings:    ${Object.entries(city.timings).map(([k, v]) => `${k}=${v.toFixed(0)}ms`).join(' ')}`,
        `total:      ${total.toFixed(0)}ms`,
        '',
      ].join('\n'),
    );
  }, 60000);
  }
});
