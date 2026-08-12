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
  'sakura-3/district': {
    lots: 3729770311,
    buildings: 896009484,
    counts:
      '{"house":361,"apart":131,"mansion":9,"factory":1,"shophouse":34,"vacant":5,"zakkyo":4,"konbini":2}',
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
};

describe('golden town fingerprint', () => {
  const cases: [string, RoadLayout][] = [
    ['sakura-3', 'district'],
    ['sakura-3', 'grid'],
    ['kaede-11', 'district'],
  ];

  for (const [seed, layout] of cases) {
    it(`is unchanged for ${seed} (${layout})`, () => {
      const params = cloneParams(DEFAULT_PARAMS);
      params.seed = seed;
      applyRoadLayout(params.roads, layout);
      // Smaller than the shipped town so three of these stay quick, but large
      // enough that every code path — flag lots, private lanes, 斜線 step-backs,
      // conforming footprints — is exercised at least a few dozen times.
      params.roads.extent = 190;
      // Flat and un-grown, deliberately.
      //
      // These three fingerprints predate terrain and growth, and keeping them on
      // the old path is what makes them useful during a change this size: they
      // are the evidence that the plumbing — lifting buildings by a scalar,
      // rebasing props, threading a `Terrain` through five signatures — did not
      // move a single lot on the ground it used to be generated on. The
      // terrain-and-growth fingerprints are separate cases below.
      params.terrain.enabled = false;
      params.roads.growth.enabled = false;

      const city = generateCity(params);
      const plan = planBuildings(city, params);

      const counts: Record<string, number> = {};
      for (const l of city.lots) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
      const actual = {
        lots: hashLots(city),
        buildings: hashBuildings(plan),
        counts: JSON.stringify(counts),
      };

      const key = `${seed}/${layout}`;
      const golden = GOLDEN[key]!;
      if (golden.lots === 0) {
        // Unrecorded — print what to paste in rather than failing cryptically.
        console.log(`  '${key}': ${JSON.stringify(actual)},`);
      }
      expect(actual, `town changed for ${key}`).toEqual(golden);
    }, 60000);
  }
});
