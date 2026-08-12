import type { GrowthParams, LotParams, RoadParams, UseZone } from '../core/params.js';
import { zoneLotParams } from './LandUse.js';
import { generationAge } from './RoadGrowth.js';

/**
 * The standard plot of a district, and the block sized to hold it.
 *
 * A district's streets exist for the buildings that stand between them, so the
 * plot is the master dimension and the grid follows from it — not the other way
 * round. A block here is *exactly* two rows of plots back to back, and a whole
 * number of frontages long. Nothing is left over in the middle.
 *
 * It used not to be. The grid spacing (40–66 m) and the lot depth (13.5 m) were
 * independent numbers, so a block gave 34–60 m of usable depth where two rows
 * needed 27, and every block in the town carried 7–33 m of leftover down its
 * spine. That leftover went three ways, all of them bad: a 私道 dug into it —
 * 36% of the town's lots ended up hanging off one — flag lots behind the street
 * row, or nothing at all, abandoned as bare ground. And because the subdivider
 * draws its depth to fit whatever it is given, the lots stretched to soak the
 * rest up: a median parcel of 7.8 m × 20.8 m, aspect 2.2, with 42% of them past
 * 2.5 — and a house on each one shaped to match.
 *
 * Two numbers set everything else:
 *
 * - `depth` — how far back from the street a plot goes. Two of these plus the
 *   road between them is the spacing of the streets the houses front.
 * - `width` — the 間口. The streets that cap the ends of a block are a whole
 *   number of these apart, so the last plot in a row is the same size as the
 *   first and no half-plot remainder has to be absorbed.
 *
 * Which is not to say a block always comes out at exactly `cross × along`. A
 * district is not a whole number of blocks across, the grid has to reach its
 * boundary road on both sides, and Tier-1 cuts across at whatever angle it
 * arrived at. So `Lots.subdivideInterior` still fits its depth to the block it
 * is actually handed — this decides what to *aim* for, and aiming right is what
 * leaves that pass with nothing to absorb.
 */
export interface LotModule {
  /** Frontage of the standard plot, metres. */
  width: number;
  /** Depth from the street, metres. */
  depth: number;
  /** Spacing of the streets the plots front: two rows plus the road between. */
  cross: number;
  /** Spacing of the streets capping the block ends: a whole number of frontages. */
  along: number;
}

/**
 * How long a block is compared with how deep it is.
 *
 * Kept modest deliberately. A longer block is more efficient — the two streets
 * capping its ends are shared over more plots — but `Blocks.splitOversized` runs
 * a lane through anything over ~5,200 m², and a lane cut through a block that
 * was sized exactly right is the very waste this module exists to remove.
 */
const BLOCK_ASPECT = 2.0;

/** A block is never fewer plots than this along, nor more. */
const MIN_PLOTS = 2;
const MAX_PLOTS = 12;

/**
 * Zones whose plot size is a matter of when the district was developed.
 *
 * A factory is a factory whenever it was built — its parcel is sized by what
 * goes on it, not by what the land was worth that year — and the shophouse
 * frontages near the station are set by the same reasoning. Only the ordinary
 * residential grain grew outward.
 */
const AGES_WITH_TOWN: Partial<Record<UseZone, true>> = { lowRise: true, midRise: true };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How much bigger a plot is in a district of this age.
 *
 * The town's density gradient used to live in the street spacing — 40 m at the
 * station, 66 m at the fringe — which is the wrong place for it twice over. It
 * set a block size the lots then had to be stretched to fill; and it is not what
 * actually differs between 駅前 and 郊外, where the streets are much the same
 * width apart and it is the plots between them that are twice the size. So the
 * gradient is carried by the plot now, and the grid is sized to whichever plot
 * the district is getting.
 */
export function lotScaleForGeneration(gen: number, g: GrowthParams): number {
  const t = generationAge(gen, g);
  return g.coreLotScale + (g.fringeLotScale - g.coreLotScale) * (t * t * (3 - 2 * t));
}

export function lotModule(
  zone: UseZone,
  generation: number,
  p: RoadParams,
  lots: LotParams,
): LotModule {
  const cfg = zoneLotParams(lots, zone);
  const scale = p.growth.enabled && AGES_WITH_TOWN[zone] ? lotScaleForGeneration(generation, p.growth) : 1;

  const depth = clamp(cfg.depthMean * scale, cfg.depthMin, cfg.depthMax);
  const width = clamp(cfg.widthMean * scale, cfg.widthMin, cfg.widthMax);

  // The carriageway between two rows, plus the gutter each row is set back by.
  // Both are taken out of the block before a single lot is cut, so the spacing
  // has to carry them or the two rows do not fit after all.
  const road = p.localWidth + 2 * cfg.gutterWidth;
  const cross = Math.max(p.minLocalSpacing, 2 * depth + road);

  const plots = clamp(Math.round((cross * BLOCK_ASPECT - road) / width), MIN_PLOTS, MAX_PLOTS);
  return { width, depth, cross, along: plots * width + road };
}
