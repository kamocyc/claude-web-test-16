import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

/**
 * Procedural surface textures, drawn on a `<canvas>` at start-up.
 *
 * All of these are **greyscale patterns centred on 1.0** (mid grey = no tint
 * change), so the per-building vertex colour comes through faithfully. That is
 * what makes one material serve thousands of differently-coloured buildings.
 *
 * Flat colours alone read as toy blocks at street level — there is no surface
 * scale cue. External texture assets would add a loading pipeline, licensing and
 * file size for something that is 40 lines of canvas drawing.
 */

export interface ProceduralTexture {
  map: THREE.Texture;
  normal: THREE.Texture | null;
  /** Metres covered by one texture repeat, used to set `repeat` on meshes. */
  scale: number;
}

const SIZE = 512;

function canvas(): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = true;
  return { c, ctx };
}

/** Grey level as a CSS colour; `v` is a multiplier around 1.0. */
const grey = (v: number, a = 1): string => {
  const g = Math.round(Math.min(255, Math.max(0, v * 128)));
  return `rgba(${g},${g},${g},${a})`;
};

function fill(ctx: CanvasRenderingContext2D, v: number): void {
  ctx.fillStyle = grey(v);
  ctx.fillRect(0, 0, SIZE, SIZE);
}

/** Fine value noise, drawn as single pixels so it survives mipmapping as grain. */
function speckle(ctx: CanvasRenderingContext2D, seed: string, amount: number, count: number): void {
  const rng = makeRng(seed);
  for (let i = 0; i < count; i++) {
    const x = rng.int(SIZE);
    const y = rng.int(SIZE);
    const v = 1 + rng.jitter(amount);
    ctx.fillStyle = grey(v, 0.55);
    ctx.fillRect(x, y, 1, 1);
  }
}

/** Soft blobs — the 吹付 stipple and general mottling. */
function stipple(ctx: CanvasRenderingContext2D, seed: string, count: number, rMin: number, rMax: number, amount: number): void {
  const rng = makeRng(seed);
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, SIZE);
    const y = rng.range(0, SIZE);
    const r = rng.range(rMin, rMax);
    const v = 1 + rng.jitter(amount);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, grey(v, 0.5));
    g.addColorStop(1, grey(v, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A horizontal line that wraps, drawn with a bright edge above a dark seam. */
function seamLine(ctx: CanvasRenderingContext2D, y: number, dark: number, light: number, thickness = 1): void {
  ctx.fillStyle = grey(dark, 0.85);
  ctx.fillRect(0, y, SIZE, thickness);
  ctx.fillStyle = grey(light, 0.5);
  ctx.fillRect(0, y - 1, SIZE, 1);
}

function toTexture(c: HTMLCanvasElement, anisotropy: number, colorSpace: THREE.ColorSpace): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Derive a tangent-space normal map from the luminance of a canvas by Sobel
 * filtering. Cheap, and enough to make joints and seams catch the sun.
 */
function sobelNormalMap(src: HTMLCanvasElement, strength: number, anisotropy: number): THREE.Texture {
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  const data = sctx.getImageData(0, 0, SIZE, SIZE).data;
  const lum = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) lum[i] = data[i * 4]! / 255;

  const { c: out, ctx } = canvas();
  const img = ctx.createImageData(SIZE, SIZE);
  const at = (x: number, y: number) => lum[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]!;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const gx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const gy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = gx * strength;
      let ny = gy * strength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      const i = (y * SIZE + x) * 4;
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((1 / l) * 0.5 * 255 + 127);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(out, anisotropy, THREE.NoColorSpace);
}

/** サイディング — lap siding boards with visible joints. */
export function makeSidingTexture(
  style: 'horizontal' | 'vertical' | 'largeFormat',
  anisotropy: number,
): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);

  const rng = makeRng(`siding/${style}`);
  if (style === 'horizontal' || style === 'vertical') {
    if (style === 'vertical') {
      ctx.translate(SIZE / 2, SIZE / 2);
      ctx.rotate(Math.PI / 2);
      ctx.translate(-SIZE / 2, -SIZE / 2);
    }
    // 16 px per board ≈ 0.4 m at the chosen 0.025 m/px scale.
    const pitch = 16;
    for (let y = 0; y < SIZE; y += pitch) {
      // Slight per-board value variation so the wall is not a flat field.
      ctx.fillStyle = grey(1 + rng.jitter(0.035), 0.5);
      ctx.fillRect(0, y, SIZE, pitch);
      seamLine(ctx, y, 0.9, 1.06);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    // Large-format panels: a sparse grid of 1.2 m x 3 m joints.
    for (let y = 0; y < SIZE; y += 120) seamLine(ctx, y, 0.88, 1.05, 2);
    for (let x = 0; x < SIZE; x += 240) {
      ctx.fillStyle = grey(0.88, 0.85);
      ctx.fillRect(x, 0, 2, SIZE);
    }
  }

  speckle(ctx, `siding/${style}/noise`, 0.05, 9000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 1.6, anisotropy), scale: 12.8 };
}

