import type { Vec2 } from '../../core/types.js';
import type { Rng } from '../../core/rng.js';
import * as V from '../../geom/vec2.js';
import type { GeometryBuffer } from '../../build/GeometryBuffer.js';
import { KIND_RULES } from '../kinds.js';
import type { BuildingMass, BuildingSpec, Floor, Wall } from '../types.js';

/**
 * 外廊下 and 外階段 — the exterior access corridor and open staircase.
 *
 * This is what makes a small building read as an *アパート* rather than as a
 * generic box. A two-storey walk-up with a cantilevered north-side corridor, a
 * steel railing, an open stair at one end and a run of coloured unit doors is
 * instantly recognisable, and nothing else in the building says it as clearly.
 */

export interface CorridorBuffers {
  wall: GeometryBuffer;
  metal: GeometryBuffer;
  accent: GeometryBuffer;
  glass: GeometryBuffer;
}

interface CorridorRun {
  wall: Wall;
  floor: Floor;
}

/** Rounded midpoint plus normal — "the same wall, one floor up". */
function wallKey(w: Wall): string {
  const mid = V.lerp(w.a, w.b, 0.5);
  return `${Math.round(mid.x)},${Math.round(mid.y)},${Math.round(w.normal.x * 4)},${Math.round(w.normal.y * 4)}`;
}

