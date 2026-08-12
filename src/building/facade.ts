import type { Vec2 } from '../core/types.js';
import type { BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { groundGrime } from '../material/palettes.js';
import type { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { BuildingKind, BuildingSpec, Floor, Wall } from './types.js';
import { KIND_RULES } from './kinds.js';

/**
 * Façade generation as a one-dimensional split grammar per wall, per floor.
 *
 * Two rules carry most of the realism:
 *
 * - **Everything snaps to the 910 mm half-ken module.** Japanese buildings are
 *   dimensioned on it, and openings that ignore it read as subtly wrong.
 * - **Upper-floor bays align with the floor below**, most of the time.
 *   Misaligned windows are the single clearest tell of a naive procedural
 *   façade.
 */

export type BayKind =
  | 'window'
  | 'windowSmall'
  | 'door'
  | 'garage'
  | 'balcony'
  | 'blank'
  | 'unitDoor'
  // --- Commercial and industrial -------------------------------------------
  /** Full-height glazing with mullions: a shop window. */
  | 'shopfront'
  /** A closed rolling shutter, over a shopfront or a loading bay. */
  | 'shutter'
  /** A tenant's strip window, merging into a ribbon along the floor. */
  | 'tenantWindow'
  /** The street door to the tenant stair. */
  | 'tenantDoor'
  /** A truck-height roller door. */
  | 'dockDoor'
  /** A run of high-level ventilation louvres. */
  | 'louvre'
  /**
   * Wall that is deliberately blank, as opposed to `blank`, which merely means
   * "nothing was placed here". A 長屋's party wall and a warehouse's flank are
   * blank on purpose and must not be filled in with windows.
   */
  | 'blankPanel';

export interface Bay {
  kind: BayKind;
  /** Distance along the wall, metres. */
  u0: number;
  u1: number;
}

/** Below this a balcony is not worth building; the wall gets windows instead. */
export const MIN_BALCONY_DEPTH = 0.75;

export interface FacadeBuffers {
  wall: GeometryBuffer;
  glass: GeometryBuffer;
  metal: GeometryBuffer;
  accent: GeometryBuffer;
  /** Rolling shutters — their own family, because the slats are a texture. */
  shutter: GeometryBuffer;
}

export function buildFacades(
  bufs: FacadeBuffers,
  floors: Floor[],
  spec: BuildingSpec,
  params: BuildingParams,
  seed: string,
): void {
  const module = params.module;

  // Slot patterns from the floor below, keyed by wall position. Upper-floor
  // openings snap to them most of the time: windows that do not line up
  // vertically are the single clearest tell of a naive procedural façade.
  let previous = new Map<string, BayKind[]>();

  for (const floor of floors) {
    // Cached on the floor by `buildMass`, so every detail builder sees the same
    // per-level wall set and follows a 斜線 step-back identically.
    const walls = floor.walls;
    const current = new Map<string, BayKind[]>();

    for (let w = 0; w < walls.length; w++) {
      const wall = walls[w]!;
      // The entrance wall is exempt: a door is 910 mm wide and a wall that short
      // still has to carry one, whereas an ordinary wall that short is a chamfer.
      if (wall.len < module * 1.2 && !(wall.isEntrance && floor.index === 0)) {
        plainWall(bufs.wall, wall, floor, spec);
        continue;
      }
      const rng = makeRng(subSeed(seed, 'facade', floor.index, w));
      const key = wallKey(wall);
      const kinds = layoutWall(wall, floor, spec, params, rng, previous.get(key));
      current.set(key, kinds);
      buildWallGeometry(bufs, wall, floor, baysFromKinds(kinds, module), spec, params, rng);
    }
    previous = current;
  }
}

/**
 * A position-based key so an upper floor can find the wall directly below it
 * even when the slant planes have changed the vertex order.
 */
function wallKey(wall: Wall): string {
  const mid = V.lerp(wall.a, wall.b, 0.5);
  return `${Math.round(mid.x)},${Math.round(mid.y)},${Math.round(wall.normal.x * 4)},${Math.round(wall.normal.y * 4)}`;
}

/** Merge a slot array into contiguous bays. */
function baysFromKinds(kinds: BayKind[], module: number): Bay[] {
  const margin = module * 0.6;
  const bays: Bay[] = [];
  let i = 0;
  while (i < kinds.length) {
    const kind = kinds[i]!;
    let j = i + 1;
    // Windows stay one slot wide; everything else merges into a run. A tenant
    // strip window is *meant* to merge — the ribbon along a floor is the whole
    // look of a 雑居ビル — so it is not on the exception list.
    while (j < kinds.length && kinds[j] === kind && kind !== 'window' && kind !== 'windowSmall') j++;
    bays.push({ kind, u0: margin + i * module, u1: margin + j * module });
    i = j;
  }
  return bays;
}

/** Everything a per-use wall layout gets to work with. */
interface LayoutCtx {
  wall: Wall;
  floor: Floor;
  spec: BuildingSpec;
  params: BuildingParams;
  rng: Rng;
  slots: number;
  ground: boolean;
  /** This wall carries the front door, and this is the ground floor. */
  entrance: boolean;
  kinds: BayKind[];
  place(start: number, count: number, kind: BayKind): boolean;
}

/**
 * A wall layout fills `ctx.kinds`, and says whether the generic window fill
 * should run afterwards.
 *
 * Most uses want it — leaving a wall to the fill is how the north and rear
 * elevations get their sparse scattering. A shopfront, a loading bay and a party
 * wall do not: their blankness is a decision, not an absence.
 */
type WallLayout = (ctx: LayoutCtx) => { fillWindows: boolean };

/** 戸建: a front door, maybe a garage, and a balcony on the sunny side. */
const houseWallLayout: WallLayout = (ctx) => {
  const { wall, spec, rng, slots, ground, entrance, place } = ctx;
  if (entrance) {
    // Never centre the entrance: 20–38% or 62–80% along the wall.
    const t = rng.chance(0.5) ? rng.range(0.2, 0.38) : rng.range(0.62, 0.8);
    place(Math.min(slots - 1, Math.floor(t * slots)), 1, 'door');
    if (spec.wantsCarPad && slots >= 5 && rng.chance(0.35)) {
      // Draw the coin either way so the seed stream does not shift, then use
      // it only when there is no pad to aim at.
      const coin = rng.chance(0.5);
      const pad = spec.carPadAt;
      const nearA = pad ? V.dist(wall.a, pad) < V.dist(wall.b, pad) : coin;
      place(nearA ? 0 : slots - 3, 3, 'garage');
    }
  }
  // A balcony needs somewhere to project. On a tight side boundary there is
  // none, and the wall gets ordinary windows instead — which is exactly what
  // a real house on a narrow lot does.
  if (!ground && wall.sunFacing && slots >= 4 && wall.room >= MIN_BALCONY_DEPTH) {
    const span = Math.min(slots - 1, 3 + rng.int(2));
    place(Math.max(0, Math.floor((slots - span) * rng.range(0.15, 0.85))), span, 'balcony');
  }
  return { fillWindows: true };
};

/** アパート・マンション: a unit rhythm of doors on the deck, balconies on the sun. */
const unitWallLayout: WallLayout = (ctx) => {
  const { wall, spec, params, rng, slots, entrance, place } = ctx;
  const unitSlots = Math.max(2, Math.round(spec.unitWidth / params.module));
  if (wall.isCorridorSide) {
    for (let u = 0; u + unitSlots <= slots; u += unitSlots) {
      place(u, 1, 'unitDoor');
      if (unitSlots >= 3) place(u + unitSlots - 2, 1, 'windowSmall');
    }
  } else if ((wall.sunFacing || wall.role === 'front') && wall.room >= MIN_BALCONY_DEPTH) {
    const balconySlots = Math.max(2, unitSlots - 1);
    for (let u = 0; u + unitSlots <= slots; u += unitSlots) {
      place(u, balconySlots, 'balcony');
    }
  }
  if (entrance && spec.kind === 'mansion') {
    place(Math.floor(slots * rng.range(0.25, 0.6)), Math.min(3, slots), 'door');
  }
  return { fillWindows: true };
};

/**
 * 店舗併用住宅.
 *
 * The ground floor is a shop and the floors above are a house — so the floors
 * above literally *are* the house layout, called here rather than restated. A
 * 長屋's upper elevation is a house elevation; saying so in the code is both
 * shorter and truer than a second copy that drifts.
 *
 * The side walls are the party walls. They get `blankPanel` rather than being
 * left to the window fill, because a wall built hard against the neighbour's
 * cannot have a window in it.
 */
const shophouseWallLayout: WallLayout = (ctx) => {
  const { wall, rng, slots, ground, place } = ctx;
  if (!ground) return houseWallLayout(ctx);

  const shopFront = wall.role === 'front' || ctx.entrance;
  if (!shopFront) {
    for (let i = 0; i < slots; i++) place(i, 1, 'blankPanel');
    return { fillWindows: false };
  }

  // One shop in four is shut. Free, and very much what a real 商店街 looks like
  // — a run of open frontages with a closed shutter or two among them is the
  // single clearest signal that these are shops and not flats.
  const shuttered = rng.chance(0.25);
  // The 通り土間 — the separate street door to the flat upstairs. It takes the
  // end slot, so the shop window is the rest of the frontage.
  const doorAtStart = rng.chance(0.5);
  const doorSlot = doorAtStart ? 0 : slots - 1;
  if (slots >= 3) place(doorSlot, 1, 'door');

  for (let i = 0; i < slots; i++) place(i, 1, shuttered ? 'shutter' : 'shopfront');
  return { fillWindows: false };
};

/**
 * 雑居ビル — a stack of tenants, one per floor.
 *
 * What makes one read as a multi-tenant block rather than a small office is the
 * *ribbon*: a continuous strip window across each floor, unbroken by piers,
 * because the floor plate is let as one space and nobody put a wall in it. The
 * ground floor is different — a shop or two, the door to the stair, and the
 * shutter of whatever occupies the back.
 */
const zakkyoWallLayout: WallLayout = (ctx) => {
  const { wall, spec, params, rng, slots, ground, place } = ctx;
  const street = wall.role === 'front' || wall.isEntrance || wall.sunFacing;

  if (!street) {
    // The flank of a 雑居ビル is almost blank: a service window here and there,
    // and otherwise the neighbour's wall a metre away.
    for (let i = 0; i < slots; i++) {
      place(i, 1, rng.chance(0.12) ? 'windowSmall' : 'blankPanel');
    }
    return { fillWindows: false };
  }

  if (ground) {
    // The stair door takes one slot at an end; a shop takes the frontage beside
    // it; anything left over at the far end is back-of-house behind a shutter.
    const doorAtStart = rng.chance(0.5);
    place(doorAtStart ? 0 : slots - 1, 1, 'tenantDoor');
    const shopSpan = Math.max(1, Math.floor(slots * rng.range(0.5, 0.85)));
    const shopStart = doorAtStart ? 1 : 0;
    for (let i = shopStart; i < Math.min(slots, shopStart + shopSpan); i++) place(i, 1, 'shopfront');
    for (let i = 0; i < slots; i++) place(i, 1, 'shutter');
    return { fillWindows: false };
  }

  // Upper floors: the ribbon, with a pier between tenant bays.
  const unitSlots = Math.max(3, Math.round(spec.unitWidth / params.module));
  for (let u = 0; u < slots; u += unitSlots) {
    const span = Math.min(unitSlots - 1, slots - u);
    if (span < 1) break;
    for (let i = u; i < u + span; i++) place(i, 1, 'tenantWindow');
  }
  for (let i = 0; i < slots; i++) place(i, 1, 'blankPanel');
  return { fillWindows: false };
};

/**
 * コンビニ — glass on the two sides that face the car park, blank behind.
 *
 * A convenience store is a single room with two glazed elevations and two solid
 * ones, and the solid pair is where the chillers stand. Getting that asymmetry
 * right matters more than any detail on the glazed side: a box glazed all round
 * reads as a bus shelter.
 */
const konbiniWallLayout: WallLayout = (ctx) => {
  const { wall, slots, place } = ctx;
  const glazed = wall.role === 'front' || wall.isEntrance;
  for (let i = 0; i < slots; i++) place(i, 1, glazed ? 'shopfront' : 'blankPanel');
  return { fillWindows: false };
};

/**
 * 工場・倉庫 — dock doors on the yard, louvres high up, blank everywhere else.
 *
 * The storey here is one floor and the height of three, so every vertical
 * dimension is absolute rather than a fraction of the wall. That distinction is
 * the whole trap in this layout: `yTop - 0.42` is a window head on a house and
 * five metres in the air on a shed.
 *
 * Blankness is the default and is stated, not left to the window fill. A
 * warehouse flank has nothing on it, and a scattering of domestic windows across
 * forty metres of cladding is the single thing that would stop it reading as a
 * warehouse.
 */
const industrialWallLayout: WallLayout = (ctx) => {
  const { wall, spec, params, rng, slots, place } = ctx;
  const yard = wall.role === 'front' || wall.isEntrance;
  const bay = Math.max(4, Math.round(spec.unitWidth / params.module));

  if (yard && slots >= 6) {
    // Truck doors, on the structural bay. Two or three is a loading dock; a row
    // of ten is a distribution centre, which this is not.
    const doorSlots = Math.max(3, Math.round(4.0 / params.module));
    let placed = 0;
    const wanted = 1 + rng.int(3);
    for (let u = 1; u + doorSlots <= slots - 1 && placed < wanted; u += doorSlots + 2) {
      if (place(u, doorSlots, 'dockDoor')) placed++;
    }
  }

  // A ventilation louvre in each remaining structural bay.
  for (let u = 0; u + 2 <= slots; u += bay) place(u, 2, 'louvre');
  for (let i = 0; i < slots; i++) place(i, 1, 'blankPanel');
  return { fillWindows: false };
};

const LAYOUTS: Record<BuildingKind, WallLayout> = {
  house: houseWallLayout,
  apart: unitWallLayout,
  mansion: unitWallLayout,
  shophouse: shophouseWallLayout,
  zakkyo: zakkyoWallLayout,
  konbini: konbiniWallLayout,
  factory: industrialWallLayout,
  warehouse: industrialWallLayout,
};

function layoutWall(
  wall: Wall,
  floor: Floor,
  spec: BuildingSpec,
  params: BuildingParams,
  rng: Rng,
  below: BayKind[] | undefined,
): BayKind[] {
  const module = params.module;
  // Reserve a corner return at each end — openings never run into a corner.
  // The entrance wall gives up as much of that return as it needs to hold a
  // single door, because the alternative is a house you cannot get into.
  const entrance = wall.isEntrance && floor.index === 0;
  let margin = module * 0.6;
  let slots = Math.floor((wall.len - margin * 2) / module);
  // The entrance wall gives up as much of that return as it needs to hold a
  // single door, because the alternative is a house you cannot get into. Only
  // this wall, and only when it would otherwise get nothing, so every other
  // façade in the town is laid out exactly as before.
  if (entrance && slots < 1 && wall.len >= module) {
    slots = 1;
    margin = (wall.len - module) / 2;
  }
  if (slots < 1) return [];

  const kinds: BayKind[] = new Array(slots).fill('blank');
  const ground = floor.index === 0;

  const place = (start: number, count: number, kind: BayKind): boolean => {
    if (start < 0 || start + count > slots) return false;
    for (let i = start; i < start + count; i++) if (kinds[i] !== 'blank') return false;
    for (let i = start; i < start + count; i++) kinds[i] = kind;
    return true;
  };

  const { fillWindows } = LAYOUTS[spec.kind]({
    wall,
    floor,
    spec,
    params,
    rng,
    slots,
    ground,
    entrance,
    kinds,
    place,
  });

  if (fillWindows) {
    // Inherit the pattern from the floor below wherever that floor had an
    // opening, so windows stack vertically. This is the highest-value rule in the
    // whole grammar — misaligned openings read as wrong immediately, even to
    // someone who could not say why.
    if (below) {
      for (let i = 0; i < Math.min(slots, below.length); i++) {
        if (kinds[i] !== 'blank') continue;
        const under = below[i]!;
        if (under === 'blank') continue;
        if (!rng.chance(params.bayAlignChance)) continue;
        // A door or garage below becomes an ordinary window above. So does a
        // shopfront: the flat over a shop has a window where the shop has glass.
        kinds[i] =
          under === 'door' || under === 'garage' || under === 'unitDoor' ||
          under === 'shopfront' || under === 'shutter' || under === 'blankPanel'
            ? 'window'
            : under;
      }
    }

    // Fill the rest with windows, at a probability that depends on which way the
    // wall faces. North and rear elevations really are much blanker in Japan.
    const p =
      wall.role === 'front'
        ? wall.sunFacing
          ? 0.75
          : 0.55
        : wall.sunFacing
          ? 0.6
          : wall.role === 'rear'
            ? 0.22
            : 0.3;
    for (let i = 0; i < slots; i++) {
      if (kinds[i] !== 'blank') continue;
      // A slot the floor below deliberately left blank usually stays blank.
      if (below && below[i] === 'blank' && rng.chance(params.bayAlignChance)) continue;
      if (rng.chance(p)) kinds[i] = ground && rng.chance(0.25) ? 'windowSmall' : 'window';
    }
  }

  // Mirroring the slot order doubles apparent variety for nothing, and is
  // literally what a developer does when reusing a house plan on the next lot.
  return spec.mirrored ? kinds.slice().reverse() : kinds;
}

function plainWall(buf: GeometryBuffer, wall: Wall, floor: Floor, spec: BuildingSpec): void {
  applyWallColor(buf, spec, floor);
  buf.pushWallQuad(wall.a, wall.b, floor.y0, floor.y1);
}

function applyWallColor(buf: GeometryBuffer, spec: BuildingSpec, floor: Floor): void {
  // Two-tone walls split at the 1F/2F line, with the darker band below.
  const useBand = spec.bandColor !== null && floor.index === 0;
  const c = useBand ? spec.bandColor! : spec.wallColor;
  const shade = spec.valueShift * groundGrime(floor.y0);
  buf.setColor({ r: c.r * shade, g: c.g * shade, b: c.b * shade });
}

/**
 * The 看板 band across the top of a shop storey, if this wall has one.
 *
 * The grammar below is one-dimensional per wall: bays are *columns*. A sign
 * band, a 幕板 and a parapet fascia are *rows*, and trying to express a row as a
 * `BayKind` fights the grammar — it would have to be placed in every slot and
 * would then merge, or not, according to rules written for openings.
 *
 * So rows are a pre-pass. The band is drawn across the full width, and the bays
 * are laid into whatever height is left. A wall with no band returns 0 and
 * everything below behaves exactly as it did.
 */
function signBandHeight(wall: Wall, floor: Floor, spec: BuildingSpec, params: BuildingParams): number {
  if (floor.index !== 0) return 0;
  if (spec.kind !== 'shophouse' && spec.kind !== 'konbini' && spec.kind !== 'zakkyo') return 0;
  if (wall.role !== 'front' && !wall.isEntrance) return 0;
  // Never eat so much of the storey that the shop window stops being a window.
  return Math.min(params.signBandHeight, (floor.y1 - floor.y0) * 0.3);
}

function buildWallGeometry(
  bufs: FacadeBuffers,
  wall: Wall,
  floor: Floor,
  bays: Bay[],
  spec: BuildingSpec,
  params: BuildingParams,
  rng: Rng,
): void {
  const buf = bufs.wall;
  applyWallColor(buf, spec, floor);

  const at = (u: number, offset = 0): Vec2 =>
    V.addScaled(V.addScaled(wall.a, wall.dir, u), wall.normal, offset);

  const band = signBandHeight(wall, floor, spec, params);
  // Everything below works to `yTop` rather than `floor.y1`, so a banded wall
  // simply has a shorter storey to lay openings into.
  const yTop = floor.y1 - band;

  const sill = floor.y0 + KIND_RULES[spec.kind].sill;
  const head = yTop - 0.42;
  const wallH = yTop - floor.y0;

  // Solid wall panels between openings, drawn as three bands so the opening
  // punches through.
  let cursor = 0;
  const solid = (u0: number, u1: number, y0: number, y1: number) => {
    if (u1 - u0 < 1e-4 || y1 - y0 < 1e-4) return;
    buf.pushWallQuad(at(u0), at(u1), y0, y1, u0);
  };

  for (const bay of bays) {
    solid(cursor, bay.u0, floor.y0, yTop);
    cursor = bay.u1;

    switch (bay.kind) {
      case 'blank':
        solid(bay.u0, bay.u1, floor.y0, yTop);
        break;

      case 'window':
      case 'windowSmall': {
        const inset = bay.kind === 'windowSmall' ? 0.22 : 0.12;
        const top = bay.kind === 'windowSmall' ? sill + (head - sill) * 0.55 : head;
        const bottom = bay.kind === 'windowSmall' ? sill + 0.35 : sill;
        solid(bay.u0, bay.u0 + inset, floor.y0, yTop);
        solid(bay.u1 - inset, bay.u1, floor.y0, yTop);
        solid(bay.u0 + inset, bay.u1 - inset, floor.y0, bottom);
        solid(bay.u0 + inset, bay.u1 - inset, top, yTop);
        buildWindow(bufs, wall, at, bay.u0 + inset, bay.u1 - inset, bottom, top, spec, rng, floor.index === 0);
        break;
      }

      case 'door':
      case 'unitDoor': {
        const doorTop = floor.y0 + 2.05;
        const inset = 0.14;
        solid(bay.u0, bay.u0 + inset, floor.y0, yTop);
        solid(bay.u1 - inset, bay.u1, floor.y0, yTop);
        solid(bay.u0 + inset, bay.u1 - inset, doorTop, yTop);
        buildDoor(bufs, wall, at, bay.u0 + inset, bay.u1 - inset, floor.y0, doorTop, spec);
        break;
      }

      case 'garage': {
        const top = floor.y0 + 2.25;
        solid(bay.u0, bay.u1, top, yTop);
        buildGarageOpening(bufs, wall, at, bay.u0, bay.u1, floor.y0, top, spec);
        break;
      }

      case 'blankPanel':
        solid(bay.u0, bay.u1, floor.y0, yTop);
        break;

      case 'shopfront': {
        buildShopfront(bufs, wall, at, bay.u0, bay.u1, floor.y0, yTop, spec);
        buildAwning(
          bufs,
          at,
          bay.u0,
          bay.u1,
          Math.min(yTop, floor.y0 + 2.45),
          Math.min(params.awningDepth, wall.room),
          spec,
        );
        applyWallColor(buf, spec, floor);
        break;
      }

      case 'shutter': {
        buildShutter(bufs, wall, at, bay.u0, bay.u1, floor.y0, yTop);
        buildAwning(
          bufs,
          at,
          bay.u0,
          bay.u1,
          Math.min(yTop, floor.y0 + 2.45),
          Math.min(params.awningDepth, wall.room),
          spec,
        );
        applyWallColor(buf, spec, floor);
        break;
      }

      case 'tenantWindow': {
        // Sill low and head high: a tenant strip runs nearly floor to ceiling,
        // and the runs merge in `baysFromKinds` into one ribbon per bay.
        const inset = 0.06;
        const bottom = floor.y0 + 0.7;
        const topY = yTop - 0.35;
        solid(bay.u0, bay.u0 + inset, floor.y0, yTop);
        solid(bay.u1 - inset, bay.u1, floor.y0, yTop);
        solid(bay.u0 + inset, bay.u1 - inset, floor.y0, bottom);
        solid(bay.u0 + inset, bay.u1 - inset, topY, yTop);
        buildWindow(bufs, wall, at, bay.u0 + inset, bay.u1 - inset, bottom, topY, spec, rng, false);
        break;
      }

      case 'tenantDoor': {
        const doorTop = floor.y0 + 2.2;
        const inset = 0.12;
        solid(bay.u0, bay.u0 + inset, floor.y0, yTop);
        solid(bay.u1 - inset, bay.u1, floor.y0, yTop);
        solid(bay.u0 + inset, bay.u1 - inset, doorTop, yTop);
        // Glazed, not solid: the way into a 雑居ビル is a glass door onto the
        // stair, never the panelled front door of a house.
        buildShopfront(bufs, wall, at, bay.u0 + inset, bay.u1 - inset, floor.y0, doorTop, spec);
        applyWallColor(buf, spec, floor);
        break;
      }

      case 'dockDoor': {
        // Absolute heights: this storey is one floor and the height of three, so
        // a door sized off the wall would be a five-metre shutter.
        const doorTop = Math.min(yTop - 0.4, floor.y0 + 4.2);
        solid(bay.u0, bay.u1, doorTop, yTop);
        buildShutter(bufs, wall, at, bay.u0, bay.u1, floor.y0, doorTop);
        // The canopy over the dock, so a lorry can be unloaded in the rain.
        const canopy: Vec2[] = [
          at(bay.u0 - 0.3),
          at(bay.u1 + 0.3),
          at(bay.u1 + 0.3, Math.min(1.2, Math.max(0.3, wall.room))),
          at(bay.u0 - 0.3, Math.min(1.2, Math.max(0.3, wall.room))),
        ];
        buf.setColor({ r: 0.72, g: 0.72, b: 0.7 });
        buf.pushPrism(canopy, doorTop, doorTop + 0.18, true, true);
        applyWallColor(buf, spec, floor);
        break;
      }

      case 'louvre': {
        // A band high on the wall, well above anything at ground level.
        const lo = Math.max(floor.y0 + 2.2, yTop - 2.6);
        const hi = Math.max(lo + 0.4, yTop - 0.8);
        solid(bay.u0, bay.u1, floor.y0, lo);
        solid(bay.u0, bay.u1, hi, yTop);
        buildLouvre(bufs, wall, at, bay.u0, bay.u1, lo, hi);
        applyWallColor(buf, spec, floor);
        break;
      }

      case 'balcony': {
        // The opening behind the balcony is a full-height sliding door.
        const top = yTop - 0.35;
        const bottom = floor.y0 + 0.06;
        solid(bay.u0, bay.u1, top, yTop);
        buildWindow(bufs, wall, at, bay.u0 + 0.1, bay.u1 - 0.1, bottom, top, spec, rng, false);
        solid(bay.u0, bay.u0 + 0.1, floor.y0, yTop);
        solid(bay.u1 - 0.1, bay.u1, floor.y0, yTop);
        buildBalcony(bufs, at, bay.u0, bay.u1, floor.y0, spec, wall.room);
        break;
      }
    }
    applyWallColor(buf, spec, floor);
  }
  solid(cursor, wall.len, floor.y0, yTop);

  // The 看板 band, drawn last so it sits over whatever the bays left. It is a
  // shallow projecting box rather than a flat panel: the shadow line under it is
  // most of what makes a shopfront read as one from across the street.
  if (band > 0.01) {
    const b = bufs.accent;
    b.setColor(spec.accentColor);
    const proj = 0.12;
    const corners: Vec2[] = [at(0), at(wall.len), at(wall.len, proj), at(0, proj)];
    b.pushPrism(corners, yTop, floor.y1, true, true);
  }
  void wallH;
}

/**
 * A shop window: a low plinth, full-height glazing, and mullions.
 *
 * The plinth matters more than it sounds. Glass taken all the way to the ground
 * reads as a gap in the building rather than a window, and every real shopfront
 * has a 腰壁 of a few hundred millimetres under the glass for exactly the
 * practical reasons that make it look right.
 */
function buildShopfront(
  bufs: FacadeBuffers,
  wall: Wall,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  spec: BuildingSpec,
): void {
  if (u1 - u0 < 0.2 || y1 - y0 < 0.5) return;
  const plinth = 0.28;
  const reveal = 0.08;
  const w = bufs.wall;
  w.pushWallQuad(at(u0), at(u1), y0, y0 + plinth, u0);

  const g = bufs.glass;
  const a = at(u0, -reveal);
  const b = at(u1, -reveal);
  g.pushQuad(
    { x: a.x, y: y0 + plinth, z: a.y },
    { x: a.x, y: y1, z: a.y },
    { x: b.x, y: y1, z: b.y },
    { x: b.x, y: y0 + plinth, z: b.y },
    { x: wall.normal.x, y: 0, z: wall.normal.y },
  );

  // Mullions every two modules, plus the frame. Shopfront framing is heavier
  // than a domestic sash and darker; it is what separates the glass into panes
  // at the distance the building is actually seen from.
  const m = bufs.metal;
  m.setColor(spec.sashColor);
  const bar = 0.07;
  const pushBar = (ua: number, ub: number, ya: number, yb: number) => {
    const p0 = at(ua, -reveal + 0.02);
    const p1 = at(ub, -reveal + 0.02);
    m.pushQuad(
      { x: p0.x, y: ya, z: p0.y },
      { x: p0.x, y: yb, z: p0.y },
      { x: p1.x, y: yb, z: p1.y },
      { x: p1.x, y: ya, z: p1.y },
      { x: wall.normal.x, y: 0, z: wall.normal.y },
    );
  };
  pushBar(u0, u1, y0 + plinth, y0 + plinth + bar);
  pushBar(u0, u1, y1 - bar, y1);
  pushBar(u0, u0 + bar, y0 + plinth, y1);
  pushBar(u1 - bar, u1, y0 + plinth, y1);
  const panes = Math.max(1, Math.round((u1 - u0) / 1.8));
  for (let i = 1; i < panes; i++) {
    const u = u0 + ((u1 - u0) * i) / panes;
    pushBar(u - bar / 2, u + bar / 2, y0 + plinth, y1);
  }
}

/** A closed rolling shutter. The slats come from the texture, not from geometry. */
function buildShutter(
  bufs: FacadeBuffers,
  wall: Wall,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
): void {
  if (u1 - u0 < 0.2 || y1 - y0 < 0.3) return;
  const sh = bufs.shutter;
  sh.setColor({ r: 0.74, g: 0.76, b: 0.77 });
  const inset = 0.1;
  const a = at(u0, -inset);
  const b = at(u1, -inset);
  sh.pushQuad(
    { x: a.x, y: y0, z: a.y },
    { x: a.x, y: y1, z: a.y },
    { x: b.x, y: y1, z: b.y },
    { x: b.x, y: y0, z: b.y },
    { x: wall.normal.x, y: 0, z: wall.normal.y },
  );
  // Reveal sides, so the shutter reads as set back into its opening.
  const w = bufs.wall;
  for (const [uu, flip] of [[u0, false], [u1, true]] as const) {
    const p0 = at(uu, 0);
    const p1 = at(uu, -inset);
    const [q0, q1] = flip ? [p0, p1] : [p1, p0];
    w.pushQuad(
      { x: q0.x, y: y0, z: q0.y },
      { x: q1.x, y: y0, z: q1.y },
      { x: q1.x, y: y1, z: q1.y },
      { x: q0.x, y: y1, z: q0.y },
    );
  }
}

/**
 * 庇 — the shop awning, a thin slab with a fascia on its front edge.
 *
 * Clamped to `wall.room`, the same way a balcony is. A real 庇 does project over
 * the pavement, and this one would like to; but the invariant this codebase
 * holds — and `test/buildings.test.ts` checks — is that nothing crosses the lot
 * boundary, and a 長屋 is built hard against both of its own. Clamping loses a
 * little of the overhang and keeps the invariant true everywhere.
 */
function buildAwning(
  bufs: FacadeBuffers,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y: number,
  depth: number,
  spec: BuildingSpec,
): void {
  if (depth < 0.25 || u1 - u0 < 0.4) return;
  const slab: Vec2[] = [at(u0), at(u1), at(u1, depth), at(u0, depth)];
  const w = bufs.wall;
  w.setColor({ r: 0.8, g: 0.79, b: 0.77 });
  w.pushPrism(slab, y, y + 0.07, true, true);
  // Fascia: a shallow upstand on the outer edge, in the shop's own colour.
  const f = bufs.accent;
  f.setColor(spec.accentColor);
  const edge: Vec2[] = [at(u0, depth - 0.06), at(u1, depth - 0.06), at(u1, depth), at(u0, depth)];
  f.pushPrism(edge, y - 0.22, y + 0.07, true, true);
}

function buildWindow(
  bufs: FacadeBuffers,
  wall: Wall,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  spec: BuildingSpec,
  rng: Rng,
  ground: boolean,
): void {
  if (u1 - u0 < 0.2 || y1 - y0 < 0.2) return;
  const reveal = 0.1;

  // Reveal: the sides, head and sill of the recess.
  const w = bufs.wall;
  w.pushQuad(
    { x: at(u0, -reveal).x, y: y0, z: at(u0, -reveal).y },
    { x: at(u0, 0).x, y: y0, z: at(u0, 0).y },
    { x: at(u0, 0).x, y: y1, z: at(u0, 0).y },
    { x: at(u0, -reveal).x, y: y1, z: at(u0, -reveal).y },
  );
  w.pushQuad(
    { x: at(u1, 0).x, y: y0, z: at(u1, 0).y },
    { x: at(u1, -reveal).x, y: y0, z: at(u1, -reveal).y },
    { x: at(u1, -reveal).x, y: y1, z: at(u1, -reveal).y },
    { x: at(u1, 0).x, y: y1, z: at(u1, 0).y },
  );

  // Glass pane, set back in the reveal.
  const g = bufs.glass;
  const a = at(u0, -reveal);
  const b = at(u1, -reveal);
  g.pushQuad(
    { x: a.x, y: y0, z: a.y },
    { x: a.x, y: y1, z: a.y },
    { x: b.x, y: y1, z: b.y },
    { x: b.x, y: y0, z: b.y },
    { x: wall.normal.x, y: 0, z: wall.normal.y },
  );

  // Aluminium sash: four thin bars around the opening plus a centre mullion.
  const m = bufs.metal;
  m.setColor(spec.sashColor);
  const bar = 0.055;
  const frameAt = (uu: number, o: number) => at(uu, o);
  const pushBar = (ua: number, ub: number, ya: number, yb: number) => {
    const p0 = frameAt(ua, -reveal + 0.02);
    const p1 = frameAt(ub, -reveal + 0.02);
    m.pushQuad(
      { x: p0.x, y: ya, z: p0.y },
      { x: p0.x, y: yb, z: p0.y },
      { x: p1.x, y: yb, z: p1.y },
      { x: p1.x, y: ya, z: p1.y },
      { x: wall.normal.x, y: 0, z: wall.normal.y },
    );
  };
  pushBar(u0, u1, y0, y0 + bar);
  pushBar(u0, u1, y1 - bar, y1);
  pushBar(u0, u0 + bar, y0, y1);
  pushBar(u1 - bar, u1, y0, y1);
  const mid = (u0 + u1) / 2;
  pushBar(mid - bar / 2, mid + bar / 2, y0, y1);

  // 面格子 — a window grille. Nearly free, and extremely Japanese.
  if (ground && rng.chance(spec.windowGrilleChance)) {
    const bars = 5;
    for (let i = 1; i <= bars; i++) {
      const u = u0 + ((u1 - u0) * i) / (bars + 1);
      const p = at(u, -0.04);
      m.pushBox(p.x, (y0 + y1) / 2, p.y, 0.022, y1 - y0, 0.022);
    }
  }
}

function buildDoor(
  bufs: FacadeBuffers,
  wall: Wall,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  spec: BuildingSpec,
): void {
  const d = bufs.accent;
  d.setColor(spec.accentColor);
  const inset = 0.09;
  const a = at(u0, -inset);
  const b = at(u1, -inset);
  d.pushQuad(
    { x: a.x, y: y0, z: a.y },
    { x: a.x, y: y1, z: a.y },
    { x: b.x, y: y1, z: b.y },
    { x: b.x, y: y0, z: b.y },
    { x: wall.normal.x, y: 0, z: wall.normal.y },
  );
  // Reveal sides.
  const w = bufs.wall;
  for (const [uu, sign] of [[u0, 1], [u1, -1]] as const) {
    const p0 = at(uu, 0);
    const p1 = at(uu, -inset);
    if (sign > 0) {
      w.pushQuad(
        { x: p1.x, y: y0, z: p1.y },
        { x: p0.x, y: y0, z: p0.y },
        { x: p0.x, y: y1, z: p0.y },
        { x: p1.x, y: y1, z: p1.y },
      );
    } else {
      w.pushQuad(
        { x: p0.x, y: y0, z: p0.y },
        { x: p1.x, y: y0, z: p1.y },
        { x: p1.x, y: y1, z: p1.y },
        { x: p0.x, y: y1, z: p0.y },
      );
    }
  }

  // Meter box beside the entrance — the small grey box every Japanese house has.
  const m = bufs.metal;
  m.setColor({ r: 0.78, g: 0.78, b: 0.75 });
  const mp = at(u1 + 0.35, -0.09);
  m.pushBox(mp.x, y0 + 1.45, mp.y, 0.3, 0.48, 0.16);
}

function buildGarageOpening(
  bufs: FacadeBuffers,
  wall: Wall,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  spec: BuildingSpec,
): void {
  const m = bufs.metal;
  m.setColor({ r: 0.62, g: 0.62, b: 0.6 });
  const a = at(u0, -0.25);
  const b = at(u1, -0.25);
  m.pushQuad(
    { x: a.x, y: y0, z: a.y },
    { x: a.x, y: y1, z: a.y },
    { x: b.x, y: y1, z: b.y },
    { x: b.x, y: y0, z: b.y },
    { x: wall.normal.x, y: 0, z: wall.normal.y },
  );
  void spec;
}

/** A run of angled ventilation slats set into a recess. */
function buildLouvre(
  bufs: FacadeBuffers,
  wall: Wall,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
): void {
  if (u1 - u0 < 0.3 || y1 - y0 < 0.3) return;
  const m = bufs.metal;
  m.setColor({ r: 0.62, g: 0.63, b: 0.64 });
  // Recess behind them, so the slats read as set into the wall rather than
  // stuck on it. Dark, because a louvre is a hole with metal in front of it.
  const w = bufs.wall;
  w.setColor({ r: 0.24, g: 0.25, b: 0.26 });
  const a = at(u0, -0.14);
  const b = at(u1, -0.14);
  w.pushQuad(
    { x: a.x, y: y0, z: a.y },
    { x: a.x, y: y1, z: a.y },
    { x: b.x, y: y1, z: b.y },
    { x: b.x, y: y0, z: b.y },
    { x: wall.normal.x, y: 0, z: wall.normal.y },
  );

  const slats = Math.max(3, Math.round((y1 - y0) / 0.22));
  const mid = V.lerp(at(u0), at(u1), 0.5);
  for (let i = 0; i < slats; i++) {
    const y = y0 + ((y1 - y0) * (i + 0.5)) / slats;
    m.pushOrientedBox(mid.x, mid.y, wall.dir, 0.06, u1 - u0, y - 0.03, y + 0.03);
  }
}

/**
 * A cantilevered balcony slab plus its railing. The railing style is derived
 * from era: bare concrete on older buildings, aluminium louvres, then frosted
 * glass on new ones.
 */
function buildBalcony(
  bufs: FacadeBuffers,
  at: (u: number, o?: number) => Vec2,
  u0: number,
  u1: number,
  y0: number,
  spec: BuildingSpec,
  room: number,
): void {
  const depth = Math.min(spec.balconyDepth, room);
  if (depth < MIN_BALCONY_DEPTH) return;
  const railH = 1.1;
  const slabT = 0.16;

  // `at(u, offset)` offsets along the wall's *outward* normal, so the balcony
  // projects with a positive depth. A negative one buries it inside the flat.
  const corners = [at(u0, 0), at(u1, 0), at(u1, depth), at(u0, depth)];
  const slab: Vec2[] = [corners[0]!, corners[1]!, corners[2]!, corners[3]!];

  const w = bufs.wall;
  w.setColor({ r: 0.78, g: 0.77, b: 0.74 });
  w.pushPrism(slab, y0 - slabT, y0 + 0.02, true, true);

  // Railing: an upstand around the three open sides.
  const railBuf = spec.balconyStyle === 'glass' ? bufs.glass : spec.balconyStyle === 'concrete' ? bufs.wall : bufs.metal;
  if (spec.balconyStyle !== 'glass') {
    railBuf.setColor(
      spec.balconyStyle === 'concrete'
        ? { r: 0.76, g: 0.75, b: 0.72 }
        : { r: 0.72, g: 0.73, b: 0.74 },
    );
  }
  const t = 0.07;
  const sides: [Vec2, Vec2][] = [
    [corners[0]!, corners[3]!],
    [corners[3]!, corners[2]!],
    [corners[2]!, corners[1]!],
  ];
  for (const [a, b] of sides) {
    const dir = V.normalize(V.sub(b, a));
    const n = V.perp(dir);
    const quad: Vec2[] = [
      V.addScaled(a, n, -t / 2),
      V.addScaled(b, n, -t / 2),
      V.addScaled(b, n, t / 2),
      V.addScaled(a, n, t / 2),
    ];
    railBuf.pushPrism(quad, y0 + 0.02, y0 + railH, true, false);
  }
}
