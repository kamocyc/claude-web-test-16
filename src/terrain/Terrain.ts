import type { Polygon, Vec2 } from '../core/types.js';
import type { TerrainParams } from '../core/params.js';
import { makeFbm, makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { Heightfield } from './heightfield.js';
import {
  makeRiver,
  riverCarve,
  riverDistance,
  riverNearest,
  riverSample,
  riverWaterAt,
  type River,
} from './River.js';
import { makeTerraces, nearestTerrace, terraceStep, type TerraceHit, type TerraceLine } from './Terrace.js';

/**
 * The land, and everything the town needs to ask of it.
 *
 * A single object built once per generation, before any road exists, and then
 * treated as read-only by everything downstream. The whole rest of the
 * generator sees the terrain only through this interface, which is what lets
 * `FLAT_TERRAIN` stand in for it everywhere: a flat world is not a special case
 * in the road generator or the lot subdivider, it is this object answering zero.
 *
 * That matters more than it sounds. Terrain touches every stage of the pipeline,
 * so without a null object the change would be one unreviewable diff — and
 * `test/golden.test.ts` could no longer distinguish "the town moved because the
 * land moved" from "the town moved because a refactor broke something".
 */

export interface Terrain {
  readonly params: TerrainParams;
  /** Ground height in metres. The station sits at y ≈ 0. */
  heightAt(p: Vec2): number;
  /** Same, without the `Vec2` — the hot path for meshes and profiles. */
  heightAtXY(x: number, y: number): number;
  gradientAt(p: Vec2): Vec2;
  /** |gradient|, i.e. the tangent of the steepest slope angle. */
  slopeAt(p: Vec2): number;
  /** Water surface height at `p`, or null outside the channel. */
  waterAt(p: Vec2): number | null;
  /** Distance to the water's edge; negative inside the channel. */
  waterDistance(p: Vec2): number;
  nearestTerrace(p: Vec2, within: number): TerraceHit | null;
  /** min / max / mean over a polygon, for levelling a lot. */
  extremesOver(poly: Polygon, spacing?: number): { min: number; max: number; mean: number };
  readonly field: Heightfield | null;
  readonly river: River | null;
  readonly terraces: readonly TerraceLine[];
  /** Water surface polygon, for the ground mesh. */
  readonly waterPolygons: readonly Polygon[];
  /** Water plus its margin — nothing may be built inside. */
  readonly bankPolygons: readonly Polygon[];
}

const FLAT_PARAMS: TerrainParams = {
  enabled: false,
  cell: 4,
  margin: 0,
  relief: 0,
  hillScale: 260,
  hillOctaves: 2,
  tiltGrade: 0,
  maxBuildSlope: 1,
  river: {
    enabled: false,
    width: 0,
    valleyWidth: 1,
    bedGrade: 0,
    waterDepth: 0,
    bankMargin: 0,
    meander: 0,
  },
  terrace: {
    count: 0,
    step: 0,
    stepVariation: 0,
    width: 1,
    minOffset: 0,
    maxOffset: 0,
  },
};

const ZERO: Vec2 = { x: 0, y: 0 };

/** The world as it was before this file existed. Every query answers zero. */
export const FLAT_TERRAIN: Terrain = {
  params: FLAT_PARAMS,
  heightAt: () => 0,
  heightAtXY: () => 0,
  gradientAt: () => ZERO,
  slopeAt: () => 0,
  waterAt: () => null,
  waterDistance: () => Infinity,
  nearestTerrace: () => null,
  extremesOver: () => ({ min: 0, max: 0, mean: 0 }),
  field: null,
  river: null,
  terraces: [],
  waterPolygons: [],
  bankPolygons: [],
};

/**
 * Pick the datum: the flattest point near the middle of the town, above the
 * flood plain and clear of the scarps.
 *
 * The station goes here and the whole field is shifted so it sits at y = 0. Two
 * reasons, both practical: the camera presets, the fog and `shadowExtent` are
 * all tuned around a ground plane at zero, and a town whose datum wandered with
 * the seed would put half the seeds under the shadow camera.
 */
function pickDatum(field: Heightfield, extent: number, river: River | null, terraces: TerraceLine[]): Vec2 {
  const r = extent * 0.25;
  let best: Vec2 = { x: 0, y: 0 };
  let bestScore = Infinity;
  const step = Math.max(8, field.cell * 3);
  for (let y = -r; y <= r; y += step) {
    for (let x = -r; x <= r; x += step) {
      if (river) {
        const d = riverDistance(river, x, y);
        if (d < river.params.bankMargin + 25) continue;
      }
      if (nearestTerrace(terraces, x, y, 22)) continue;
      const g = field.gradient(x, y);
      const score = Math.hypot(g.x, g.y) + Math.hypot(x, y) / (extent * 40);
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

export function makeTerrain(seed: string, p: TerrainParams, extent: number): Terrain {
  if (!p.enabled) return FLAT_TERRAIN;

  const rng = makeRng(subSeed(seed, 'terrain'));
  const hills = makeFbm(subSeed(seed, 'terrain', 'hills'), p.hillOctaves);
  const tiltDir = V.fromAngle(rng.range(0, Math.PI * 2));
  const amplitude = p.relief / 2;

  /** The land before the river touched it: an overall fall plus hills. */
  const base = (x: number, y: number): number =>
    (x * tiltDir.x + y * tiltDir.y) * p.tiltGrade + hills(x / p.hillScale, y / p.hillScale) * amplitude;

  const river = p.river.enabled ? makeRiver(subSeed(seed, 'terrain'), extent, p.river, base) : null;
  // A scarp belongs on the shoulder of the valley, not in it — that is what
  // makes it a river terrace rather than a wall someone left in the water.
  const keepClear = river ? river.params.valleyWidth * 0.6 : 0;
  const terraces = makeTerraces(
    subSeed(seed, 'terrain'),
    extent,
    p.terrace,
    river ? river.centre : null,
    keepClear,
  );

  const half = extent + p.margin;
  const n = Math.max(2, Math.round((half * 2) / p.cell) + 1);
  const field = new Heightfield(-half, -half, p.cell, n, n);
  field.fill((x, y) => {
    let h = base(x, y);
    for (const t of terraces) h += terraceStep(t, x, y);
    // The carve is applied last, and against the *already stepped* height, so
    // the channel lands exactly on the bed whatever else has happened to the
    // land. Carving the bare fBm and then adding a terrace on top put a 4 m
    // step through the river and left the water running along a ridge.
    if (river) h -= riverCarve(river, x, y, h);
    return h;
  });

  // Shift so the datum is zero. Doing it to the array rather than inside every
  // query keeps `heightAt` a single bilinear read.
  const datum = pickDatum(field, extent, river, terraces);
  const shift = field.at(datum.x, datum.y);
  for (let i = 0; i < field.data.length; i++) field.data[i]! -= shift;
  if (river) {
    for (let i = 0; i < river.bed.length; i++) {
      river.bed[i]! -= shift;
      river.water[i]! -= shift;
    }
  }

  const heightAtXY = (x: number, y: number): number => field.at(x, y);

  return {
    params: p,
    heightAt: (q) => field.at(q.x, q.y),
    heightAtXY,
    gradientAt: (q) => field.gradient(q.x, q.y),
    slopeAt: (q) => {
      const g = field.gradient(q.x, q.y);
      return Math.hypot(g.x, g.y);
    },
    waterAt: (q) => (river ? riverWaterAt(river, q.x, q.y) : null),
    waterDistance: (q) => (river ? riverDistance(river, q.x, q.y) : Infinity),
    nearestTerrace: (q, within) => nearestTerrace(terraces, q.x, q.y, within),
    extremesOver: (poly, spacing = 3) => extremesOver(heightAtXY, poly, spacing),
    field,
    river,
    terraces,
    waterPolygons: river ? [river.channel] : [],
    bankPolygons: river ? [river.banks] : [],
  };
}

/**
 * Sample a polygon's interior on a grid, plus every vertex.
 *
 * The vertices matter as much as the interior: a lot's corner is exactly where a
 * retaining wall has to reach, and a grid coarse enough to be cheap will miss it
 * on a narrow parcel.
 */
function extremesOver(
  h: (x: number, y: number) => number,
  poly: Polygon,
  spacing: number,
): { min: number; max: number; mean: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  const take = (x: number, y: number): void => {
    const v = h(x, y);
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  };

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of poly) {
    take(q.x, q.y);
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  for (let y = y0 + spacing / 2; y < y1; y += spacing) {
    for (let x = x0 + spacing / 2; x < x1; x += spacing) {
      if (pointInPolygon(poly, x, y)) take(x, y);
    }
  }
  if (count === 0) return { min: 0, max: 0, mean: 0 };
  return { min, max, mean: sum / count };
}

function pointInPolygon(poly: Polygon, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export { riverNearest, riverSample };
export type { River, TerraceLine, TerraceHit };