export function buildCorridorAndStairs(
  bufs: CorridorBuffers,
  mass: BuildingMass,
  spec: BuildingSpec,
  rng: Rng,
): void {
  // Per floor, not per base wall. Below a 斜線 step that is the base wall; above
  // it, it is the set-back wall — so the deck steps back with the building and
  // lands on the terrace, which is how a stepped アパート actually works.
  const runs: CorridorRun[] = [];
  for (const floor of mass.floors) {
    const w = floor.walls.find((x) => x.isCorridorSide);
    if (w && w.len >= 4) runs.push({ wall: w, floor });
  }
  if (runs.length < 2) return;

  // The deck has to fit between the wall and the lot boundary. At full width it
  // was crossing a 0.5 m side setback by over a metre and interpenetrating the
  // neighbouring building. The stair adds a little more, so leave room for it.
  const room = Math.min(...runs.map((r) => r.wall.room));
  const width = Math.min(spec.corridorWidth, room - 0.15);
  if (width < 0.9) return;
  const isMansion = KIND_RULES[spec.kind].corridor === 'mansion';

  // One post run per contiguous corridor wall, from grade to the topmost deck it
  // carries. The old code drew [0, h] at floor 1 and again at floor 2 over
  // [0, 2h], nesting duplicate boxes inside each other — three copies on a
  // three-storey block.
  const groups = new Map<string, CorridorRun[]>();
  for (const r of runs) {
    const k = wallKey(r.wall);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  for (const group of groups.values()) {
    const top = group[group.length - 1]!;
    buildPosts(bufs.metal, group[0]!.wall, width, 0, top.floor.y0);
  }

  for (const { wall, floor } of runs) {
    // Ground-floor units open straight onto the site.
    if (floor.index === 0 && !isMansion) continue;
    buildDeck(bufs, wall, width, floor.y0);
    buildRailing(bufs, wall, width, floor.y0, isMansion);
  }

  buildStair(bufs, runs, width, rng);
  buildAcUnits(bufs.metal, runs, width, spec, rng);
}

/** Corners of the corridor deck along a wall, offset outward. */
function deckQuad(wall: Wall, width: number, inset = 0): Vec2[] {
  const a = V.addScaled(wall.a, wall.dir, inset);
  const b = V.addScaled(wall.b, wall.dir, -inset);
  return [a, b, V.addScaled(b, wall.normal, width), V.addScaled(a, wall.normal, width)];
}

function buildDeck(bufs: CorridorBuffers, wall: Wall, width: number, y: number): void {
  const w = bufs.wall;
  w.setColor({ r: 0.76, g: 0.75, b: 0.72 });
  w.pushPrism(deckQuad(wall, width), y - 0.18, y + 0.02, true, true);
}

/** Steel balusters for アパート, a concrete upstand for マンション. */
function buildRailing(
  bufs: CorridorBuffers,
  wall: Wall,
  width: number,
  y: number,
  solid: boolean,
): void {
  const outer0 = V.addScaled(wall.a, wall.normal, width);
  const outer1 = V.addScaled(wall.b, wall.normal, width);
  const railH = 1.15;

  if (solid) {
    const w = bufs.wall;
    w.setColor({ r: 0.78, g: 0.77, b: 0.74 });
    const t = 0.14;
    const n = wall.normal;
    w.pushPrism(
      [
        V.addScaled(outer0, n, -t),
        V.addScaled(outer1, n, -t),
        V.addScaled(outer1, n, 0),
        V.addScaled(outer0, n, 0),
      ],
      y,
      y + railH,
      true,
      false,
    );
    return;
  }

  const m = bufs.metal;
  m.setColor({ r: 0.66, g: 0.67, b: 0.68 });
  // Top and bottom rails.
  for (const h of [y + railH - 0.05, y + 0.12]) {
    m.pushPrism(
      [
        V.addScaled(outer0, wall.normal, -0.03),
        V.addScaled(outer1, wall.normal, -0.03),
        V.addScaled(outer1, wall.normal, 0.03),
        V.addScaled(outer0, wall.normal, 0.03),
      ],
      h - 0.03,
      h + 0.03,
      true,
      true,
    );
  }
  // 100 mm-square balusters.
  const count = Math.max(2, Math.floor(wall.len / 0.42));
  for (let i = 1; i < count; i++) {
    const p = V.lerp(outer0, outer1, i / count);
    m.pushBox(p.x, y + railH / 2, p.y, 0.035, railH, 0.035);
  }
}

/** 120 mm posts every 2.7 m, holding the deck up. */
function buildPosts(
  buf: GeometryBuffer,
  wall: Wall,
  width: number,
  y0: number,
  y1: number,
): void {
  if (y1 - y0 < 0.4) return;
  buf.setColor({ r: 0.7, g: 0.69, b: 0.66 });
  const count = Math.max(2, Math.round(wall.len / 2.7));
  for (let i = 0; i <= count; i++) {
    const t = (wall.len * i) / count;
    const p = V.addScaled(V.addScaled(wall.a, wall.dir, t), wall.normal, width - 0.12);
    buf.pushBox(p.x, (y0 + y1) / 2, p.y, 0.12, y1 - y0, 0.12);
  }
}

/** An open steel stair at one end of the corridor, with a half landing. */
function buildStair(bufs: CorridorBuffers, runs: CorridorRun[], width: number, rng: Rng): void {
  if (runs.length < 2) return;
  const m = bufs.metal;
  m.setColor({ r: 0.62, g: 0.63, b: 0.64 });

  const atEnd = rng.chance(0.5);
  const stairWidth = 0.95;

  for (let f = 1; f < runs.length; f++) {
    const prev = runs[f - 1]!;
    const next = runs[f]!;
    // A flight cannot span a step-back; the decks are on different walls.
    if (wallKey(prev.wall) !== wallKey(next.wall)) continue;
    const wall = prev.wall;
    const uBase = atEnd ? wall.len - 0.2 : 0.2;
    const outDir = wall.normal;
    const alongDir = atEnd ? V.neg(wall.dir) : wall.dir;
    const y0 = prev.floor.y0;
    const y1 = next.floor.y0;
    const rise = y1 - y0;
    const steps = Math.max(8, Math.round(rise / 0.19));
    const run = 0.26;
    const totalRun = steps * run;

    // The flight runs outward from the deck edge, parallel to the wall.
    const start = V.addScaled(
      V.addScaled(wall.a, wall.dir, uBase),
      outDir,
      width + 0.1,
    );
    for (let s = 0; s < steps; s++) {
      const p = V.addScaled(start, alongDir, (s + 0.5) * run);
      const y = y0 + ((s + 1) / steps) * rise;
      m.pushBox(p.x, y - 0.03, p.y, stairWidth, 0.05, run);
    }
    // Stringer and outer railing.
    const mid = V.addScaled(start, alongDir, totalRun / 2);
    const sideOffset = V.scale(V.perp(alongDir), stairWidth / 2);
    for (const sign of [-1, 1]) {
      const sp = V.addScaled(mid, sideOffset, sign);
      m.pushBox(sp.x, y0 + rise / 2 - 0.16, sp.y, 0.06, 0.22, totalRun);
      // A railing bar sloping with the flight, approximated in three segments.
      for (let k = 0; k < 3; k++) {
        const t = (k + 0.5) / 3;
        const p = V.addScaled(start, alongDir, totalRun * t);
        const q = V.addScaled(p, sideOffset, sign);
        m.pushBox(q.x, y0 + rise * t + 0.55, q.y, 0.05, 1.0, totalRun / 3);
      }
    }
    // Landing at the top of the flight, connecting back to the deck.
    const landing = V.addScaled(start, alongDir, totalRun);
    m.pushBox(landing.x, y1 - 0.09, landing.y, stairWidth + 0.3, 0.16, 1.0);
  }
}

/** Outdoor air-conditioner units on the corridor deck, one per unit door. */
function buildAcUnits(
  buf: GeometryBuffer,
  runs: CorridorRun[],
  width: number,
  spec: BuildingSpec,
  rng: Rng,
): void {
  buf.setColor({ r: 0.84, g: 0.84, b: 0.82 });
  for (const { wall, floor } of runs) {
    const count = Math.max(1, Math.floor(wall.len / spec.unitWidth));
    for (let i = 0; i < count; i++) {
      if (!rng.chance(0.72)) continue;
      const u = (i + rng.range(0.55, 0.85)) * spec.unitWidth;
      if (u > wall.len - 0.5) continue;
      const p = V.addScaled(V.addScaled(wall.a, wall.dir, u), wall.normal, width - 0.32);
      buf.pushOrientedBox(p.x, p.y, wall.dir, 0.78, 0.3, floor.y0 + 0.01, floor.y0 + 0.59);
    }
  }
}
