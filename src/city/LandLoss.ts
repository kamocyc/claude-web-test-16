import type { Polygon } from '../core/types.js';
import { area } from '../geom/polygon.js';
import { differencePoly, multiArea } from '../geom/boolean.js';
import type { City } from './City.js';
import { rightOfWaySurfaces } from './RoadSurface.js';

/**
 * Land that became neither road nor lot, and why.
 *
 * The building stage has had this for a while: a lot with no house on it
 * carries a `VacancyReason`, the three groups it falls into are counted
 * separately because they are opposite facts, and the overlay draws them in
 * three colours. Land that never became a lot at all had nothing. Every stage
 * of subdivision discards polygons — a band under the minimum, a piece that
 * touches no street, a core no lane could reach — with a bare `continue`, and
 * the land simply stopped being mentioned. Looking at a hole in a block you
 * could not tell whether the generator had decided something about it or had
 * lost track of it.
 *
 * So: the same discipline one stage earlier. Every terminal discard is
 * recorded, and what is left over after roads, lots and recorded discards are
 * all taken off a block is `unaccounted` — the number that ought to be zero,
 * and the one that says a drop path exists which nobody has instrumented.
 *
 * Recording is a push of a polygon that already exists. The *measuring* is not
 * cheap — it is a polygon boolean per block — so `auditLand` is a separate
 * function nobody calls during generation.
 */

export type LandLossReason =
  // --- Never became a block ------------------------------------------------
  /** A face, or a piece of a split one, under `BlockOptions.minArea`. */
  | 'block-too-small'
  /** Cleanup or the simplicity check refused the face. */
  | 'block-degenerate'
  /**
   * A face beyond the built-up frontier. A decision, not a failure: there is no
   * estate out there to divide, and colouring it like a defect would bury the
   * defects under it.
   */
  | 'block-undeveloped'
  /** A block no road was attributed to, so nothing on it could ever front one. */
  | 'block-no-frontage'
  // --- Became a block, never became parcels --------------------------------
  /** A band, an offcut or a carve-out remnant under the minimum lot area. */
  | 'offcut-too-small'
  /** A piece of block interior that touches no frontage line. */
  | 'offcut-no-frontage'
  /** The core behind the street rows: no 私道 reached it and no 旗竿地 took it. */
  | 'core-abandoned'
  /**
   * Land no row could reach and too small to be worth running a 竿 out to.
   *
   * Held apart from `core-abandoned` for the reason `not-yet-developed` is held
   * apart from `too-narrow`: this one is a decision. A 2.6 m corridor out of a
   * 40 m² scrap leaves a body no house fits on, so the land is written off on
   * purpose rather than turned into an empty lot. `core-abandoned` next to it
   * means the salvage was tried and failed, which is a defect.
   */
  | 'stranded-too-small'
  /** A rear parcel no pole could be run out to a street from. */
  | 'flag-pole-failed'
  // --- Became a parcel, refused at the door --------------------------------
  | 'lot-too-small'
  | 'lot-too-narrow'
  | 'lot-no-frontage'
  /** The parcel was almost entirely road — land the subdivider never held. */
  | 'lot-on-road'
  /** Cleanup, the simplicity check or a boolean gave up on the parcel. */
  | 'lot-degenerate'
  /**
   * River, 段丘崖 or ground too steep to cut a platform into.
   *
   * Last of the lot reasons on purpose. A parcel the ground refuses is cut down
   * to the part on good ground and the survivors are re-offered, so this is
   * recorded against the *whole* parcel and charged, by `auditLand`'s
   * successive subtraction, only for what neither became a lot nor failed for a
   * more specific reason. Recording just the offcut would need another boolean
   * per parcel to say which part that was.
   */
  | 'lot-unbuildable-ground'
  // --- Nobody's ------------------------------------------------------------
  /** Left over once everything above is taken off the block. Should be zero. */
  | 'unaccounted';

export const LAND_LOSS_REASONS: readonly LandLossReason[] = [
  'block-too-small',
  'block-degenerate',
  'block-undeveloped',
  'block-no-frontage',
  'offcut-too-small',
  'offcut-no-frontage',
  'core-abandoned',
  'stranded-too-small',
  'flag-pole-failed',
  'lot-too-small',
  'lot-too-narrow',
  'lot-no-frontage',
  'lot-on-road',
  'lot-degenerate',
  'lot-unbuildable-ground',
  'unaccounted',
];

/**
 * Reasons that are a decision rather than a defect.
 *
 * Split out for the same reason `UNSOLD_VACANCY` is: land outside the frontier
 * and land the generator lost track of are opposite facts, and one figure
 * covering both tells you nothing. This one does not shrink when the generator
 * gets better — it shrinks when the town gets older.
 */
export const DELIBERATE_LAND_LOSS: readonly LandLossReason[] = [
  'block-undeveloped',
  'stranded-too-small',
];

export interface LandLoss {
  polygon: Polygon;
  /** Gross area of the polygon. The audit reports the *net* area instead. */
  area: number;
  reason: LandLossReason;
  /** The block it was discarded from, or -1 for land discarded before blocks. */
  blockId: number;
}

/** Where a discarded polygon goes. */
export interface LandLossSink {
  add(reason: LandLossReason, poly: Polygon, blockId: number): void;
}

/**
 * The default sink: it throws the record away.
 *
 * So a caller that does not want the instrumentation — `test/lots.test.ts`
 * driving `subdivideBlock` directly, say — pays nothing and needs no argument.
 */
export const NO_LAND_LOSSES: LandLossSink = { add: () => {} };

