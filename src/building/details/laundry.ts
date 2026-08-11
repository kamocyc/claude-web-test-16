import type { Rng } from '../../core/rng.js';
import * as V from '../../geom/vec2.js';
import type { GeometryBuffer } from '../../build/GeometryBuffer.js';
import type { BuildingMass, BuildingSpec, Footprint } from '../types.js';

/**
 * 物干し — laundry poles and hanging washing on balconies.
 *
 * Two poles and a handful of coloured quads. It costs almost nothing and it is
 * the single clearest "lived in, and in Japan" signal on an apartment block.
 */

const CLOTHES = [
  { r: 0.86, g: 0.87, b: 0.9 },
  { r: 0.32, g: 0.42, b: 0.62 },
  { r: 0.82, g: 0.5, b: 0.42 },
  { r: 0.94, g: 0.92, b: 0.84 },
  { r: 0.4, g: 0.55, b: 0.45 },
  { r: 0.75, g: 0.7, b: 0.78 },
];

export function buildLaundry(
  buf: GeometryBuffer,
  footprint: Footprint,
  mass: BuildingMass,
  spec: BuildingSpec,
  rng: Rng,
): void {
  // Laundry goes on the sunny side, which is where the balconies are.
  const walls = footprint.walls.filter((w) => w.sunFacing && w.len > 3);
  if (walls.length === 0) return;

  for (const wall of walls) {
    const units = Math.max(1, Math.floor(wall.len / spec.unitWidth));
    for (const floor of mass.floors) {
      if (floor.index === 0 && spec.kind === 'mansion') continue;
      for (let i = 0; i < units; i++) {
        if (!rng.chance(0.45)) continue;
        const u0 = i * spec.unitWidth + 0.4;
        const u1 = Math.min(wall.len - 0.3, (i + 1) * spec.unitWidth - 0.4);
        if (u1 - u0 < 1.2) continue;

        const depth = spec.balconyDepth * 0.55;
        const y = floor.y0 + 1.55;
        const a = V.addScaled(V.addScaled(wall.a, wall.dir, u0), wall.normal, depth);
        const b = V.addScaled(V.addScaled(wall.a, wall.dir, u1), wall.normal, depth);

        // The pole itself.
        buf.setColor({ r: 0.72, g: 0.73, b: 0.74 });
        const mid = V.lerp(a, b, 0.5);
        buf.pushOrientedBox(mid.x, mid.y, wall.dir, 0.05, u1 - u0, y - 0.025, y + 0.025);

        // Hanging items: thin vertical quads under the pole.
        const items = 2 + rng.int(5);
        for (let k = 0; k < items; k++) {
          const t = (k + 0.5) / items;
          const p = V.lerp(a, b, t);
          const c = rng.pick(CLOTHES);
          buf.setColor(c);
          const w = rng.range(0.28, 0.5);
          const h = rng.range(0.5, 0.95);
          buf.pushOrientedBox(p.x, p.y, wall.dir, w, 0.03, y - h, y - 0.04);
        }
      }
    }
  }
}
