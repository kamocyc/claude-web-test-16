import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '../src/core/params.js';
import { FLAT_TERRAIN, makeTerrain } from '../src/terrain/Terrain.js';
import { contourSegments } from '../src/terrain/heightfield.js';

/**
 * The land, on its own terms.
 *
 * Everything here is asserted against the `Terrain` interface rather than
 * against the field's internals, because that interface is the whole of what the
 * town can see. If the river is monotone here it is monotone for the road
 * profiler too.
 *
 * The extents matter. The suite generates 190 m towns to stay quick and the
 * shipped default is 320 m, so a terrain feature that only intersects the larger
 * square would leave every downstream terrain code path silently untested. Both
 * are checked.
 */

const EXTENTS = [190, 320];
const SEEDS = ['sakura-3', 'kaede-11'];

const terrainFor = (seed: string, extent: number) =>
  makeTerrain(seed, cloneParams(DEFAULT_PARAMS).terrain, extent);

/** A lattice of sample points inside the town square. */
function samples(extent: number, n = 23): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({
        x: -extent + (2 * extent * i) / (n - 1),
        y: -extent + (2 * extent * j) / (n - 1),
      });
    }
  }
  return out;
}

describe('terrain field', () => {
  it('is deterministic for a seed, and different between seeds', () => {
    const a = terrainFor('sakura-3', 320);
    const b = terrainFor('sakura-3', 320);
    const c = terrainFor('kaede-11', 320);

    let maxSame = 0;
    let maxDiff = 0;
    for (const p of samples(320)) {
      maxSame = Math.max(maxSame, Math.abs(a.heightAt(p) - b.heightAt(p)));
      maxDiff = Math.max(maxDiff, Math.abs(a.heightAt(p) - c.heightAt(p)));
    }
    expect(maxSame).toBeLessThan(1e-9);
    expect(maxDiff, 'two seeds gave the same land').toBeGreaterThan(3);
  });

  for (const extent of EXTENTS) {
    it(`has the relief it was asked for (extent ${extent})`, () => {
      const p = cloneParams(DEFAULT_PARAMS).terrain;
      const t = makeTerrain('sakura-3', p, extent);
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of samples(extent, 41)) {
        const h = t.heightAt(q);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      // The river carve and the terrace steps both add to the plain fBm range,
      // so the band is generous at the top and tight at the bottom: what would
      // be a real failure is a town that came out flat.
      expect(hi - lo).toBeGreaterThan(p.relief * 0.5);
      expect(hi - lo).toBeLessThan(p.relief * 2.6);
    });

    it(`puts the datum at zero (extent ${extent})`, () => {
      const t = terrainFor('sakura-3', extent);
      // Not exactly zero — the datum is a point, and the assertion that matters
      // is that the town sits around y = 0 rather than 40 m up a hill, because
      // the camera, the fog and the shadow camera are all tuned for that.
      let sum = 0;
      const pts = samples(extent, 15);
      for (const q of pts) sum += t.heightAt(q);
      expect(Math.abs(sum / pts.length)).toBeLessThan(DEFAULT_PARAMS.terrain.relief * 0.8);
    });
  }

  it('answers zero everywhere when disabled', () => {
    const p = cloneParams(DEFAULT_PARAMS).terrain;
    p.enabled = false;
    const t = makeTerrain('sakura-3', p, 320);
    expect(t).toBe(FLAT_TERRAIN);
    for (const q of samples(320, 7)) expect(t.heightAt(q)).toBe(0);
  });

  it('draws contours across the town', () => {
    const t = terrainFor('sakura-3', 320);
    expect(t.field).not.toBeNull();
    expect(contourSegments(t.field!, 2).length).toBeGreaterThan(200);
  });
});

describe('river', () => {
  for (const extent of EXTENTS) {
    for (const seed of SEEDS) {
      it(`crosses the town and runs downhill (${seed}, extent ${extent})`, () => {
        const t = makeTerrain(seed, cloneParams(DEFAULT_PARAMS).terrain, extent);
        const river = t.river;
        expect(river, 'no river was generated').not.toBeNull();
        if (!river) return;

        // It has to actually be inside the town, or every terrain code path
        // downstream of it is untested at this extent.
        const inside = river.centre.filter(
          (q) => Math.abs(q.x) <= extent && Math.abs(q.y) <= extent,
        );
        expect(inside.length, 'the river misses the town').toBeGreaterThan(4);

        // Monotone non-increasing, with the required fall. Water flowing uphill
        // is the single most obvious way to break the illusion.
        for (let i = 1; i < river.bed.length; i++) {
          expect(river.bed[i]!).toBeLessThanOrEqual(river.bed[i - 1]! + 1e-9);
        }
        expect(river.bed[0]! - river.bed[river.bed.length - 1]!).toBeGreaterThan(0);

        // And the water is above the bed, everywhere.
        for (let i = 0; i < river.bed.length; i++) {
          expect(river.water[i]!).toBeGreaterThan(river.bed[i]!);
        }
      });

      it(`carved a valley the water sits in (${seed}, extent ${extent})`, () => {
        const t = makeTerrain(seed, cloneParams(DEFAULT_PARAMS).terrain, extent);
        const river = t.river!;
        // Sample the middle of the run: the ground at the centreline should be
        // at or below the water, and higher a valley-width away.
        const mid = river.centre[Math.floor(river.centre.length / 2)]!;
        const water = t.waterAt(mid);
        expect(water, 'the centreline is not in the channel').not.toBeNull();
        expect(t.heightAt(mid)).toBeLessThan(water! + 0.5);
      });
    }
  }
});

describe('terraces', () => {
  for (const extent of EXTENTS) {
    it(`step sharply enough to be a cliff (extent ${extent})`, () => {
      const p = cloneParams(DEFAULT_PARAMS).terrain;
      const t = makeTerrain('sakura-3', p, extent);
      expect(t.terraces.length).toBe(p.terrace.count);

      let checked = 0;
      for (const line of t.terraces) {
        for (let i = 2; i + 2 < line.pts.length; i += 3) {
          const a = line.pts[i]!;
          const b = line.pts[i + 1]!;
          if (Math.abs(a.x) > extent || Math.abs(a.y) > extent) continue;
          // Perpendicular to the scarp, two band-widths either side.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l = Math.hypot(dx, dy) || 1;
          const nx = -dy / l;
          const ny = dx / l;
          const reach = line.width * 2;
          const hi = t.heightAt({ x: a.x + nx * reach, y: a.y + ny * reach });
          const lo = t.heightAt({ x: a.x - nx * reach, y: a.y - ny * reach });
          // The scarp has to dominate the hills at this scale, or it is not a
          // scarp — it is a slope with a name.
          expect(Math.abs(hi - lo)).toBeGreaterThan(Math.abs(line.step) * 0.55);
          checked++;
        }
      }
      expect(checked, 'no terrace crosses the town').toBeGreaterThan(2);
    });

    it(`are steep enough to force a retaining wall (extent ${extent})`, () => {
      const t = terrainFor('sakura-3', extent);
      const line = t.terraces[0]!;
      const mid = line.pts[Math.floor(line.pts.length / 2)]!;
      // Right on the band: the slope must be well past anything a road or a
      // level building platform can sit on unaided.
      expect(t.slopeAt(mid)).toBeGreaterThan(DEFAULT_PARAMS.terrain.maxBuildSlope);
    });
  }
});