/** 二丁掛タイル — the RC mansion material. 227 x 60 mm tiles with 8 mm grout. */
export function makeTileTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 0.86); // grout
  const rng = makeRng('tile');
  const tw = 64;
  const th = 17;
  const gap = 2.5;
  for (let row = 0, y = 0; y < SIZE; row++, y += th) {
    const offset = row % 2 === 0 ? 0 : tw / 2;
    for (let x = -tw; x < SIZE + tw; x += tw) {
      ctx.fillStyle = grey(1 + rng.jitter(0.03));
      ctx.fillRect(x + offset + gap / 2, y + gap / 2, tw - gap, th - gap);
    }
  }
  speckle(ctx, 'tile/noise', 0.03, 6000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 2.2, anisotropy), scale: 6.4 };
}

/** 吹付タイル — the sprayed-mortar finish of older houses. */
export function makeMortarTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  stipple(ctx, 'mortar/blobs', 3000, 1.5, 4.5, 0.14);
  speckle(ctx, 'mortar/noise', 0.06, 14000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 1.1, anisotropy), scale: 6.4 };
}

/** ブロック塀 — 390 x 190 mm concrete blocks in running bond, with grime. */
export function makeConcreteBlockTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 0.9);
  const rng = makeRng('cblock');
  // 0.025 m/px would make a block 156 x 76 px; use 128 x 62 for a 3.2 m repeat.
  const bw = 128;
  const bh = 62;
  const joint = 3;
  for (let row = 0, y = 0; y < SIZE; row++, y += bh) {
    const offset = row % 2 === 0 ? 0 : bw / 2;
    for (let x = -bw; x < SIZE + bw; x += bw) {
      ctx.fillStyle = grey(1 + rng.jitter(0.04));
      ctx.fillRect(x + offset + joint, y + joint, bw - joint * 2, bh - joint * 2);
      // The recessed centre panel each block is moulded with.
      ctx.fillStyle = grey(0.97, 0.5);
      ctx.fillRect(x + offset + bw * 0.22, y + bh * 0.22, bw * 0.56, bh * 0.56);
    }
  }
  // Weathering: streaks running down from the top.
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, grey(0.86, 0.35));
  g.addColorStop(0.4, grey(1, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  speckle(ctx, 'cblock/noise', 0.05, 9000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 2.4, anisotropy), scale: 12.8 };
}

/** 立平葺き — standing-seam metal roofing, vertical ribs. */
export function makeMetalRoofTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  const pitch = 40;
  for (let x = 0; x < SIZE; x += pitch) {
    // Raised seam: a bright edge with a dark shadow line beside it.
    ctx.fillStyle = grey(1.14, 0.8);
    ctx.fillRect(x, 0, 3, SIZE);
    ctx.fillStyle = grey(0.82, 0.75);
    ctx.fillRect(x + 3, 0, 3, SIZE);
    ctx.fillStyle = grey(1.03, 0.25);
    ctx.fillRect(x + 6, 0, pitch - 6, SIZE);
  }
  speckle(ctx, 'metalroof/noise', 0.03, 5000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 2.6, anisotropy), scale: 10 };
}

/** 桟瓦 — pantiles: overlapping wave rows with a strong shadow under each lap. */
export function makeKawaraTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  const rowH = 64;
  const colW = 64;
  const rng = makeRng('kawara');
  for (let y = 0; y < SIZE; y += rowH) {
    for (let x = 0; x < SIZE; x += colW) {
      const v = 1 + rng.jitter(0.04);
      // The wave: a bright roll on the left, flat pan to the right.
      const g = ctx.createLinearGradient(x, 0, x + colW, 0);
      g.addColorStop(0, grey(v * 0.9));
      g.addColorStop(0.18, grey(v * 1.12));
      g.addColorStop(0.42, grey(v));
      g.addColorStop(1, grey(v * 0.97));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, colW, rowH);
    }
    // Deep shadow under the lap — the single strongest cue that it is tile.
    ctx.fillStyle = grey(0.62, 0.85);
    ctx.fillRect(0, y, SIZE, 5);
    ctx.fillStyle = grey(1.18, 0.5);
    ctx.fillRect(0, y + 5, SIZE, 2);
  }
  speckle(ctx, 'kawara/noise', 0.04, 6000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 3.0, anisotropy), scale: 3.2 };
}

