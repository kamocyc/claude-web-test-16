import type { Polygon } from '../core/types.js';
import { contains } from './polygon.js';
import { extentsIn, type Frame, type LocalRect } from './obb.js';

/**
 * Largest inscribed axis-aligned rectangle, found by rasterising the polygon and
 * running the classic "largest rectangle in a histogram" scan.
 *
 * Chosen over an analytic method because it is robust on concave polygons — the
 * lot shapes this generator produces are routinely concave (flag lots, corner
 * clips) — and because the failure mode is a slightly small rectangle rather
 * than a wrong one.
 */

export interface InscribedRect {
  rect: LocalRect;
  /** Rectangle area in square metres. */
  area: number;
}

export function largestInscribedRect(
  poly: Polygon,
  frame: Frame,
  cell = 0.25,
  maxCells = 160,
): InscribedRect | null {
  const ext = extentsIn(poly, frame);
  if (ext.w <= cell || ext.d <= cell) return null;

  // Keep the raster bounded regardless of lot size.
  const step = Math.max(cell, ext.w / maxCells, ext.d / maxCells);
  const nx = Math.max(1, Math.floor(ext.w / step));
  const ny = Math.max(1, Math.floor(ext.d / step));
  const u0 = ext.cx - ext.w / 2;
  const v0 = ext.cy - ext.d / 2;

  // Sample cell centres in world space.
  const inside = new Uint8Array(nx * ny);
  const ax = frame.xAxis;
  const ay = { x: -ax.y, y: ax.x };
  for (let j = 0; j < ny; j++) {
    const v = v0 + (j + 0.5) * step;
    for (let i = 0; i < nx; i++) {
      const u = u0 + (i + 0.5) * step;
      const wx = frame.origin.x + ax.x * u + ay.x * v;
      const wy = frame.origin.y + ax.y * u + ay.y * v;
      if (contains(poly, { x: wx, y: wy })) inside[j * nx + i] = 1;
    }
  }

  // Largest rectangle in a binary matrix, row by row, via histogram heights.
  // The stack holds (startIndex, height) pairs; storing the height explicitly
  // matters — reading it back from `heights[startIndex]` is wrong once bars of
  // equal height have been merged and `startIndex` has moved left.
  const heights = new Int32Array(nx);
  const stackIdx = new Int32Array(nx + 1);
  const stackH = new Int32Array(nx + 1);
  let best: { i0: number; i1: number; j0: number; j1: number; cells: number } | null = null;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      heights[i] = inside[j * nx + i] ? heights[i]! + 1 : 0;
    }
    let top = 0; // stack size
    for (let i = 0; i <= nx; i++) {
      const h = i < nx ? heights[i]! : 0;
      let start = i;
      while (top > 0 && stackH[top - 1]! >= h) {
        top--;
        const idx = stackIdx[top]!;
        const hh = stackH[top]!;
        const cells = hh * (i - idx);
        if (hh > 0 && (!best || cells > best.cells)) {
          best = { i0: idx, i1: i - 1, j0: j - hh + 1, j1: j, cells };
        }
        start = idx;
      }
      if (i < nx) {
        stackIdx[top] = start;
        stackH[top] = h;
        top++;
      }
    }
  }

  if (!best || best.cells <= 0) return null;
  const w = (best.i1 - best.i0 + 1) * step;
  const d = (best.j1 - best.j0 + 1) * step;
  const rect: LocalRect = {
    cx: u0 + ((best.i0 + best.i1 + 1) / 2) * step,
    cy: v0 + ((best.j0 + best.j1 + 1) / 2) * step,
    w,
    d,
  };
  return { rect, area: w * d };
}

/**
 * Try several candidate orientations and keep the highest-scoring result. The
 * score is what keeps buildings facing the street rather than merely filling the
 * most area.
 */
export function bestInscribedRect(
  poly: Polygon,
  candidates: Frame[],
  score: (rect: LocalRect, frameIndex: number) => number,
  cell = 0.25,
): { rect: LocalRect; frame: Frame; frameIndex: number } | null {
  let best: { rect: LocalRect; frame: Frame; frameIndex: number; score: number } | null = null;
  for (let k = 0; k < candidates.length; k++) {
    const f = candidates[k]!;
    const r = largestInscribedRect(poly, f, cell);
    if (!r) continue;
    const s = score(r.rect, k);
    if (!best || s > best.score) best = { rect: r.rect, frame: f, frameIndex: k, score: s };
  }
  return best ? { rect: best.rect, frame: best.frame, frameIndex: best.frameIndex } : null;
}