export function makeLandLossSink(): LandLossSink & { losses: LandLoss[] } {
  const losses: LandLoss[] = [];
  return {
    losses,
    add(reason, poly, blockId) {
      if (poly.length < 3) return;
      losses.push({ polygon: poly, area: area(poly), reason, blockId });
    },
  };
}

export interface LandAudit {
  /** Total area of all blocks. */
  blockArea: number;
  /** Of that, the road right of way — the setback every lot line keeps. */
  rowArea: number;
  /** Of that, land sold as lots. */
  lotArea: number;
  /** Net area lost, by reason. Sums with `rowArea` and `lotArea` to `blockArea`. */
  byReason: Record<LandLossReason, number>;
  /** Land discarded before any block existed. Not part of `blockArea`. */
  preBlockArea: number;
  /** The polygons behind `byReason.unaccounted`, for the overlay. */
  unaccounted: LandLoss[];
  /** Everything lost that is not a deliberate decision, over `blockArea`. */
  wasteShare: number;
}

/** A piece smaller than this is boolean noise, not land. */
const NOISE_AREA = 1;

/**
 * Measure what happened to every square metre of every block.
 *
 * By successive subtraction, in a fixed order, so nothing is counted twice and
 * the columns add up to the block exactly: take the road right of way off the
 * block, then the lots, then the recorded losses reason by reason, and whatever
 * survives all of that is `unaccounted`.
 *
 * The order matters and is deliberate. A parcel refused as `lot-on-road` was
 * mostly asphalt, and charging its whole area to that reason would report land
 * as lost twice — once as right of way and once as a discard. Subtracting the
 * roads first means each reason is charged only for what was still there when
 * it got to it.
 *
 * Not called during generation: this is a polygon boolean per block per reason.
 */
export function auditLand(city: City): LandAudit {
  const gutter = city.params.lots.gutterWidth;
  const roads = rightOfWaySurfaces(city.roads, gutter);
  const roadBoxes = roads.map((poly) => ({ poly, box: boxOf(poly) }));

  const byReason = {} as Record<LandLossReason, number>;
  for (const r of LAND_LOSS_REASONS) byReason[r] = 0;

  const lotsByBlock = new Map<number, Polygon[]>();
  for (const l of city.lots) {
    const list = lotsByBlock.get(l.blockId);
    if (list) list.push(l.polygon);
    else lotsByBlock.set(l.blockId, [l.polygon]);
  }
  const lossesByBlock = new Map<number, LandLoss[]>();
  for (const loss of city.landLosses) {
    const list = lossesByBlock.get(loss.blockId);
    if (list) list.push(loss);
    else lossesByBlock.set(loss.blockId, [loss]);
  }

  let blockArea = 0;
  let rowArea = 0;
  let lotArea = 0;
  const unaccounted: LandLoss[] = [];

  for (const block of city.blocks) {
    blockArea += block.area;
    let rest = clipRoads([block.polygon], roadBoxes);
    let left = multiArea(rest);
    rowArea += block.area - left;

    const lots = lotsByBlock.get(block.id);
    if (lots && lots.length > 0) {
      rest = differencePoly(rest, lots);
      const next = multiArea(rest);
      lotArea += left - next;
      left = next;
    }

    // Batched by reason rather than one boolean per discarded polygon: a block
    // can produce dozens of offcuts, and which of two same-reason offcuts a
    // square metre is charged to is not a question anybody asks.
    const losses = lossesByBlock.get(block.id);
    if (losses) {
      for (const reason of LAND_LOSS_REASONS) {
        if (left <= NOISE_AREA) break;
        const polys = losses.filter((l) => l.reason === reason).map((l) => l.polygon);
        if (polys.length === 0) continue;
        rest = differencePoly(rest, polys);
        const next = multiArea(rest);
        byReason[reason] += left - next;
        left = next;
      }
    }

    for (const piece of rest) {
      const a = area(piece);
      if (a < NOISE_AREA) continue;
      byReason.unaccounted += a;
      unaccounted.push({ polygon: piece, area: a, reason: 'unaccounted', blockId: block.id });
    }
  }

  // Land discarded before there were blocks to charge it to. Its road right of
  // way still comes off it — these are faces of the road graph, so half a
  // carriageway all the way round was never anybody's to use.
  let preBlockArea = 0;
  for (const loss of city.landLosses) {
    if (loss.blockId !== -1) continue;
    const netArea = multiArea(clipRoads([loss.polygon], roadBoxes));
    byReason[loss.reason] += netArea;
    preBlockArea += netArea;
  }

  let waste = 0;
  for (const r of LAND_LOSS_REASONS) {
    if (!DELIBERATE_LAND_LOSS.includes(r)) waste += byReason[r];
  }

  return {
    blockArea,
    rowArea,
    lotArea,
    byReason,
    preBlockArea,
    unaccounted,
    wasteShare: blockArea > 0 ? waste / blockArea : 0,
  };
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(poly: Polygon): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

const disjoint = (a: Box, b: Box): boolean =>
  a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;

/**
 * Subtract only the roads that reach these polygons.
 *
 * Handing the whole network to the clipper for every block is what makes the
 * naive version of this unusably slow; a bounding-box filter cuts it to the
 * handful of streets around each block.
 */
function clipRoads(polys: Polygon[], roads: { poly: Polygon; box: Box }[]): Polygon[] {
  if (polys.length === 0) return polys;
  let box: Box | null = null;
  for (const p of polys) {
    const b = boxOf(p);
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : b;
  }
  const near = roads.filter((r) => !disjoint(box!, r.box)).map((r) => r.poly);
  if (near.length === 0) return polys;
  return differencePoly(polys, near);
}
