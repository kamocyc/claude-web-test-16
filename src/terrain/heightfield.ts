import type { Vec2 } from '../core/types.js';

/**
 * A regular grid of sampled heights, bilinearly interpolated.
 *
 * The terrain is a sum of an fBm field, a carved river valley and a handful of
 * terrace steps, and the town asks it for a height something like a million
 * times — once per ground vertex, several times per lot boundary edge, once per
 * road node per relaxation sweep, once per camera frame. Evaluating that sum per
 * query would be the single slowest thing in the generator. So it is evaluated
 * once, into this.
 *
 * The grid also buys determinism of a kind the analytic field cannot give.
 * Every downstream consumer reads the *same array*, so no difference in
 * floating-point summation order between two call sites can move a lot boundary
 * by a micron — and `test/golden.test.ts` hashes lot coordinates to four
 * decimals, so a micron is not beneath its notice.
 */
export class Heightfield {
  readonly data: Float32Array;

  constructor(
    /** World coordinate of sample (0, 0). */
    readonly x0: number,
    readonly y0: number,
    readonly cell: number,
    readonly nx: number,
    readonly ny: number,
  ) {
    this.data = new Float32Array(nx * ny);
  }

  /** Fill every sample from a function of world position, in row-major order. */
  fill(f: (x: number, y: number) => number): void {
    for (let iy = 0; iy < this.ny; iy++) {
      const wy = this.y0 + iy * this.cell;
      const row = iy * this.nx;
      for (let ix = 0; ix < this.nx; ix++) {
        this.data[row + ix] = f(this.x0 + ix * this.cell, wy);
      }
    }
  }

  /** Rewrite every sample from its own value and world position. */
  map(f: (h: number, x: number, y: number) => number): void {
    for (let iy = 0; iy < this.ny; iy++) {
      const wy = this.y0 + iy * this.cell;
      const row = iy * this.nx;
      for (let ix = 0; ix < this.nx; ix++) {
        this.data[row + ix] = f(this.data[row + ix]!, this.x0 + ix * this.cell, wy);
      }
    }
  }

  /** World position of a sample. */
  posOf(ix: number, iy: number): Vec2 {
    return { x: this.x0 + ix * this.cell, y: this.y0 + iy * this.cell };
  }

  /** Sample by index, clamped to the grid — the edge extends outward for ever. */
  raw(ix: number, iy: number): number {
    const cx = ix < 0 ? 0 : ix >= this.nx ? this.nx - 1 : ix;
    const cy = iy < 0 ? 0 : iy >= this.ny ? this.ny - 1 : iy;
    return this.data[cy * this.nx + cx]!;
  }

  /**
   * Bilinear sample. Hot: no allocation, no `Vec2` in or out beyond the
   * argument, one clamp.
   */
  at(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell;
    const fy = (y - this.y0) / this.cell;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const a = this.raw(ix, iy);
    const b = this.raw(ix + 1, iy);
    const c = this.raw(ix, iy + 1);
    const d = this.raw(ix + 1, iy + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /** Central-difference gradient, one cell apart. */
  gradient(x: number, y: number): Vec2 {
    const h = this.cell;
    return {
      x: (this.at(x + h, y) - this.at(x - h, y)) / (2 * h),
      y: (this.at(x, y + h) - this.at(x, y - h)) / (2 * h),
    };
  }

  get min(): number {
    let lo = Infinity;
    for (const v of this.data) if (v < lo) lo = v;
    return lo;
  }

  get max(): number {
    let hi = -Infinity;
    for (const v of this.data) if (v > hi) hi = v;
    return hi;
  }
}

/**
 * Isolines at multiples of `interval`, by marching squares on the grid.
 *
 * Returned as loose segments rather than joined rings: the debug overlay draws
 * line segments anyway, and stitching them into rings is work with no consumer.
 */
export function contourSegments(field: Heightfield, interval: number): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  const lo = Math.ceil(field.min / interval) * interval;
  const hi = field.max;

  for (let level = lo; level <= hi; level += interval) {
    for (let iy = 0; iy + 1 < field.ny; iy++) {
      for (let ix = 0; ix + 1 < field.nx; ix++) {
        const h00 = field.raw(ix, iy);
        const h10 = field.raw(ix + 1, iy);
        const h11 = field.raw(ix + 1, iy + 1);
        const h01 = field.raw(ix, iy + 1);
        const code =
          (h00 > level ? 1 : 0) |
          (h10 > level ? 2 : 0) |
          (h11 > level ? 4 : 0) |
          (h01 > level ? 8 : 0);
        if (code === 0 || code === 15) continue;

        const x = field.x0 + ix * field.cell;
        const y = field.y0 + iy * field.cell;
        const c = field.cell;
        const lerpT = (a: number, b: number): number => (level - a) / (b - a || 1e-9);
        // Crossing point on each of the four cell edges, when it has one.
        const bottom = (): Vec2 => ({ x: x + c * lerpT(h00, h10), y });
        const right = (): Vec2 => ({ x: x + c, y: y + c * lerpT(h10, h11) });
        const top = (): Vec2 => ({ x: x + c * lerpT(h01, h11), y: y + c });
        const left = (): Vec2 => ({ x, y: y + c * lerpT(h00, h01) });

        switch (code) {
          case 1:
          case 14:
            out.push([left(), bottom()]);
            break;
          case 2:
          case 13:
            out.push([bottom(), right()]);
            break;
          case 3:
          case 12:
            out.push([left(), right()]);
            break;
          case 4:
          case 11:
            out.push([right(), top()]);
            break;
          case 6:
          case 9:
            out.push([bottom(), top()]);
            break;
          case 7:
          case 8:
            out.push([left(), top()]);
            break;
          // The two saddles. Resolving them by the cell average would be more
          // correct; at 2 m intervals on a 4 m grid the difference is a pixel.
          case 5:
            out.push([left(), bottom()], [right(), top()]);
            break;
          case 10:
            out.push([bottom(), right()], [left(), top()]);
            break;
        }
      }
    }
  }
  return out;
}
