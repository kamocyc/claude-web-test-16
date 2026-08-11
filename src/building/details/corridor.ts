import type { Vec2 } from '../../core/types.js';
import type { Rng } from '../../core/rng.js';
import * as V from '../../geom/vec2.js';
import type { GeometryBuffer } from '../../build/GeometryBuffer.js';
import type { BuildingMass, BuildingSpec, Footprint, Wall } from '../types.js';

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

export function buildCorridorAndStairs(
  bufs: CorridorBuffers,
  footprint: Footprint,
  mass: BuildingMass,
  spec: BuildingSpec,
  rng: Rng,
): void {
  const wall = footprint.walls.find((w) => w.isCorridorSide);
  if (!wall || wall.len < 4 || mass.floors.length < 2) return;

  const width = spec.corridorWidth;
  const isMansion = spec.kind === 'mansion';

  for (const floor of mass.floors) {
    if (floor.index === 0 && !isMansion) {
      // Ground-floor units open straight onto the site; only the slab edge above
      // is visible. Still draw the supporting posts.
      buildPosts(bufs.metal, wall, width, floor.y0, floor.y1);
      continue;
    }
    buildDeck(bufs, wall, width, floor.y0);
    buildRailing(bufs, wall, width, floor.y0, isMansion);
    if (floor.index > 0) buildPosts(bufs.metal, wall, width, 0, floor.y0);
  }

  buildStair(bufs, wall, width, mass, rng);
  buildAcUnits(bufs.metal, wall, width, mass, spec, rng);
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
function buildStair(
  bufs: CorridorBuffers,
  wall: Wall,
  width: number,
  mass: BuildingMass,
  rng: Rng,
): void {
  const floors = mass.floors.length;
  if (floors < 2) return;
  const m = bufs.metal;
  m.setColor({ r: 0.62, g: 0.63, b: 0.64 });

  const atEnd = rng.chance(0.5);
  const uBase = atEnd ? wall.len - 0.2 : 0.2;
  const outDir = wall.normal;
  const alongDir = atEnd ? V.neg(wall.dir) : wall.dir;
  const stairWidth = 0.95;

  for (let f = 1; f < floors; f++) {
    const y0 = mass.floors[f - 1]!.y0;
    const y1 = mass.floors[f]!.y0;
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
  wall: Wall,
  width: number,
  mass: BuildingMass,
  spec: BuildingSpec,
  rng: Rng,
): void {
  buf.setColor({ r: 0.84, g: 0.84, b: 0.82 });
  const count = Math.max(1, Math.floor(wall.len / spec.unitWidth));
  for (const floor of mass.floors) {
    for (let i = 0; i < count; i++) {
      if (!rng.chance(0.72)) continue;
      const u = (i + rng.range(0.55, 0.85)) * spec.unitWidth;
      if (u > wall.len - 0.5) continue;
      const p = V.addScaled(V.addScaled(wall.a, wall.dir, u), wall.normal, width - 0.32);
      buf.pushBox(p.x, floor.y0 + 0.3, p.y, 0.78, 0.58, 0.3);
    }
  }
}
