import * as THREE from 'three';
import type { RoofHue, RoofHueMix } from '../core/params.js';
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

/**
 * ALC・押出成形セメント板 — the panel cladding of a post-war 雑居ビル and of the
 * office end of a factory. Paler and flatter than 二丁掛タイル.
 */
export const WALL_ALC: readonly (readonly [number, number])[] = [
  [0xd8d6cf, 4],
  [0xc9c6bd, 4],
  [0xb9b3a6, 2],
  [0x9aa0a4, 2],
  [0xe2ded3, 3],
] as const;

/**
 * The pale grey-blue, sage and cream of a Japanese factory shed. Industrial
 * cladding is not grey: it is *nearly* grey, tinted, and that tint is most of
 * what stops an industrial estate reading as a row of concrete blocks.
 */
export const WALL_INDUSTRIAL: readonly (readonly [number, number])[] = [
  [0xc3cad0, 4],
  [0xdad9d4, 4],
  [0xb9c0b4, 2],
  [0xa8bccd, 2.5],
  [0xd4cbb8, 2],
] as const;

/**
 * 看板 bands and shopfront frames.
 *
 * Weighted toward the muted, following the same discipline as the wall tables:
 * a shopping street is not a row of primary colours, it is dark green, maroon
 * and off-white with the occasional loud one. The saturated colours live in
 * `SIGN_FACE`, which only ever reaches a 袖看板 panel a metre across.
 */
export const SHOPFRONT: readonly (readonly [number, number])[] = [
  [0x9e3b34, 3],
  [0x2f4a70, 3],
  [0x2e6047, 2],
  [0xe8e2d3, 3],
  [0x2a2a2c, 1.5],
  [0x7a5a2e, 1.5],
] as const;

/** Projecting sign faces — the one place saturation is allowed off the leash. */
export const SIGN_FACE = [0xd93b30, 0xf0b429, 0x1c74bd, 0x1f9d55, 0xf5f2ea, 0xe8622c] as const;

/**
 * Roof colour families. The mix between these is the single most visible
 * parameter in the whole generator — it is what the town reads as from the air —
 * so it is a *setting* (`buildings.roofHueMix`) rather than a weight buried in a
 * table. The per-swatch weights below only distribute a family's share among its
 * own shades; the family's overall presence comes from the mix.
 */
export type RoofPalette = readonly (readonly [number, number, RoofHue])[];

export const ROOF_METAL: RoofPalette = [
  [0x8a4f3c, 5, 'redBrown'], // 赤錆茶 — the classic painted-steel red-brown
  [0x7d4a38, 4, 'redBrown'], // deeper red-brown
  [0x3f4a70, 2, 'navy'], // 紺 navy
  [0x4a5580, 1, 'navy'], // lighter navy
  [0x7a6047, 1, 'brown'], // brown
  [0x5c626a, 2, 'grey'], // 銀黒
  [0x474d52, 1.2, 'grey'], // black
  [0x5c7a72, 1, 'green'], // 青緑
] as const;

/**
 * 折板 — the ribbed steel roof of every factory and warehouse.
 *
 * Tagged with the same `RoofHue` families as the domestic palettes on purpose,
 * so `sampleRoofColor` and the `roofHueMix` setting still govern the industrial
 * quarter. A separate untagged table would have quietly exempted a fifth of the
 * town's roof area from the one setting that decides what it reads as from the air.
 */
export const ROOF_RIBBED: RoofPalette = [
  [0xa8adb2, 4, 'grey'],
  [0xb9bcb5, 2, 'grey'],
  [0x6f7d8c, 2, 'navy'],
  [0x5d7060, 1.5, 'green'],
  [0x8a5a44, 1.5, 'redBrown'],
] as const;

