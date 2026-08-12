import type { Vec2 } from '../core/types.js';
import type { BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { groundGrime } from '../material/palettes.js';
import type { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { BuildingSpec, Floor, Wall } from './types.js';

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
  | 'unitDoor';

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
      buildWallGeometry(bufs, wall, floor, baysFromKinds(kinds, module), spec, rng);
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
    // Windows stay one slot wide; everything else merges into a run.
    while (j < kinds.length && kinds[j] === kind && kind !== 'window' && kind !== 'windowSmall') j++;
    bays.push({ kind, u0: margin + i * module, u1: margin + j * module });
    i = j;
  }
  return bays;
}

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

  if (spec.kind === 'house') {
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
  } else {
    // Apartments and mansions: repeat a unit rhythm along the wall.
    const unitSlots = Math.max(2, Math.round(spec.unitWidth / module));
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
  }

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
      // A door or garage below becomes an ordinary window above.
      kinds[i] = under === 'door' || under === 'garage' || under === 'unitDoor' ? 'window' : under;
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

function buildWallGeometry(
  bufs: FacadeBuffers,
  wall: Wall,
  floor: Floor,
  bays: Bay[],
  spec: BuildingSpec,
  rng: Rng,
): void {
  const buf = bufs.wall;
  applyWallColor(buf, spec, floor);

  const at = (u: number, offset = 0): Vec2 =>
    V.addScaled(V.addScaled(wall.a, wall.dir, u), wall.normal, offset);

  const sill = floor.y0 + (spec.kind === 'house' ? 0.95 : 0.9);
  const head = floor.y1 - 0.42;
  const wallH = floor.y1 - floor.y0;

  // Solid wall panels between openings, drawn as three bands so the opening
  // punches through.
  let cursor = 0;
  const solid = (u0: number, u1: number, y0: number, y1: number) => {
    if (u1 - u0 < 1e-4 || y1 - y0 < 1e-4) return;
    buf.pushWallQuad(at(u0), at(u1), y0, y1, u0);
  };

  for (const bay of bays) {
    solid(cursor, bay.u0, floor.y0, floor.y1);
    cursor = bay.u1;

    switch (bay.kind) {
      case 'blank':
        solid(bay.u0, bay.u1, floor.y0, floor.y1);
        break;

      case 'window':
      case 'windowSmall': {
        const inset = bay.kind === 'windowSmall' ? 0.22 : 0.12;
        const top = bay.kind === 'windowSmall' ? sill + (head - sill) * 0.55 : head;
        const bottom = bay.kind === 'windowSmall' ? sill + 0.35 : sill;
        solid(bay.u0, bay.u0 + inset, floor.y0, floor.y1);
        solid(bay.u1 - inset, bay.u1, floor.y0, floor.y1);
        solid(bay.u0 + inset, bay.u1 - inset, floor.y0, bottom);
        solid(bay.u0 + inset, bay.u1 - inset, top, floor.y1);
        buildWindow(bufs, wall, at, bay.u0 + inset, bay.u1 - inset, bottom, top, spec, rng, floor.index === 0);
        break;
      }

      case 'door':
      case 'unitDoor': {
        const doorTop = floor.y0 + 2.05;
        const inset = 0.14;
        solid(bay.u0, bay.u0 + inset, floor.y0, floor.y1);
        solid(bay.u1 - inset, bay.u1, floor.y0, floor.y1);
        solid(bay.u0 + inset, bay.u1 - inset, doorTop, floor.y1);
        buildDoor(bufs, wall, at, bay.u0 + inset, bay.u1 - inset, floor.y0, doorTop, spec);
        break;
      }

      case 'garage': {
        const top = floor.y0 + 2.25;
        solid(bay.u0, bay.u1, top, floor.y1);
        buildGarageOpening(bufs, wall, at, bay.u0, bay.u1, floor.y0, top, spec);
        break;
      }

      case 'balcony': {
        // The opening behind the balcony is a full-height sliding door.
        const top = floor.y1 - 0.35;
        const bottom = floor.y0 + 0.06;
        solid(bay.u0, bay.u1, top, floor.y1);
        buildWindow(bufs, wall, at, bay.u0 + 0.1, bay.u1 - 0.1, bottom, top, spec, rng, false);
        solid(bay.u0, bay.u0 + 0.1, floor.y0, floor.y1);
        solid(bay.u1 - 0.1, bay.u1, floor.y0, floor.y1);
        buildBalcony(bufs, at, bay.u0, bay.u1, floor.y0, spec, wall.room);
        break;
      }
    }
    applyWallColor(buf, spec, floor);
  }
  solid(cursor, wall.len, floor.y0, floor.y1);
  void wallH;
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
