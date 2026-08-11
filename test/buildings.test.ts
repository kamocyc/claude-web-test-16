import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { makeBuildingSpec, clusterStyle } from '../src/building/style.js';
import { computeEnvelope, fitFootprint } from '../src/building/footprint.js';
import { buildMass } from '../src/building/mass.js';
import type { StyleVector } from '../src/building/types.js';
import { area, isSimple } from '../src/geom/polygon.js';
import { multiArea, intersectPoly } from '../src/geom/boolean.js';

function build(seed = 'bld-1') {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  params.roads.extent = 190;
  const city = generateCity(params);

  const styles = new Map<number, StyleVector>();
  const out = [];
  for (const lot of city.lots) {
    let s = styles.get(lot.clusterId);
    if (!s) styles.set(lot.clusterId, (s = clusterStyle(params.seed, lot.clusterId)));
    const spec = makeBuildingSpec(lot, s, params.buildings);
    if (!spec) continue;
    const envelope = computeEnvelope(lot, spec, params.buildings);
    if (!envelope.buildable) continue;
    const footprint = fitFootprint(lot, envelope, spec, params.buildings);
    if (!footprint) continue;
    const mass = buildMass(footprint, envelope, spec, lot.area);
    out.push({ lot, spec, envelope, footprint, mass });
  }
  return { params, city, built: out };
}

describe('building geometry', () => {
  const { params, city, built } = build();

  it('builds a building on most lots', () => {
    expect(built.length / city.lots.length).toBeGreaterThan(0.85);
  });

  it('footprints stay inside the buildable envelope', () => {
    for (const b of built) {
      const inside = multiArea(intersectPoly([b.footprint.outline], [b.envelope.buildable!]));
      expect(inside / b.footprint.area, `lot ${b.lot.id}`).toBeGreaterThan(0.98);
    }
  });

  it('footprints are simple and above the minimum floor area', () => {
    for (const b of built) {
      expect(isSimple(b.footprint.outline), `lot ${b.lot.id}`).toBe(true);
      expect(b.footprint.area).toBeGreaterThanOrEqual(params.buildings.minFloorArea * 0.5);
    }
  });

  it('respects the coverage ratio (建ぺい率)', () => {
    for (const b of built) {
      const coverage = b.footprint.area / b.lot.area;
      // Allow a little slack: the module snap can push a footprint slightly over.
      expect(coverage, `lot ${b.lot.id}`).toBeLessThan(b.spec.coverage + 0.16);
    }
  });

  it('respects the absolute height limit', () => {
    for (const b of built) {
      expect(b.mass.height, `lot ${b.lot.id}`).toBeLessThanOrEqual(b.spec.heightLimit + 0.01);
    }
  });

  it('every floor polygon is valid', () => {
    for (const b of built) {
      for (const f of b.mass.floors) {
        expect(isSimple(f.polygon), `lot ${b.lot.id} floor ${f.index}`).toBe(true);
        expect(area(f.polygon)).toBeGreaterThan(1);
      }
    }
  });

  const pct = (xs: number[], f: number) => {
    const s2 = xs.slice().sort((a, b) => a - b);
    return (s2[Math.floor(s2.length * f)] ?? 0).toFixed(2);
  };

  it('reports the distribution', () => {
    const kinds: Record<string, number> = {};
    const floors: Record<number, number> = {};
    const roofs: Record<string, number> = {};
    const archetypes: Record<string, number> = {};
    let clippedCount = 0;
    let totalHeight = 0;
    let wantsPad = 0;
    let hasPad = 0;
    const coverages: number[] = [];
    for (const b of built) {
      if (b.spec.wantsCarPad) wantsPad++;
      if (b.envelope.carPad) hasPad++;
      kinds[b.spec.kind] = (kinds[b.spec.kind] ?? 0) + 1;
      floors[b.mass.floors.length] = (floors[b.mass.floors.length] ?? 0) + 1;
      roofs[b.spec.roofType] = (roofs[b.spec.roofType] ?? 0) + 1;
      archetypes[b.spec.archetype] = (archetypes[b.spec.archetype] ?? 0) + 1;
      coverages.push(b.footprint.area / b.lot.area);
      if (b.footprint.clippedFraction > 0.02) clippedCount++;
      totalHeight += b.mass.height;
    }
    console.log(
      [
        '',
        `built:       ${built.length} / ${city.lots.length} lots`,
        `kinds:       ${JSON.stringify(kinds)}`,
        `floors:      ${JSON.stringify(floors)}`,
        `roofs:       ${JSON.stringify(roofs)}`,
        `archetypes:  ${JSON.stringify(archetypes)}`,
        `lot-clipped: ${clippedCount} (${((clippedCount / built.length) * 100).toFixed(0)}% of footprints cut by the lot shape)`,
        `mean height: ${(totalHeight / built.length).toFixed(1)} m`,
        `car pads:    ${hasPad} built / ${wantsPad} wanted`,
        `coverage:    p10=${pct(coverages, 0.1)} p50=${pct(coverages, 0.5)} p90=${pct(coverages, 0.9)} (建ぺい率 as built)`,
        '',
      ].join('\n'),
    );
    expect(built.length).toBeGreaterThan(0);
  });
});
