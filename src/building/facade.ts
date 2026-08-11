import type { Vec2 } from '../core/types.js';
import type { BuildingParams } from '../core/params.js';
import { makeRng, subSeed, type Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { groundGrime } from '../material/palettes.js';
import type { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { BuildingSpec, Floor, Footprint, Wall } from './types.js';

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

export interface FacadeBuffers {
  wall: GeometryBuffer;
  glass: GeometryBuffer;
  metal: GeometryBuffer;
  accent: GeometryBuffer;
}

export function buildFacades(
  bufs: FacadeBuffers,
  footprint: Footprint,
  floors: Floor[],
  spec: BuildingSpec,
  params: BuildingParams,
  seed: string,
): void {
  const module = params.module;

  for (const floor of floors) {
    // Walls are taken from the floor's own outline, so slant-clipped upper
    // floors get their own (shorter) wall set rather than the base one.
    const walls = wallsForFloor(footprint, floor);
    for (let w = 0; w < walls.length; w++) {
      const wall = walls[w]!;
      if (wall.len < module * 1.2) {
        plainWall(bufs.wall, wall, floor, spec);
        continue;
      }
      const rng = makeRng(subSeed(seed, 'facade', floor.index, w));
      const bays = layoutWall(wall, floor, spec, params, rng);
      buildWallGeometry(bufs, wall, floor, bays, spec, params, rng);
    }
  }
}

/**
 * Map the base footprint's wall classification onto a (possibly clipped) floor
 * outline by matching direction and proximity.
 */
function wallsForFloor(footprint: Footprint, floor: Floor): Wall[] {
  const poly = floor.polygon;
  const out: Wall[] = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const d = V.sub(b, a);
    const len = V.len(d);
    if (len < 0.15) continue;
    const dir = V.scale(d, 1 / len);
    const normal = V.neg(V.perp(dir));
    const mid = V.lerp(a, b, 0.5);

    // Inherit the role from the nearest base wall pointing the same way.
    let best: Wall | null = null;
    let bestScore = -Infinity;
    for (const bw of footprint.walls) {
      const align = V.dot(bw.normal, normal);
      if (align < 0.7) continue;
      const score = align - V.distToSegment(mid, bw.a, bw.b) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = bw;
      }
    }
    out.push({
      a,
      b,
      len,
      dir,
      normal,
      role: best?.role ?? 'side',
      sunFacing: best?.sunFacing ?? normal.y > 0.4,
      isCorridorSide: best?.isCorridorSide ?? false,
    });
  }
  return out;
}

function layoutWall(
  wall: Wall,
  floor: Floor,
  spec: BuildingSpec,
  params: BuildingParams,
  rng: Rng,
): Bay[] {
  const module = params.module;
  // Reserve a corner return at each end — openings never run into a corner.
  const margin = module * 0.6;
  const usable = wall.len - margin * 2;
  const slots = Math.floor(usable / module);
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
    if (ground && wall.role === 'front') {
      // Never centre the entrance: 20–38% or 62–80% along the wall.
      const t = rng.chance(0.5) ? rng.range(0.2, 0.38) : rng.range(0.62, 0.8);
      place(Math.floor(t * slots), 1, 'door');
      if (spec.wantsCarPad && slots >= 5 && rng.chance(0.35)) {
        place(rng.chance(0.5) ? 0 : slots - 3, 3, 'garage');
      }
    }
    if (!ground && wall.sunFacing && slots >= 4) {
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
    } else if (wall.sunFacing || wall.role === 'front') {
      const balconySlots = Math.max(2, unitSlots - 1);
      for (let u = 0; u + unitSlots <= slots; u += unitSlots) {
        place(u, balconySlots, 'balcony');
      }
    }
    if (ground && wall.role === 'front' && spec.kind === 'mansion') {
      place(Math.floor(slots * rng.range(0.25, 0.6)), Math.min(3, slots), 'door');
    }
  }

  // Fill the rest with windows, at a probability that depends on which way the
  // wall faces. North and rear elevations really are much blanker in Japan.
  const p = wall.role === 'front' ? (wall.sunFacing ? 0.75 : 0.55) : wall.sunFacing ? 0.6 : wall.role === 'rear' ? 0.22 : 0.3;
  for (let i = 0; i < slots; i++) {
    if (kinds[i] !== 'blank') continue;
    if (rng.chance(p)) kinds[i] = ground && rng.chance(0.25) ? 'windowSmall' : 'window';
  }

  // Merge runs of the same kind into bays.
  const bays: Bay[] = [];
  let i = 0;
  while (i < slots) {
    const kind = kinds[i]!;
    let j = i + 1;
    while (j < slots && kinds[j] === kind && kind !== 'window' && kind !== 'windowSmall') j++;
    bays.push({ kind, u0: margin + i * module, u1: margin + j * module });
    i = j;
  }
  return bays;
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
  params: BuildingParams,
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
        buildBalcony(bufs, at, bay.u0, bay.u1, floor.y0, spec);
        break;
      }
    }
    applyWallColor(buf, spec, floor);
  }
  solid(cursor, wall.len, floor.y0, floor.y1);
  void wallH;
  void params;
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
): void {
  const depth = spec.balconyDepth;
  const railH = 1.1;
  const slabT = 0.16;

  const corners = [at(u0, 0), at(u1, 0), at(u1, -depth), at(u0, -depth)];
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
