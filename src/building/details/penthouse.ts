import type { Polygon } from '../../core/types.js';
import type { Rng } from '../../core/rng.js';
import { centroid } from '../../geom/polygon.js';
import { offsetInward } from '../../geom/offset.js';
import * as V from '../../geom/vec2.js';
import type { GeometryBuffer } from '../../build/GeometryBuffer.js';
import type { BuildingSpec } from '../types.js';

/**
 * Rooftop plant: 塔屋 (lift and stair overrun), plant boxes, an antenna, and on
 * older buildings a 高置水槽 on its steel frame.
 *
 * The penthouse-plus-water-tank silhouette is the strongest マンション signal at
 * distance — it is what separates a mid-rise apartment block from an office
 * building at 200 m.
 */

export interface PenthouseBuffers {
  wall: GeometryBuffer;
  metal: GeometryBuffer;
}

export function buildRooftopPlant(
  bufs: PenthouseBuffers,
  roofPoly: Polygon,
  roofY: number,
  spec: BuildingSpec,
  rng: Rng,
): void {
  // Everything sits inside the parapet.
  const inner = offsetInward(roofPoly, 1.4)[0];
  if (!inner || inner.length < 3) return;
  const c = centroid(inner);

  const w = bufs.wall;
  w.setColor({ r: 0.8, g: 0.79, b: 0.76 });

  // 塔屋: the lift machine room, offset toward one side rather than centred.
  const dir = V.fromAngle(rng.range(0, Math.PI * 2));
  const phCenter = V.addScaled(c, dir, rng.range(0, 2.5));
  const phW = rng.range(3.2, 4.6);
  const phD = rng.range(2.8, 4.0);
  const phH = 2.8;
  w.pushBox(phCenter.x, roofY + phH / 2, phCenter.y, phW, phH, phD);
  // Coping band on top.
  w.pushBox(phCenter.x, roofY + phH + 0.08, phCenter.y, phW + 0.2, 0.16, phD + 0.2);

  // Stair overrun, a smaller box alongside.
  const stairPos = V.addScaled(phCenter, V.perp(dir), rng.range(3.0, 4.5));
  w.pushBox(stairPos.x, roofY + 1.3, stairPos.y, 2.4, 2.6, 2.2);

  const m = bufs.metal;

  // 高置水槽 — a rooftop water tank on a steel frame. Only on older buildings;
  // newer ones use direct pressurised supply.
  if (spec.hasWaterTank) {
    const tankPos = V.addScaled(c, V.neg(dir), rng.range(2.5, 4.5));
    const legH = 2.2;
    m.setColor({ r: 0.55, g: 0.56, b: 0.58 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      m.pushBox(tankPos.x + sx * 1.2, roofY + legH / 2, tankPos.y + sz * 0.9, 0.12, legH, 0.12);
    }
    // Cross bracing.
    m.pushBox(tankPos.x, roofY + legH * 0.55, tankPos.y - 0.9, 2.5, 0.08, 0.08);
    m.pushBox(tankPos.x, roofY + legH * 0.55, tankPos.y + 0.9, 2.5, 0.08, 0.08);
    m.setColor({ r: 0.88, g: 0.88, b: 0.85 });
    m.pushBox(tankPos.x, roofY + legH + 0.8, tankPos.y, 2.8, 1.6, 2.0);
  }

  // Plant boxes: rooftop AC condensers and pump housings.
  m.setColor({ r: 0.8, g: 0.8, b: 0.78 });
  const boxes = 2 + rng.int(3);
  for (let i = 0; i < boxes; i++) {
    const p = V.addScaled(c, V.fromAngle(rng.range(0, Math.PI * 2)), rng.range(1.5, 5));
    m.pushBox(p.x, roofY + 0.4, p.y, rng.range(0.8, 1.4), 0.8, rng.range(0.5, 0.9));
  }

  // A whip antenna.
  m.setColor({ r: 0.5, g: 0.5, b: 0.52 });
  const ap = V.addScaled(phCenter, dir, phW * 0.5 + 0.4);
  m.pushBox(ap.x, roofY + 2.4, ap.y, 0.05, 4.8, 0.05);
}