export const ROOF_KAWARA: RoofPalette = [
  [0x9c4f33, 3, 'redBrown'], // 赤茶 — red-brown pantile
  [0xb06a44, 1.5, 'redBrown'], // orange
  [0x3a4a70, 2, 'navy'], // 紺 navy
  [0x4a6a8c, 1.2, 'navy'], // cobalt
  [0x565c63, 1.5, 'grey'], // いぶし銀
  [0x62786e, 1, 'green'], // いぶし green
] as const;

/**
 * Resolve a roof palette against the requested family mix.
 *
 * Each family's swatch weights are normalised among themselves first, so a mix
 * entry is the family's *share of the palette* and not a multiplier on whatever
 * the table happened to hold. That is what makes the slider mean something: set
 * 紺 to 20 and 20% of the roofs are navy. A family a palette does not carry —
 * 瓦 has no plain brown — simply drops out, and the rest renormalise.
 */
function pickFamily(entries: RoofPalette, mix: RoofHueMix, rng: Rng): RoofHue | null {
  const seen = new Map<RoofHue, number>();
  for (const [, , hue] of entries) {
    if (!seen.has(hue) && mix[hue] > 0) seen.set(hue, mix[hue]);
  }
  if (seen.size === 0) return null;
  return rng.weighted([...seen.entries()]);
}

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
 * Cap on roof saturation. This used to be *relative* to the wall
 * (`cand.s < wall.s + 0.1`), which was simply wrong: walls here are pale
 * beiges and greys at a saturation around 0.1, while a real cobalt or red-brown
 * roof sits near 0.5. Every coloured roof therefore failed the test, fell
 * through to the fallback, and had its saturation crushed to grey — which is
 * why the town came out roofed entirely in charcoal.
 *
 * Roofs being *darker* than the wall is the rule that actually holds.
 *
 * The cap then sat at 0.52 — just under 赤錆茶 (0.565) and its deeper sibling
 * (0.552), the two highest-weighted entries on the metal palette. Both were
 * therefore rejected on every draw and only ever reached a roof through the
 * fallback, desaturated. The navies (0.42–0.44) passed, so they inherited the
 * red-browns' weight on top of their own: 59% of pitched roofs came out blue
 * against a palette that asked for 11%. Both caps below clear every swatch in
 * the tables; they exist to catch the jitter tail, not to veto the palette.
 */
const ROOF_MAX_SATURATION = 0.74;
const ROOF_MAX_VALUE = 0.72;

/**
 * Pick a roof colour: family from the mix, shade from within that family.
 *
 * Choosing the family *first* is the whole point. The loop below returns the
 * first candidate that passes the wall test, so with one flat palette every
 * rejected swatch hands its weight to whatever does pass — and the navies, being
 * the darkest entries, passed on walls the red-browns could not. That is how a
 * table asking for 11% navy produced a town that was half blue, and no amount of
 * reweighting the table fixes it. Now rejection can only ever reshuffle shades
 * inside the family the mix already picked, so `roofHueMix` is a setting that
 * holds rather than a suggestion.
 */
export function sampleRoofColor(
  entries: RoofPalette,
  mix: RoofHueMix,
  wall: Hsv,
  rng: Rng,
): { color: THREE.Color; hsv: Hsv } {
  const family = pickFamily(entries, mix, rng);
  const shades: [number, number][] = entries
    .filter(([, , hue]) => family === null || hue === family)
    .map(([c, w]) => [c, w]);

  const limit = Math.max(ROOF_MAX_VALUE, wall.v - 0.08);
  let best: Hsv | null = null;
  for (let i = 0; i < 8; i++) {
    const cand = sampleColor(shades, rng, { h: 0.015, s: 0.05, v: 0.04 }).hsv;
    if (cand.v <= limit && cand.s <= ROOF_MAX_SATURATION) {
      return { color: fromHsv(cand), hsv: cand };
    }
    if (!best || cand.v < best.v) best = cand;
  }
  const forced: Hsv = {
    h: best!.h,
    s: Math.min(best!.s, ROOF_MAX_SATURATION),
    v: Math.min(best!.v, Math.max(0.05, wall.v - 0.18)),
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
