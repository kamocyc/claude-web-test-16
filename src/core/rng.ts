/**
 * Deterministic pseudo-randomness.
 *
 * The discipline that makes the whole generator debuggable: **generators take a
 * seed string, never a shared `Rng` instance**. Sub-seeds are derived by path
 * (`"town-1/block/17/lot/4/facade"`), so generation is order-independent —
 * one building can be regenerated in isolation, work can move to a worker, and
 * adding a new prop type does not reshuffle every other building.
 */

/** xmur3 string hash — produces well-mixed 32-bit values to seed sfc32. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 — small, fast, long-period counter-based generator. */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform in [a, b). */
  range(a: number, b: number): number;
  /** Uniform element. */
  pick<T>(xs: readonly T[]): T;
  /** Weighted element; weights need not be normalised. */
  weighted<T>(xs: readonly (readonly [T, number])[]): T;
  /** Normal deviate (Box–Muller). */
  gauss(mu: number, sigma: number): number;
  /** Normal deviate clamped to [lo, hi]. */
  gaussClamped(mu: number, sigma: number, lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform in [-a, a]. */
  jitter(a: number): number;
  /** Fisher–Yates shuffle, returning a new array. */
  shuffled<T>(xs: readonly T[]): T[];
}

export function makeRng(seed: string | number): Rng {
  const h = xmur3(typeof seed === 'number' ? `n:${seed}` : seed);
  const next = sfc32(h(), h(), h(), h());
  // Discard the first few outputs; sfc32 needs a moment to mix from a cold state.
  for (let i = 0; i < 12; i++) next();

  let spare: number | null = null;
  const gauss = (mu: number, sigma: number): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return mu + sigma * v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return mu + sigma * u * f;
  };

  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (a, b) => a + next() * (b - a),
    pick: <T,>(xs: readonly T[]): T => {
      if (xs.length === 0) throw new Error('Rng.pick: empty array');
      return xs[Math.floor(next() * xs.length)]!;
    },
    weighted: <T,>(xs: readonly (readonly [T, number])[]): T => {
      if (xs.length === 0) throw new Error('Rng.weighted: empty array');
      let total = 0;
      for (const [, w] of xs) total += Math.max(0, w);
      if (total <= 0) return xs[0]![0];
      let r = next() * total;
      for (const [v, w] of xs) {
        r -= Math.max(0, w);
        if (r <= 0) return v;
      }
      return xs[xs.length - 1]![0];
    },
    gauss,
    gaussClamped: (mu, sigma, lo, hi) => Math.min(hi, Math.max(lo, gauss(mu, sigma))),
    chance: (p) => next() < p,
    jitter: (a) => (next() * 2 - 1) * a,
    shuffled: <T,>(xs: readonly T[]): T[] => {
      const out = xs.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
  };
}

/** Derive a child seed by path. `subSeed('town', 'block', 3) === 'town/block/3'`. */
export function subSeed(parent: string, ...path: (string | number)[]): string {
  return path.length === 0 ? parent : `${parent}/${path.join('/')}`;
}

/**
 * Deterministic 2D value noise on a hashed lattice, bilinearly interpolated with
 * a smoothstep fade. Used for the road-grid warp and the urbanity field; a
 * dependency-free stand-in for simplex noise that stays tied to the seed.
 */
export function makeValueNoise(seed: string): (x: number, y: number) => number {
  const base = xmur3(seed)();
  const hash = (ix: number, iy: number): number => {
    let h = base ^ Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = fade(x - x0);
    const ty = fade(y - y0);
    const a = hash(x0, y0);
    const b = hash(x0 + 1, y0);
    const c = hash(x0, y0 + 1);
    const d = hash(x0 + 1, y0 + 1);
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return (top + (bot - top) * ty) * 2 - 1; // [-1, 1]
  };
}

/** Two octaves of value noise, the shape used for both the road warp and urbanity. */
export function makeFbm(seed: string, octaves = 2): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, (_, i) => makeValueNoise(subSeed(seed, 'oct', i)));
  return (x, y) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (const n of layers) {
      sum += n(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  };
}

/** FNV-1a over a stream of numbers — used by the determinism test. */
export class Hasher {
  private h = 0x811c9dc5;

  number(v: number, decimals = 4): this {
    const s = Number.isFinite(v) ? v.toFixed(decimals) : 'NaN';
    return this.string(s);
  }

  string(s: string): this {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i);
      this.h = Math.imul(this.h, 0x01000193);
    }
    return this;
  }

  get value(): number {
    return this.h >>> 0;
  }
}
