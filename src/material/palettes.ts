import * as THREE from 'three';
import type { Rng } from '../core/rng.js';

/**
 * Colour tables drawn from real Japanese building finishes, plus the three rules
 * that do more for plausibility than any amount of tuning:
 *
 *   1. roof value  < wall value − 0.18
 *   2. roof saturation < wall saturation + 0.10
 *   3. two-tone walls split at the 1F/2F line, darker band below 70% of the time
 *
 * Colours are always jittered in **HSV**, never in RGB. Uniform RGB jitter
 * desaturates toward grey and produces the muddy look that gives procedural
 * cities away.
 */

/**
 * Weights matter as much as the colours: sampling these uniformly puts a fifth
 * of the town in charcoal or ガルバ black, when a real suburb is overwhelmingly
 * pale. The dark finishes are modern and comparatively rare.
 */
export const WALL_SIDING: readonly (readonly [number, number])[] = [
  [0xede9e0, 5], // off-white
  [0xded3c0, 5], // beige
  [0xcfc8bc, 4], // warm grey
  [0xc6c9cb, 3], // cool grey
  [0xa89684, 2.5], // taupe
  [0x7e7468, 1.2], // dark taupe
  [0x5a5148, 0.6], // charcoal brown
  [0x35393c, 0.5], // ガルバ black
  [0x4a5a6b, 0.5], // navy
] as const;

/** 吹付タイル — the sprayed mortar of older houses. */
export const WALL_MORTAR: readonly (readonly [number, number])[] = [
  [0xe4e0d4, 4],
  [0xd6cfc1, 4],
  [0xc8bfae, 3],
  [0xbfb6a4, 2],
] as const;

/** 二丁掛タイル — the RC mansion material. */
export const WALL_RC_TILE: readonly (readonly [number, number])[] = [
  [0xd9d3c7, 4],
  [0xc4b9a6, 4],
  [0x9e8e7c, 2],
  [0x6e625a, 1],
  [0xb0a596, 3],
] as const;

export const ROOF_METAL: readonly (readonly [number, number])[] = [
  [0x5c626a, 4], // 銀黒
  [0x5c7a72, 2.5], // 青緑
  [0x7a6047, 2], // brown
  [0x474d52, 2], // black
  [0x6a7280, 2],
] as const;

export const ROOF_KAWARA: readonly (readonly [number, number])[] = [
  [0x4a6a8c, 3], // cobalt
  [0x62786e, 3], // いぶし green
  [0xb06a44, 1.5], // orange
  [0x565c63, 3], // いぶし銀
] as const;

/** Entrance doors and apartment unit doors. */
export const ACCENT: readonly (readonly [number, number])[] = [
  [0x5c7c8a, 3],
  [0x6e8467, 3],
  [0x6b5545, 3],
  [0x8c4a42, 2],
  [0x7a7f85, 2],
] as const;

export const SASH: readonly (readonly [number, number])[] = [
  [0xb8bcc0, 4],
  [0x8a7a63, 2],
  [0xe6e6e4, 3],
  [0x3a3d40, 1.5],
] as const;

export const CONCRETE: readonly (readonly [number, number])[] = [
  [0xb9b5ad, 3],
  [0xa9a49c, 2],
  [0xc4c0b7, 3],
] as const;

export const FOLIAGE = [0x4e6b3f, 0x3f5a35, 0x5d7a45, 0x6b7f4a, 0x455f3a] as const;

export const CAR_BODY = [0xd8d8d6, 0x2f3236, 0x8f9296, 0x3c4a5c, 0x6d3a38, 0xe8e4dc] as const;

const hsv = new THREE.Color();
const tmp = new THREE.Color();

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function toHsv(hex: number): Hsv {
  tmp.setHex(hex, THREE.SRGBColorSpace);
  const out = { h: 0, s: 0, l: 0 };
  tmp.getHSL(out, THREE.SRGBColorSpace);
  // Convert HSL to HSV so the "value" rules read the way a painter expects.
  const v = out.l + out.s * Math.min(out.l, 1 - out.l);
  const s = v === 0 ? 0 : 2 * (1 - out.l / v);
  return { h: out.h, s, v };
}

export function fromHsv(c: Hsv): THREE.Color {
  const l = c.v * (1 - c.s / 2);
  const s = l === 0 || l === 1 ? 0 : (c.v - l) / Math.min(l, 1 - l);
  return hsv.clone().setHSL(c.h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)), THREE.SRGBColorSpace);
}

/** A palette is a list of `[hex, weight]` entries. */
export type Palette = readonly (readonly [number, number])[];

/** Pick a palette entry by weight and jitter it in HSV. */
export function sampleColor(
  palette: Palette,
  rng: Rng,
  jitter: { h?: number; s?: number; v?: number } = {},
): { color: THREE.Color; hsv: Hsv } {
  const base = toHsv(rng.weighted(palette));
  const c: Hsv = {
    h: (base.h + rng.jitter(jitter.h ?? 0.02) + 1) % 1,
    s: Math.min(1, Math.max(0, base.s + rng.jitter(jitter.s ?? 0.06))),
    v: Math.min(1, Math.max(0.02, base.v + rng.jitter(jitter.v ?? 0.05))),
  };
  return { color: fromHsv(c), hsv: c };
}

/**
 * Pick a roof colour that obeys rules 1 and 2 against an already-chosen wall.
 * Falls back to darkening the best candidate rather than looping forever.
 */
export function sampleRoofColor(
  palette: Palette,
  wall: Hsv,
  rng: Rng,
): { color: THREE.Color; hsv: Hsv } {
  let best: Hsv | null = null;
  for (let i = 0; i < 8; i++) {
    const cand = sampleColor(palette, rng, { h: 0.015, s: 0.05, v: 0.04 }).hsv;
    if (cand.v < wall.v - 0.18 && cand.s < wall.s + 0.1) return { color: fromHsv(cand), hsv: cand };
    if (!best || cand.v < best.v) best = cand;
  }
  const forced: Hsv = {
    h: best!.h,
    s: Math.min(best!.s, wall.s + 0.09),
    v: Math.min(best!.v, Math.max(0.05, wall.v - 0.2)),
  };
  return { color: fromHsv(forced), hsv: forced };
}

/** The lower band of a two-tone wall: usually darker, occasionally lighter. */
export function sampleBandColor(wall: Hsv, rng: Rng): { color: THREE.Color; hsv: Hsv } {
  const darker = rng.chance(0.7);
  const c: Hsv = {
    h: (wall.h + rng.jitter(0.03) + 1) % 1,
    s: Math.min(1, Math.max(0, wall.s + rng.jitter(0.05))),
    v: Math.min(1, Math.max(0.03, wall.v + (darker ? -rng.range(0.12, 0.3) : rng.range(0.06, 0.14)))),
  };
  return { color: fromHsv(c), hsv: c };
}

/** Grime at the base of a wall, as a vertex-colour multiplier. */
export function groundGrime(y: number, strength = 0.12): number {
  const t = Math.min(1, Math.max(0, 1 - y / 1.2));
  return 1 - strength * (t * t * (3 - 2 * t));
}
