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
    lots: 73745493,
    buildings: 1264173010,
    counts:
      '{"house":282,"apart":124,"konbini":3,"mansion":31,"factory":2,"vacant":7,"zakkyo":9,"shophouse":14}',
  },
  'sakura-3/grid': {
    lots: 2955358206,
    buildings: 1198623255,
    counts:
      '{"warehouse":4,"factory":11,"vacant":2,"konbini":2,"apart":165,"house":136}',
  },
  'kaede-11/district': {
    lots: 3713166155,
    buildings: 3791771543,
    counts:
      '{"house":241,"apart":125,"mansion":34,"vacant":6,"konbini":2,"zakkyo":15,"shophouse":13}',
  },
  // And once more for every case, when the street driven through an oversized
  // block stopped having its right of way subtracted twice (`Blocks.splitOversized`).
  // Every large block in every town grows by 3 m on each side of its internal
  // lane, so no fingerprint here could have survived it. What the change is
  // worth is measured in `test/stats.test.ts`'s land ledger and in
  // `test/parcels.test.ts`; this only says the town stopped changing after it.
  //
  // And once when the land behind a street row stopped being thrown away on a
  // coin flip (`Lots.subdivideInterior`). `flagLotChance` used to decide 旗竿地
  // or *nothing*; it now decides 旗竿地 or absorbed into the depth of the row,
  // so a core that used to vanish now belongs to somebody either way. Every
  // block with a core moves, which is most of them. `test/stats.test.ts` is
  // where the size of it is recorded.
  //
  // And once when a parcel that meets the water or a 段丘崖 stopped being judged
  // by its centroid alone (`Lots.finaliseLots`). It is now cut down to the part
  // on good ground and the survivors re-offered, so land that used to be nothing
  // becomes parcels — and a lot that used to be kept whole because its centroid
  // happened to land on the good side is now cut. Every town with a river in it
  // moves, which is all of them. Two repairs travelled with it and move the
  // flat cases as well: `cleanPolygon` trims whiskers instead of leaving them,
  // and `footprint.ts`'s needle backstop was brought up to the angle its own
  // trim works to.
  //
  // And once when an oversized parcel started being cut *across* its frontage
  // instead of along its oriented bounding box (`Lots.resliceOversized`). A deep
  // parcel was being halved parallel to its own street, and the rear half then
  // died landlocked. Only the district cases move: the grid's parcels are rarely
  // deep enough to be cut the wrong way.
  //
  // And once when a row of lots stopped running past the end of the street it
  // fronts. Its band was bounded on the two sides facing the road and on
  // neither of the two facing along it, so on a bent block the widest road's
  // row swept clean across the face; and absorption then handed a row land it
  // could not reach. Both are fixed, and what no row can reach is now forced
  // into 旗竿地 rather than sliced into 袋地. Every block with a bent or short
  // front moves, which is most of them. `test/stats.test.ts` has the size of it.
  //
  // The two grown cases were re-recorded once more, when whether a plot had sold
  // stopped being read off the generation alone and started counting the steps
  // *since* (`unsoldChance`). Only these two move — the three above have growth
  // switched off — and within them only the vacancy: `vacant` falls from 65 to 28
  // and from 36 to 10, and every lot those plots turn into is a kind that was
  // already in the same counts. No lot boundary moved, which is the claim worth
  // making about a change to a sales rule.
  'sakura-3/district/land': {
    lots: 3020715332,
    buildings: 1062871680,
    counts:
      '{"apart":103,"house":216,"vacant":28,"mansion":21,"shophouse":10,"konbini":4,"zakkyo":7,"factory":5,"warehouse":1}',
  },
  'kaede-11/district/land': {
    lots: 2760650154,
    buildings: 3003365666,
    counts:
      '{"house":159,"apart":96,"vacant":13,"mansion":24,"konbini":3,"factory":2,"warehouse":7,"shophouse":27,"zakkyo":9}',
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
