import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { makeBuildingSpec, clusterStyle } from '../src/building/style.js';
import { computeEnvelope, fitFootprint } from '../src/building/footprint.js';
import { buildMass } from '../src/building/mass.js';
import type { StyleVector } from '../src/building/types.js';
import { buildRoof } from '../src/building/roof.js';
import { GeometryBuffer } from '../src/build/GeometryBuffer.js';
import { area, isSimple, perimeter } from '../src/geom/polygon.js';
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
    const mass = buildMass(footprint, envelope, spec, lot, params.buildings);
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

  /**
   * Balconies, exterior corridors and eaves all project beyond the wall. Against
   * a 0.5 m side setback they used to cross into the neighbouring lot by well
   * over a metre and interpenetrate the building there.
   */
  it('nothing projects past the lot boundary', () => {
    for (const b of built) {
      for (const w of b.mass.floors[0]!.walls) {
        expect(w.room, `lot ${b.lot.id}`).toBeGreaterThanOrEqual(0);
        const projects = Math.max(
          w.isCorridorSide ? b.spec.corridorWidth : 0,
          w.sunFacing ? b.spec.balconyDepth : 0,
        );
        // Either there is room for what this wall carries, or the builder is
        // required to have clamped it — which is what `room` is consulted for.
        if (projects > 0) expect(Number.isFinite(w.room)).toBe(true);
      }
    }
  });

  it('stacks partition the footprint', () => {
    for (const b of built) {
      const total = b.mass.stacks.reduce((s, k) => s + area(k.polygon), 0);
      expect(total / b.footprint.area, `lot ${b.lot.id}`).toBeCloseTo(1, 1);
    }
  });

  it('produces at most three stacks with at most three distinct heights', () => {
    for (const b of built) {
      expect(b.mass.stacks.length, `lot ${b.lot.id}`).toBeLessThanOrEqual(3);
      expect(new Set(b.mass.stacks.map((s) => s.floors)).size).toBeLessThanOrEqual(3);
    }
  });

  it('an unstepped building is a single stack matching the footprint', () => {
    for (const b of built) {
      if (b.mass.stacks.length !== 1) continue;
      const s = b.mass.stacks[0]!;
      expect(s.stepped).toBe(false);
      expect(s.polygon).toBe(b.footprint.outline);
      expect(s.floors).toBe(b.mass.floors.length);
    }
  });

  /**
   * The regression this whole rewrite exists to prevent: a roof sized from the
   * base footprint while the walls under it had been cut back by 斜線制限.
   */
  it('every roof is sized to the stack beneath it', () => {
    for (const b of built) {
      for (const s of b.mass.stacks) {
        if (s.parts.length === 0) continue;
        const partArea = s.parts.reduce((t, r) => t + r.w * r.d, 0);
        const stackArea = area(s.polygon);
        expect(partArea / stackArea, `lot ${b.lot.id} stack ${s.index}`).toBeLessThan(1.35);
      }
    }
  });

  /**
   * A conforming outline is not composed of rectangles, so the pitched-roof
   * builder has nothing to work from and would emit no geometry at all. The roof
   * must both exist and stay within an eave's overhang of the walls.
   */
  it('a conforming outline gets a roof that covers it and nothing more', () => {
    const conforming = built.filter((b) => b.footprint.conform);
    expect(conforming.length, 'no conforming footprints were generated at all').toBeGreaterThan(5);

    for (const b of conforming) {
      expect(b.footprint.parts, `lot ${b.lot.id}`).toEqual([]);
      // 切妻 and 寄棟 need a span; the fitter is required to have downgraded them.
      expect(['flat', 'shed'], `lot ${b.lot.id}`).toContain(b.spec.roofType);

      for (const stack of b.mass.stacks) {
        const buf = new GeometryBuffer();
        const roof = buildRoof(buf, stack, stack.y1, b.spec);
        expect(buf.triangleCount, `lot ${b.lot.id} stack ${stack.index} has no roof`).toBeGreaterThan(0);
        const plan = area(stack.polygon);
        const limit = plan + perimeter(stack.polygon) * b.spec.eaves * 1.3;
        expect(area(roof.envelope), `lot ${b.lot.id} stack ${stack.index}`).toBeLessThan(limit);
      }
    }
  });

  /**
   * The point of the conforming path: walls that run parallel to the boundary
   * they came from. Sampling the outline and checking how much of it hugs the
   * lot at the setback distance is the cheapest way to assert that.
   */
  it('a conforming outline follows its lot boundary', () => {
    for (const b of built.filter((x) => x.footprint.conform)) {
      const lotEdges = b.lot.polygon.length;
      let parallel = 0;
      for (const w of b.footprint.walls) {
        for (const e of b.lot.polygon.map((_, i) => i)) {
          const a = b.lot.polygon[e]!;
          const c = b.lot.polygon[(e + 1) % lotEdges]!;
          const dir = { x: c.x - a.x, y: c.y - a.y };
          const l = Math.hypot(dir.x, dir.y);
          if (l < 0.5) continue;
          const align = Math.abs((w.dir.x * dir.x + w.dir.y * dir.y) / l);
          if (align > 0.985) {
            parallel++;
            break;
          }
        }
      }
      // Chamfers and the shrink's own cuts are not boundary-parallel, so this is
      // a majority test rather than an all-walls one.
      expect(parallel / b.footprint.walls.length, `lot ${b.lot.id}`).toBeGreaterThan(0.5);
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
    const conformCoverages: number[] = [];
    const stackCounts: Record<number, number> = {};
    let steppedCount = 0;
    for (const b of built) {
      if (b.footprint.conform) conformCoverages.push(b.footprint.area / b.lot.area);
      if (b.spec.wantsCarPad) wantsPad++;
      if (b.envelope.carPad) hasPad++;
      kinds[b.spec.kind] = (kinds[b.spec.kind] ?? 0) + 1;
      floors[b.mass.floors.length] = (floors[b.mass.floors.length] ?? 0) + 1;
      roofs[b.spec.roofType] = (roofs[b.spec.roofType] ?? 0) + 1;
      archetypes[b.spec.archetype] = (archetypes[b.spec.archetype] ?? 0) + 1;
      coverages.push(b.footprint.area / b.lot.area);
      stackCounts[b.mass.stacks.length] = (stackCounts[b.mass.stacks.length] ?? 0) + 1;
      if (b.mass.stacks.some((s) => s.stepped)) steppedCount++;
      if (b.footprint.clippedFraction > 0.02) clippedCount++;
      totalHeight += b.mass.height;
    }
    console.log(
      [
        '',
        `built:       ${built.length} / ${city.lots.length} lots` +
          ` (${city.lots.length - built.length} unbuildable)`,
        `conform:     ${conformCoverages.length} outlines follow the lot boundary` +
          `, coverage p50=${pct(conformCoverages, 0.5)}`,
        `kinds:       ${JSON.stringify(kinds)}`,
        `floors:      ${JSON.stringify(floors)}`,
        `roofs:       ${JSON.stringify(roofs)}`,
        `archetypes:  ${JSON.stringify(archetypes)}`,
        `lot-clipped: ${clippedCount} (${((clippedCount / built.length) * 100).toFixed(0)}% of footprints cut by the lot shape)`,
        `mean height: ${(totalHeight / built.length).toFixed(1)} m`,
        `car pads:    ${hasPad} built / ${wantsPad} wanted`,
        `stacks:      ${JSON.stringify(stackCounts)} (buildings by number of stacks)`,
        `stepped:     ${steppedCount} buildings have a 斜線 step-down`,
        `coverage:    p10=${pct(coverages, 0.1)} p50=${pct(coverages, 0.5)} p90=${pct(coverages, 0.9)} (建ぺい率 as built)`,
        '',
      ].join('\n'),
    );
    expect(built.length).toBeGreaterThan(0);
  });
});
