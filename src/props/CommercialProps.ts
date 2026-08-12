import type { Vec2 } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import type { Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { SIGN_FACE } from '../material/palettes.js';
import type { Lot } from '../city/Lots.js';
import type { BuiltBuilding } from '../building/Builder.js';
import type { BuildingSpec } from '../building/types.js';
import { PropRegistry } from './PropRegistry.js';

/**
 * The street furniture of a shopping street: 袖看板, のぼり, 自販機, bollards.
 *
 * This is where most of the *reading* of a 商店街 comes from, and the reason is
 * scale. The buildings behind it are barely different from houses — two storeys,
 * tiled roof, the same wall colours. What says "shops" is the clutter in front:
 * signs sticking out into the street at right angles so they can be read from
 * along it, banners at ankle height, and a vending machine glowing against a
 * wall. A shopping street with the clutter removed looks like a terrace.
 */

const rgb = (hex: number) => ({
  r: ((hex >> 16) & 255) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});

const POLE_GREY = { r: 0.66, g: 0.67, b: 0.68 };

export function buildCommercialProps(
  props: PropRegistry,
  lot: Lot,
  spec: BuildingSpec,
  built: BuiltBuilding,
  params: CityParams,
  rng: Rng,
): void {
  if (!params.props.signage) return;
  const front = lot.frontages[0];
  if (!front) return;

  if (spec.kind === 'shophouse') buildShopSigns(props, lot, spec, built, front, rng);
  if (spec.kind === 'zakkyo') buildTenantSigns(props, spec, built, front, rng);
}

/**
 * 袖看板 up the front wall, a couple of のぼり at the kerb, and sometimes a
 * vending machine tucked against the frontage.
 */
function buildShopSigns(
  props: PropRegistry,
  lot: Lot,
  spec: BuildingSpec,
  built: BuiltBuilding,
  front: Lot['frontages'][number],
  rng: Rng,
): void {
  const inward = V.neg(front.outward);
  // The wall the shopfront is on, so the sign projects from the building rather
  // than from a point in the air off its corner.
  const wall = built.mass.floors[0]?.walls.find((w) => V.dot(w.normal, front.outward) > 0.7);
  if (!wall) return;

  // One projecting sign, at first-floor level where it clears the awning.
  if (rng.chance(0.75)) {
    const u = wall.len * rng.range(0.15, 0.7);
    const base = V.addScaled(wall.a, wall.dir, u);
    const depth = rng.range(0.55, 0.95);
    const h = rng.range(0.9, 1.6);
    const y = rng.range(3.4, 4.4);
    props.add(
      'wallSign',
      V.addScaled(base, wall.normal, depth / 2 + 0.05),
      y,
      { w: 0.12, h, d: depth },
      wall.dir,
      rgb(rng.pick(SIGN_FACE)),
    );
  }

  // のぼり at the kerb. They come in twos and threes, all the same colour,
  // because a shop buys a set of them.
  if (rng.chance(0.45)) {
    const colour = rgb(rng.pick(SIGN_FACE));
    const n = 2 + rng.int(2);
    const t0 = rng.range(0.2, 0.6);
    for (let i = 0; i < n; i++) {
      const p = V.addScaled(V.lerp(front.a, front.b, t0 + i * 0.11), inward, rng.range(0.3, 0.7));
      props.add('signPole', p, 0.9, { w: 0.05, h: 1.8, d: 0.05 }, front.dir, POLE_GREY);
      props.add('bannerFlag', V.addScaled(p, front.dir, 0.28), 1.15, { w: 0.03, h: 1.35, d: 0.5 }, front.dir, colour);
    }
  }

  // 自販機 against the frontage. Two boxes: the body, and a glass front so it
  // catches the light the way the real ones do.
  if (rng.chance(0.3)) {
    const p = V.addScaled(V.lerp(front.a, front.b, rng.range(0.15, 0.85)), inward, 0.6);
    if (!insideFootprint(built, p)) {
      const colour = rgb(rng.pick(SIGN_FACE));
      props.add('vendingMachine', p, 0.9, { w: 1.05, h: 1.8, d: 0.75 }, front.outward, colour);
      props.add(
        'vendingFront',
        V.addScaled(p, front.outward, 0.34),
        1.05,
        { w: 0.72, h: 1.1, d: 0.06 },
        front.outward,
        { r: 0.8, g: 0.85, b: 0.9 },
      );
    }
  }
  void lot;
  void spec;
}

/** A 雑居ビル carries a sign per tenant, stacked up the corner of the front wall. */
function buildTenantSigns(
  props: PropRegistry,
  spec: BuildingSpec,
  built: BuiltBuilding,
  front: Lot['frontages'][number],
  rng: Rng,
): void {
  const wall = built.mass.floors[0]?.walls.find((w) => V.dot(w.normal, front.outward) > 0.7);
  if (!wall || wall.len < 3) return;

  // Stacked at one end of the frontage — which is where they go, because the
  // stack has to clear the tenant windows.
  const u = rng.chance(0.5) ? 0.6 : wall.len - 0.6;
  const base = V.addScaled(wall.a, wall.dir, u);
  const depth = rng.range(0.7, 1.1);
  const floors = built.mass.stacks[0]?.floors ?? 1;
  for (let f = 1; f < floors; f++) {
    if (rng.chance(0.2)) continue; // an empty unit, or one that never put a sign up
    const y = f * spec.floorHeight + spec.floorHeight * 0.5;
    props.add(
      'wallSign',
      V.addScaled(base, wall.normal, depth / 2 + 0.05),
      y,
      { w: 0.1, h: spec.floorHeight * 0.55, d: depth },
      wall.dir,
      rgb(rng.pick(SIGN_FACE)),
    );
  }
}

/** Keep a prop out of the building it is supposed to be standing beside. */
function insideFootprint(built: BuiltBuilding, p: Vec2): boolean {
  const poly = built.footprint.outline;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