/**
 * 折板 — the ribbed steel of a factory roof and its cladding.
 *
 * Deliberately coarser and harder-edged than 立平葺き above. Standing seam is a
 * thin raised welt every 40 px; 折板 is a trapezoidal profile at roughly a third
 * of a metre, with a flat crown, sloped webs and a hard shadow in the valley.
 * At the distance an industrial estate is usually seen from, that pitch and that
 * shadow are the whole of what says "factory" rather than "big pale building".
 */
export function makeRibbedMetalTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  const pitch = 42; // ≈ 0.33 m at the 4 m repeat below
  for (let x = 0; x < SIZE; x += pitch) {
    // Valley, then the sloped web up to the crown, then the crown itself.
    ctx.fillStyle = grey(0.74, 0.9);
    ctx.fillRect(x, 0, 5, SIZE);
    ctx.fillStyle = grey(0.9, 0.6);
    ctx.fillRect(x + 5, 0, 4, SIZE);
    ctx.fillStyle = grey(1.16, 0.7);
    ctx.fillRect(x + 9, 0, 14, SIZE);
    ctx.fillStyle = grey(1.0, 0.35);
    ctx.fillRect(x + 23, 0, pitch - 23, SIZE);
  }
  // Long streaks down the ribs: industrial cladding weathers vertically.
  const rng = makeRng('ribbed/streaks');
  for (let i = 0; i < 90; i++) {
    const x = rng.int(SIZE);
    const h = rng.range(SIZE * 0.2, SIZE);
    ctx.fillStyle = grey(1 - rng.range(0.03, 0.1), 0.3);
    ctx.fillRect(x, rng.range(0, SIZE - h), 2, h);
  }
  speckle(ctx, 'ribbed/noise', 0.035, 6000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 3.0, anisotropy), scale: 4.0 };
}

/**
 * ALC・押出成形セメント板 — panel cladding.
 *
 * Almost flat: 600 mm vertical joints, a 3 m horizontal one where the panels
 * stack, and a faint sanded grain. The restraint is the point — it is what
 * distinguishes a 雑居ビル from a tiled マンション at a glance, and adding more
 * would just make it read as another tile.
 */
export function makeAlcPanelTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  const rng = makeRng('alc');
  const panel = 100; // 600 mm at a 6 m repeat
  for (let x = 0; x < SIZE; x += panel) {
    ctx.fillStyle = grey(1 + rng.jitter(0.022), 0.6);
    ctx.fillRect(x, 0, panel, SIZE);
    ctx.fillStyle = grey(0.84, 0.8);
    ctx.fillRect(x, 0, 2, SIZE);
    ctx.fillStyle = grey(1.07, 0.4);
    ctx.fillRect(x + 2, 0, 1, SIZE);
  }
  for (let y = 0; y < SIZE; y += SIZE / 2) seamLine(ctx, y, 0.85, 1.06, 2);
  stipple(ctx, 'alc/grain', 900, 1, 3, 0.05);
  speckle(ctx, 'alc/noise', 0.04, 8000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 1.3, anisotropy), scale: 6.0 };
}

/**
 * シャッター — the rolling shutter of a closed shop or a loading dock.
 *
 * Horizontal slats at 80 mm with a hard shadow line under each. Drawn rather
 * than modelled: at 80 mm a slat is well under one pixel of screen space from
 * anywhere but arm's length, and thirty extruded boxes per shopfront across a
 * whole shopping street is a lot of triangles for a line of shadow.
 */
export function makeShutterTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  const rng = makeRng('shutter');
  const slat = 17; // 80 mm at the 2.4 m repeat
  for (let y = 0; y < SIZE; y += slat) {
    const v = 1 + rng.jitter(0.03);
    const g = ctx.createLinearGradient(0, y, 0, y + slat);
    g.addColorStop(0, grey(v * 1.1));
    g.addColorStop(0.55, grey(v));
    g.addColorStop(1, grey(v * 0.88));
    ctx.fillStyle = g;
    ctx.fillRect(0, y, SIZE, slat);
    ctx.fillStyle = grey(0.7, 0.8);
    ctx.fillRect(0, y + slat - 2, SIZE, 2);
  }
  speckle(ctx, 'shutter/noise', 0.03, 5000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: sobelNormalMap(c, 2.0, anisotropy), scale: 2.4 };
}

/** Very low-frequency ground mottling, to stop the base plane reading as flat. */
export function makeGroundTexture(anisotropy: number): ProceduralTexture {
  const { c, ctx } = canvas();
  fill(ctx, 1.0);
  stipple(ctx, 'ground/blobs', 260, 24, 90, 0.16);
  speckle(ctx, 'ground/noise', 0.09, 22000);
  return { map: toTexture(c, anisotropy, THREE.NoColorSpace), normal: null, scale: 40 };
}
