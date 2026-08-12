import type { Polygon, Vec2 } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import type { Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { area } from '../geom/polygon.js';
import { offsetInward } from '../geom/offset.js';
import type { Lot } from '../city/Lots.js';
import type { BuiltBuilding } from '../building/Builder.js';
import type { BuildingSpec } from '../building/types.js';
import { PropRegistry } from './PropRegistry.js';

/**
 * What stands in the yard: lorries, containers, stacked pallets, dock bumpers.
 *
 * An industrial estate is mostly *ground*. The sheds cover a little over half
 * their plots and the rest is hardstanding, so a yard with nothing on it reads
 * as an unfinished model — the buildings are plausible and the space between
 * them is conspicuously empty. A handful of large objects at truck scale is what
 * fills it, and it costs almost nothing: they are instanced boxes.
 */

const CAB_COLOURS = [0xe8e6e0, 0x2f4a70, 0x8d3a34, 0x3d5a45, 0x4a4d52] as const;
const CONTAINER_COLOURS = [0x8a4034, 0x2c5a7a, 0x3f6b4a, 0x9c8a4a, 0x6b6f74] as const;

const rgb = (hex: number) => ({
  r: ((hex >> 16) & 255) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});

export function buildIndustrialProps(
  props: PropRegistry,
  lot: Lot,
  spec: BuildingSpec,
  built: BuiltBuilding,
  params: CityParams,
  rng: Rng,
): void {
  if (!params.props.signage) return;

  const front = lot.frontages[0];
  if (front) buildDockBumpers(props, built, front);

  // Anything left of the plot once the shed and a working margin are taken out.
  const yard = offsetInward(lot.polygon, 2.0)[0];
  if (!yard || area(yard) < 60) return;

  const blocked = built.footprint.outline;
  // Lorries park square to the building, not at whatever angle a random draw
  // gives — a yard of scattered diagonal trucks looks like a scrapyard.
  const dir = built.mass.floors[0]?.walls[0]?.dir ?? { x: 1, y: 0 };

  const budget = spec.kind === 'warehouse' ? 2 + rng.int(4) : 1 + rng.int(3);
  for (let placed = 0, tries = 0; placed < budget && tries < budget * 8; tries++) {
    const p = samplePoint(yard, rng);
    if (!p || inside(blocked, p) || nearEdge(built.footprint.outline, p, 3.0)) continue;

    const roll = rng.next();
    if (roll < 0.45) {
      // A rigid lorry: box body plus a cab, both squared to the shed.
      const colour = rgb(rng.pick(CAB_COLOURS));
      props.add('truckBody', p, 1.9, { w: 2.5, h: 2.8, d: 7.2 }, dir, { r: 0.9, g: 0.9, b: 0.89 });
      props.add('truckCab', V.addScaled(p, dir, 4.6), 1.6, { w: 2.4, h: 2.4, d: 2.2 }, dir, colour);
    } else if (roll < 0.75) {
      props.add(
        'containerBox',
        p,
        1.3,
        { w: 2.44, h: 2.6, d: rng.chance(0.5) ? 6.1 : 12.2 },
        dir,
        rgb(rng.pick(CONTAINER_COLOURS)),
      );
    } else {
      // Pallets, stacked. Shorter and wider than a container, and pale.
      const h = rng.range(1.0, 1.9);
      props.add('palletStack', p, h / 2, { w: rng.range(1.6, 2.6), h, d: rng.range(1.8, 3.2) }, dir, {
        r: 0.72,
        g: 0.67,
        b: 0.56,
      });
    }
    placed++;
  }
}

/** Rubber bumpers either side of each dock door, at lorry-bed height. */
function buildDockBumpers(
  props: PropRegistry,
  built: BuiltBuilding,
  front: Lot['frontages'][number],
): void {
  const wall = built.mass.floors[0]?.walls.find((w) => V.dot(w.normal, front.outward) > 0.7);
  if (!wall || wall.len < 6) return;
  const dark = { r: 0.16, g: 0.16, b: 0.17 };
  // Spaced on the structural bay rather than found from the façade: the bays are
  // built in `facade.ts` and never leave it, and threading them out to here
  // would couple the props to the grammar for two boxes apiece.
  const step = 6.0;
  for (let u = step; u < wall.len - 1; u += step) {
    for (const d of [-0.6, 0.6]) {
      const p = V.addScaled(V.addScaled(wall.a, wall.dir, u + d), wall.normal, 0.08);
      props.add('dockBumper', p, 1.05, { w: 0.22, h: 0.5, d: 0.3 }, wall.dir, dark);
    }
  }
}

function samplePoint(poly: Polygon, rng: Rng): Vec2 | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  for (let i = 0; i < 12; i++) {
    const p = { x: rng.range(minX, maxX), y: rng.range(minY, maxY) };
    if (inside(poly, p)) return p;
  }
  return null;
}

function nearEdge(poly: Polygon, p: Vec2, d: number): boolean {
  for (let i = 0, n = poly.length; i < n; i++) {
    if (V.distToSegment(p, poly[i]!, poly[(i + 1) % n]!) < d) return true;
  }
  return false;
}

function inside(poly: Polygon, p: Vec2): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
