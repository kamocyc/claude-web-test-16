import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { planBuildings } from '../src/build/CityMesh.js';
import { Hasher } from '../src/core/rng.js';

/**
 * A fingerprint of the whole town, so a refactor can prove it changed nothing.
 *
 * `test/lots.test.ts` already checks that one seed twice gives the same lots.
 * This is the other half of that: that one seed *across a code change* gives the
 * same town. The generator is built out of correlated tables and a hierarchical
 * seed stream, and the two most tempting refactors — folding the `spec.kind`
 * ternary ladders into a lookup table, and moving a zoning decision upstream —
 * both shift that stream in ways nothing else here would notice. A house whose
 * roof went from 寄棟 to 切妻 breaks no invariant; it is simply a different town.
 *
 * So the numbers below are not correct in any sense. They are just *the current
 * town*, recorded. When a change is meant to be inert, they must not move. When
 * a change is meant to alter the output, re-record them in the same commit —
 * deliberately, and never as a way of making a red test go away.
 */

/** Everything the zoning and subdivision decided, before any geometry. */
function hashLots(city: ReturnType<typeof generateCity>): number {
  const h = new Hasher();
  for (const lot of city.lots) {
    h.string(lot.kind).string(lot.zonedKind).number(lot.clusterId, 0);
    h.number(lot.area).number(lot.urbanity);
    h.string(lot.isFlagLot ? 'flag' : '-');
    for (const p of lot.polygon) h.number(p.x).number(p.y);
    for (const f of lot.frontages) h.string(f.cls).number(f.len);
  }
  return h.value;
}

/** Everything the building pass decided, from the spec down to the built mass. */
function hashBuildings(plan: ReturnType<typeof planBuildings>): number {
  const h = new Hasher();
  for (const b of plan.buildings) {
    const s = b.spec;
    h.number(b.lot.id, 0).string(s.archetype).string(s.kind);
    h.number(s.style.era).number(s.style.wealth).number(s.style.formality);
    h.string(s.footprintShape).string(s.mirrored ? 'm' : '-').number(s.facingAngle);
    h.number(s.floors, 0).number(s.floorHeight).number(s.coverage).number(s.far);
    h.number(s.heightLimit).string(s.roofType).number(s.roofPitch).number(s.eaves);
    h.string(s.ridgeAlongStreet ? 'r' : '-').number(s.parapetHeight);
    h.string(s.wallFamily).string(s.roofFamily);
    for (const c of [s.wallColor, s.roofColor, s.accentColor, s.sashColor]) {
      h.number(c.r).number(c.g).number(c.b);
    }
    h.string(s.bandColor ? 'band' : '-').number(s.valueShift);
    h.string(s.fenceStyle).number(s.fenceHeight).string(s.wantsCarPad ? 'pad' : '-');
    h.number(b.mass.height).number(b.mass.stacks.length, 0).number(b.footprint.area);
    for (const p of b.footprint.outline) h.number(p.x).number(p.y);
  }
  return h.value;
}

/**
 * Recorded fingerprints. Regenerate by reading the console output of a failing
 * run — the assertion prints both sides — and paste the new values in.
 */
const GOLDEN: Record<string, { lots: number; buildings: number; counts: string }> = {
  // Re-recorded once, deliberately: `pruneTier1Spurs` found a genuinely
  // stranded collector on this seed that the flat generator had always left
  // there. `test/roads.test.ts` never caught it because it checks a different
  // seed. One lot moved as a result.
  'sakura-3/district': {
    lots: 3493833412,
    buildings: 1925033318,
    counts:
      '{"house":360,"apart":133,"mansion":9,"factory":1,"shophouse":34,"vacant":4,"zakkyo":4,"konbini":2}',
  },
  'sakura-3/grid': {
    lots: 2354422704,
    buildings: 116898347,
    counts: '{"warehouse":5,"factory":5,"apart":177,"house":244,"konbini":1,"vacant":1}',
  },
  'kaede-11/district': {
    lots: 2775236398,
    buildings: 3203035098,
    counts:
      '{"house":251,"apart":152,"mansion":13,"konbini":2,"vacant":8,"zakkyo":13,"shophouse":2}',
  },
  'sakura-3/district/land': {
    lots: 2806241274,
    buildings: 3030063825,
    counts:
      '{"house":348,"apart":93,"vacant":26,"mansion":8,"shophouse":4,"zakkyo":7,"konbini":2,"warehouse":1,"factory":3}',
  },
  'kaede-11/district/land': {
    lots: 2712753975,
    buildings: 4255399958,
    counts:
      '{"house":271,"vacant":39,"apart":125,"mansion":6,"factory":3,"warehouse":2,"konbini":2}',
  },
};

describe('golden town fingerprint', () => {
  // The first three are flat and un-grown, on purpose: they predate terrain and
  // growth and they are the evidence that the plumbing those needed — lifting a
  // building by one scalar, rebasing props, threading a `Terrain` through five
  // signatures — did not move a single lot on the ground it used to be generated
  // on. The last two are the town that actually ships.
  const cases: [string, RoadLayout, boolean][] = [
    ['sakura-3', 'district', false],
    ['sakura-3', 'grid', false],
    ['kaede-11', 'district', false],
    ['sakura-3', 'district', true],
    ['kaede-11', 'district', true],
  ];

  for (const [seed, layout, land] of cases) {
    it(`is unchanged for ${seed} (${layout}${land ? ', grown on terrain' : ''})`, () => {
      const params = cloneParams(DEFAULT_PARAMS);
      params.seed = seed;
      applyRoadLayout(params.roads, layout);
      // Smaller than the shipped town so three of these stay quick, but large
      // enough that every code path — flag lots, private lanes, 斜線 step-backs,
      // conforming footprints — is exercised at least a few dozen times.
      params.roads.extent = 190;
      params.terrain.enabled = land;
      params.roads.growth.enabled = land;

      const city = generateCity(params);
      const plan = planBuildings(city, params);

      const counts: Record<string, number> = {};
      for (const l of city.lots) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
      const actual = {
        lots: hashLots(city),
        buildings: hashBuildings(plan),
        counts: JSON.stringify(counts),
      };

      const key = `${seed}/${layout}${land ? '/land' : ''}`;
      const golden = GOLDEN[key]!;
      if (!golden || golden.lots === 0) {
        // Unrecorded — print what to paste in rather than failing cryptically.
        console.log(`  '${key}': ${JSON.stringify(actual)},`);
      }
      expect(actual, `town changed for ${key}`).toEqual(golden);
    }, 60000);
  }
});
