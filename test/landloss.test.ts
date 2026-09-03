import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, applyRoadLayout, cloneParams, type RoadLayout } from '../src/core/params.js';
import { generateCity } from '../src/city/City.js';
import { LAND_LOSS_REASONS, auditLand } from '../src/city/LandLoss.js';
import { maxInscribedCircle } from '../src/geom/polygon.js';

/**
 * Every square metre of every block is road, lot, or a *recorded* decision.
 *
 * The counterpart of `test/overlap.test.ts`'s empty-lot budget, one stage
 * earlier. That one asks why a lot carries no building; this one asks why a
 * piece of land never became a lot — a question nothing could answer before,
 * because the subdivider discarded polygons with a bare `continue` and the land
 * simply stopped being mentioned.
 *
 * The figure that matters is `unaccounted`, and it is not a category. It is
 * land nobody recorded a decision about, which means a drop path exists that
 * nobody has instrumented. It cannot be driven to exactly zero — polygon
 * booleans leave millimetre slivers along every boundary they cut — but it can
 * be held well under a percent, and a *large* piece of it is always a bug.
 */

const LAYOUTS: RoadLayout[] = ['district', 'grid'];

function audit(layout: RoadLayout) {
  const params = cloneParams(DEFAULT_PARAMS);
  applyRoadLayout(params.roads, layout);
  const city = generateCity(params);
  return { city, land: auditLand(city) };
}

describe('the land ledger', () => {
  for (const layout of LAYOUTS) {
    it(`accounts for every square metre of every block (${layout})`, () => {
      const { land } = audit(layout);
      expect(land.blockArea).toBeGreaterThan(100000);

      // The three columns are produced by successive subtraction, so they add
      // up by construction. Asserting it anyway is how a change to `auditLand`
      // that starts double-counting gets caught here rather than by somebody
      // puzzling over a percentage that no longer means anything.
      const lost = LAND_LOSS_REASONS.reduce((s, r) => s + land.byReason[r], 0);
      const sum = land.lotArea + land.rowArea + lost - land.preBlockArea;
      expect(Math.abs(sum - land.blockArea) / land.blockArea).toBeLessThan(0.001);

      const share = land.byReason.unaccounted / land.blockArea;
      const breakdown = LAND_LOSS_REASONS.filter((r) => land.byReason[r] >= 1)
        .sort((a, b) => land.byReason[b] - land.byReason[a])
        .map((r) => `${r}=${land.byReason[r].toFixed(0)}`)
        .join(' ');
      // 0.67% on the district layout, 0.23% on the grid, at the time of
      // writing. It was 6.7% before any of this work.
      expect(share, `${(share * 100).toFixed(2)}% unaccounted — ${breakdown}`).toBeLessThan(0.012);
    }, 180000);

    it(`hides no whole parcel inside the unaccounted total (${layout})`, () => {
      const { land } = audit(layout);
      // A percentage can be small while concealing one missing lot, and one
      // missing lot is a bug with a location — which is the whole reason the
      // overlay draws these crossed out rather than merely counting them. The
      // bound is a large parcel: anything over it is a hole in a block.
      const chunky = land.unaccounted
        .filter((u) => maxInscribedCircle(u.polygon, 0.5).radius > 3)
        .sort((a, b) => b.area - a.area);
      const worst = chunky[0];
      expect(
        worst?.area ?? 0,
        `${chunky.length} unaccounted pieces wide enough to build on, worst ` +
          `${(worst?.area ?? 0).toFixed(0)} m² in block ${worst?.blockId ?? -1}`,
      ).toBeLessThan(600);
    }, 180000);

    it(`gives the land behind every street row to somebody (${layout})`, () => {
      const { land } = audit(layout);
      // `core-abandoned` is what is left when neither a 私道, nor 旗竿地, nor the
      // depth of the street row would take the core of a block. It used to be
      // the *default* — `flagLotChance` decided 旗竿地 or nothing — and ran to
      // thousands of square metres. There is no reason for it to be large now,
      // and if it grows it means the absorb path has stopped working.
      const share = land.byReason['core-abandoned'] / land.blockArea;
      expect(share, `${land.byReason['core-abandoned'].toFixed(0)} m² of abandoned block core`)
        .toBeLessThan(0.003);
    }, 180000);
  }
});
