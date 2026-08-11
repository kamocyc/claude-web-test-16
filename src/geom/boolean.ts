import pc from 'polygon-clipping';
import type { MultiPolygon, Polygon } from '../core/types.js';
import { area, ensureCCW } from './polygon.js';
import { cleanAll, type CleanOptions } from './simplify.js';

/**
 * Boolean operations on simple polygons.
 *
 * Two deliberate simplifications, both matched to how the generator uses them:
 *
 * 1. **Holes are dropped.** Nothing downstream models a building or a lot with a
 *    hole in it, and carrying holes through the footprint/façade pipeline would
 *    complicate every consumer. `differencePoly` is only ever called with clip
 *    shapes that reach the subject's boundary. A hole large enough to matter is
 *    reported in dev builds rather than silently discarded.
 *
 * 2. **Cleanup is mandatory, inside the wrapper.** Every result is passed
 *    through `cleanAll`. See the note at the top of `simplify.ts` for why.
 */

type PcRing = [number, number][];
type PcPoly = PcRing[];
type PcMulti = PcPoly[];

const DEFAULT_CLEAN: CleanOptions = { tolerance: 0.02, minEdge: 0.05, minArea: 0.02 };

/** Set to false in tests that deliberately exercise degenerate input. */
export let warnOnDroppedHoles = import.meta.env?.DEV ?? false;
export function setHoleWarnings(on: boolean): void {
  warnOnDroppedHoles = on;
}

function toPc(polys: Polygon[], quantum = 0): PcMulti {
  const q = quantum > 0 ? (v: number) => Math.round(v / quantum) * quantum : (v: number) => v;
  const out: PcMulti = [];
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const ring: PcRing = poly.map((p) => [q(p.x), q(p.y)] as [number, number]);
    ring.push([q(poly[0]!.x), q(poly[0]!.y)]);
    out.push([ring]);
  }
  return out;
}

function fromPc(multi: PcMulti, opts: CleanOptions): Polygon[] {
  const out: Polygon[] = [];
  for (const poly of multi) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    // polygon-clipping closes its rings; drop the repeated last vertex.
    const ring: Polygon = outer.slice(0, -1).map(([x, y]) => ({ x, y }));
    if (ring.length < 3) continue;
    out.push(ensureCCW(ring));

    if (warnOnDroppedHoles && poly.length > 1) {
      for (let h = 1; h < poly.length; h++) {
        const hole = poly[h]!;
        const holeRing: Polygon = hole.slice(0, -1).map(([x, y]) => ({ x, y }));
        if (holeRing.length >= 3 && area(holeRing) > 1.0) {
          console.warn(
            `[geom/boolean] dropped a hole of ${area(holeRing).toFixed(1)} m² — ` +
              `the caller probably wanted differencePoly with a boundary-touching clip`,
          );
        }
      }
    }
  }
  return cleanAll(out, opts);
}

function attempt(
  op: 'union' | 'intersection' | 'difference',
  ga: PcMulti,
  gb: PcMulti,
): PcMulti {
  switch (op) {
    case 'union':
      return gb.length === 0 ? pc.union(ga) : pc.union(ga, gb);
    case 'intersection':
      return gb.length === 0 ? [] : pc.intersection(ga, gb);
    case 'difference':
      return gb.length === 0 ? pc.union(ga) : pc.difference(ga, gb);
  }
}

/**
 * Coordinate quanta, in metres, tried in order. polygon-clipping occasionally
 * fails with "Unable to complete output ring" on inputs whose intersections
 * land near its internal precision threshold; snapping the input to a coarser
 * grid moves those points apart and the operation succeeds. Sub-millimetre
 * snapping is invisible at building scale.
 */
const QUANTA = [0, 0.001, 0.005, 0.02];

function run(
  op: 'union' | 'intersection' | 'difference',
  a: Polygon[],
  b: Polygon[],
  opts: CleanOptions,
): Polygon[] {
  if (a.length === 0) return [];
  if (op === 'intersection' && b.length === 0) return [];

  let lastErr: unknown = null;
  for (const q of QUANTA) {
    try {
      return fromPc(attempt(op, toPc(a, q), toPc(b, q)), opts);
    } catch (err) {
      lastErr = err;
    }
  }

  // Every quantum failed. Returning the subject unchanged keeps one bad lot
  // from taking down the whole city build, but it does mean the caller's
  // invariant is violated, so say so rather than failing silently.
  console.warn(`[geom/boolean] ${op} failed at every quantum; returning subject unchanged`, lastErr);
  return op === 'intersection' ? [] : cleanAll(a, opts);
}

/** Union of the inputs, also the canonical way to self-clean a self-touching ring. */
export const unionPoly = (polys: Polygon[], opts: CleanOptions = DEFAULT_CLEAN): Polygon[] =>
  run('union', polys, [], opts);

export const intersectPoly = (
  a: Polygon[],
  b: Polygon[],
  opts: CleanOptions = DEFAULT_CLEAN,
): Polygon[] => run('intersection', a, b, opts);

export const differencePoly = (
  a: Polygon[],
  b: Polygon[],
  opts: CleanOptions = DEFAULT_CLEAN,
): Polygon[] => run('difference', a, b, opts);

/** Total area of a multipolygon. */
export const multiArea = (polys: MultiPolygon): number =>
  polys.reduce((s, p) => s + area(p), 0);

/** The single largest component, or null when the set is empty. */
export function largest(polys: MultiPolygon): Polygon | null {
  let best: Polygon | null = null;
  let bestArea = -1;
  for (const p of polys) {
    const a = area(p);
    if (a > bestArea) {
      bestArea = a;
      best = p;
    }
  }
  return best;
}

/** How much of `a` survives intersection with `b`, as a fraction of area(a). */
export function overlapFraction(a: Polygon, b: Polygon): number {
  const aArea = area(a);
  if (aArea < 1e-9) return 0;
  return multiArea(intersectPoly([a], [b])) / aArea;
}
