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
  // Re-recorded, deliberately, twice.
  //
  // Once because `pruneTier1Spurs` found a genuinely stranded collector on this
  // seed that the flat generator had always left there — `test/roads.test.ts`
  // never caught it because it checks a different seed. One lot moved.
  //
  // And once for every case at the same time, when the street grid stopped being
  // spaced by a number of its own and started being derived from the plot it is
  // there to serve (`city/LotModule.ts`). That moves every block boundary in
  // every town, so nothing here could have survived it. The proportion it was
  // recorded for is now measured directly in `test/parcels.test.ts`, which is
  // the test that would notice if it regressed — this one only says the town
  // stopped changing afterwards.
  'sakura-3/district': {
    lots: 1238136529,
    buildings: 3785270760,
    counts:
      '{"house":289,"apart":126,"konbini":2,"factory":1,"mansion":29,"vacant":9,"zakkyo":11,"shophouse":10}',
  },
  'sakura-3/grid': {
    lots: 2544414766,
    buildings: 3030084581,
    counts:
      '{"warehouse":3,"factory":13,"vacant":4,"konbini":2,"apart":169,"house":154}',
  },
  'kaede-11/district': {
    lots: 361306851,
    buildings: 518384031,
    counts:
      '{"house":239,"apart":121,"vacant":9,"mansion":33,"konbini":2,"zakkyo":18,"shophouse":2}',
  },
  // And once more for every case, when the street driven through an oversized
  // block stopped having its right of way subtracted twice (`Blocks.splitOversized`).
  // Every large block in every town grows by 3 m on each side of its internal
  // lane, so no fingerprint here could have survived it. What the change is
  // worth is measured in `test/stats.test.ts`'s land ledger and in
  // `test/parcels.test.ts`; this only says the town stopped changing after it.
  //
  // The two grown cases were re-recorded once more, when whether a plot had sold
  // stopped being read off the generation alone and started counting the steps
  // *since* (`unsoldChance`). Only these two move — the three above have growth
  // switched off — and within them only the vacancy: `vacant` falls from 65 to 28
  // and from 36 to 10, and every lot those plots turn into is a kind that was
  // already in the same counts. No lot boundary moved, which is the claim worth
  // making about a change to a sales rule.
  'sakura-3/district/land': {
    lots: 2584355657,
    buildings: 3192593445,
    counts:
      '{"house":209,"apart":73,"vacant":28,"mansion":27,"zakkyo":7,"konbini":3,"shophouse":1,"factory":5,"warehouse":2}',
  },
  'kaede-11/district/land': {
    lots: 2778799719,
    buildings: 3446376171,
    counts:
      '{"house":149,"apart":94,"mansion":20,"konbini":4,"vacant":8,"warehouse":6,"factory":4,"shophouse":12,"zakkyo":9}',
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
