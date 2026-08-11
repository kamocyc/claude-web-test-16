import type { Polygon, Vec2 } from '../core/types.js';
import type { CityParams } from '../core/params.js';
import type { Rng } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { area, centroid, edges as polyEdges } from '../geom/polygon.js';
import { offsetInward } from '../geom/offset.js';
import { CAR_BODY, FOLIAGE } from '../material/palettes.js';
import type { Lot } from '../city/Lots.js';
import type { BuiltBuilding } from '../building/Builder.js';
import type { BuildingSpec } from '../building/types.js';
import { PropRegistry } from './PropRegistry.js';

/**
 * Everything on the lot that is not the building: boundary walls and fences,
 * the car pad, the gate posts, and the planting.
 *
 * The lot polygons already exist, so this is nearly free — and it is what fills
 * the ground plane and makes the city read as inhabited rather than as a model.
 */

const BLOCK_GREY = { r: 0.78, g: 0.77, b: 0.74 };
const ALUMINIUM = { r: 0.72, g: 0.73, b: 0.74 };
const MESH_GREY = { r: 0.6, g: 0.62, b: 0.63 };

export function buildSiteProps(
  props: PropRegistry,
  lot: Lot,
  spec: BuildingSpec,
  built: BuiltBuilding,
  params: CityParams,
  rng: Rng,
): void {
  const cfg = params.props;
  const frontIdx = new Set(lot.frontages.map((f) => f.i));

  if (cfg.fences) buildBoundary(props, lot, spec, frontIdx, rng);
  if (cfg.gates) buildGate(props, lot, spec, rng);
  if (cfg.parking && built.envelope.carPad) buildCarPad(props, built.envelope.carPad, lot, params, rng);
  if (cfg.vegetation) buildPlanting(props, lot, built, spec, rng);
}

/**
 * ブロック塀 and fences along every non-frontage boundary. Style follows era and
 * wealth: concrete block on older lots, block base plus aluminium fence on
 * newer ones, hedges where the garden matters.
 */
function buildBoundary(
  props: PropRegistry,
  lot: Lot,
  spec: BuildingSpec,
  frontIdx: Set<number>,
  rng: Rng,
): void {
  for (const e of polyEdges(lot.polygon)) {
    const isFront = frontIdx.has(e.i);
    // A flag lot's pole is the driveway: no wall across it.
    if (lot.poleCorridor && edgeTouchesPole(e.a, e.b, lot.poleCorridor)) continue;
    if (e.len < 0.6) continue;

    // Frontage gets a low base only, so the house stays visible from the street.
    const height = isFront ? Math.min(0.55, spec.fenceHeight * 0.4) : spec.fenceHeight;
    const style = isFront ? 'lowBlock' : spec.fenceStyle;
    // Set the wall just inside the boundary so neighbours' walls do not z-fight.
    const inset = 0.06;

    switch (style) {
      case 'block':
      case 'lowBlock': {
        addWallRun(props, e.a, e.b, e.normal, inset, height, 'fencePost', BLOCK_GREY, 0.14);
        break;
      }
      case 'blockAndAluminium': {
        const baseH = Math.min(height, 0.55);
        addWallRun(props, e.a, e.b, e.normal, inset, baseH, 'fencePost', BLOCK_GREY, 0.14);
        if (height > baseH + 0.2) {
          addPanelRun(props, e.a, e.b, e.normal, inset, baseH, height, 'aluminiumPanel', ALUMINIUM);
        }
        break;
      }
      case 'mesh': {
        addPanelRun(props, e.a, e.b, e.normal, inset, 0.05, height, 'meshPanel', MESH_GREY);
        break;
      }
      case 'hedge': {
        const green = rng.pick(FOLIAGE);
        const c = { r: ((green >> 16) & 255) / 255, g: ((green >> 8) & 255) / 255, b: (green & 255) / 255 };
        const n = Math.max(1, Math.round(e.len / 1.2));
        for (let i = 0; i < n; i++) {
          const p = V.addScaled(
            V.lerp(e.a, e.b, (i + 0.5) / n),
            e.normal,
            inset + 0.3,
          );
          props.add('hedgeUnit', p, height / 2, { w: 0.62, h: height, d: e.len / n + 0.08 }, e.dir, {
            r: c.r * rng.range(0.85, 1.1),
            g: c.g * rng.range(0.85, 1.1),
            b: c.b * rng.range(0.85, 1.1),
          });
        }
        break;
      }
    }
  }
}

/** A continuous solid wall run, drawn as one stretched box. */
function addWallRun(
  props: PropRegistry,
  a: Vec2,
  b: Vec2,
  inwardNormal: Vec2,
  inset: number,
  height: number,
  type: 'fencePost' | 'gatePost',
  color: { r: number; g: number; b: number },
  thickness: number,
): void {
  const len = V.dist(a, b);
  if (len < 0.3 || height < 0.1) return;
  const dir = V.normalize(V.sub(b, a));
  const mid = V.addScaled(V.lerp(a, b, 0.5), inwardNormal, inset + thickness / 2);
  props.add(type, mid, height / 2, { w: thickness, h: height, d: len }, dir, color);
  // 笠木 — the coping course every block wall is finished with.
  props.add(type, mid, height + 0.03, { w: thickness + 0.06, h: 0.06, d: len }, dir, {
    r: color.r * 1.06,
    g: color.g * 1.06,
    b: color.b * 1.06,
  });
}

/** A thin panel above a base wall — the aluminium or mesh part of a fence. */
function addPanelRun(
  props: PropRegistry,
  a: Vec2,
  b: Vec2,
  inwardNormal: Vec2,
  inset: number,
  y0: number,
  y1: number,
  type: 'aluminiumPanel' | 'meshPanel',
  color: { r: number; g: number; b: number },
): void {
  const len = V.dist(a, b);
  if (len < 0.3 || y1 - y0 < 0.1) return;
  const dir = V.normalize(V.sub(b, a));
  const mid = V.addScaled(V.lerp(a, b, 0.5), inwardNormal, inset + 0.04);
  props.add(type, mid, (y0 + y1) / 2, { w: 0.05, h: y1 - y0, d: len }, dir, color);
}

function edgeTouchesPole(a: Vec2, b: Vec2, pole: Polygon): boolean {
  const mid = V.lerp(a, b, 0.5);
  for (const p of pole) if (V.dist(p, mid) < 2.0) return true;
  return false;
}

/** 門柱: a gate post with a nameplate, mailbox and intercom beside the entrance. */
function buildGate(props: PropRegistry, lot: Lot, spec: BuildingSpec, rng: Rng): void {
  const f = lot.frontages[0];
  if (!f || f.len < 2.2) return;
  const t = rng.range(0.25, 0.72);
  const base = V.lerp(f.a, f.b, t);
  const inward = V.neg(f.outward);
  const p = V.addScaled(base, inward, 0.55);

  props.add('gatePost', p, 0.7, { w: 0.34, h: 1.4, d: 0.34 }, f.dir, BLOCK_GREY);
  // Mailbox and intercom plate on the street face.
  const face = V.addScaled(p, f.outward, 0.2);
  props.add('mailbox', face, 1.02, { w: 0.26, h: 0.22, d: 0.1 }, f.dir, {
    r: spec.accentColor.r,
    g: spec.accentColor.g,
    b: spec.accentColor.b,
  });
  props.add('mailbox', V.addScaled(face, f.dir, 0.0), 1.32, { w: 0.1, h: 0.14, d: 0.05 }, f.dir, {
    r: 0.85,
    g: 0.85,
    b: 0.84,
  });
}

/**
 * The concrete car pad in the front setback, the reason that setback exists,
 * plus a parked car and occasionally a carport roof.
 */
function buildCarPad(
  props: PropRegistry,
  pad: Polygon,
  lot: Lot,
  params: CityParams,
  rng: Rng,
): void {
  const padArea = area(pad);
  if (padArea < 9) return;
  const f = lot.frontages[0]!;
  const inward = V.neg(f.outward);
  const c = centroid(pad);

  // The pad slab itself, sitting just above the ground.
  props.add('fencePost', c, 0.03, { w: 2.9, h: 0.06, d: 5.0 }, inward, { r: 0.72, g: 0.71, b: 0.69 });

  if (rng.chance(params.props.carChance)) {
    const hex = rng.pick(CAR_BODY);
    const color = {
      r: ((hex >> 16) & 255) / 255,
      g: ((hex >> 8) & 255) / 255,
      b: (hex & 255) / 255,
    };
    // Kei car or sedan — a chamfered box reads fine at this scale.
    const kei = rng.chance(0.45);
    const w = kei ? 1.48 : 1.72;
    const l = kei ? 3.4 : 4.5;
    const bodyH = kei ? 1.05 : 0.85;
    props.add('carBody', c, 0.15 + bodyH / 2, { w, h: bodyH, d: l }, inward, color);
    props.add('carCabin', V.addScaled(c, inward, kei ? 0 : -0.35), 0.18 + bodyH + 0.32, {
      w: w * 0.92,
      h: kei ? 0.72 : 0.6,
      d: l * (kei ? 0.62 : 0.48),
    }, inward, color);
  }

  if (rng.chance(params.props.carportChance)) {
    const h = 2.35;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = V.add(V.addScaled(c, inward, sz * 2.2), V.scale(V.perp(inward), sx * 1.45));
      props.add('carportColumn', p, h / 2, { w: 0.1, h, d: 0.1 }, inward, ALUMINIUM);
    }
    // Translucent polycarbonate deck, approximated as a thin pale slab.
    props.add('carportColumn', c, h + 0.05, { w: 3.1, h: 0.08, d: 5.2 }, inward, {
      r: 0.86,
      g: 0.88,
      b: 0.9,
    });
  }
}

/**
 * Garden planting: shrubs on the leftover land, and a cluster of pots by the
 * entrance. Japanese houses have chaotic pot collections, and a handful of them
 * reads better than any amount of detailed foliage.
 */
function buildPlanting(
  props: PropRegistry,
  lot: Lot,
  built: BuiltBuilding,
  spec: BuildingSpec,
  rng: Rng,
): void {
  // Open ground is the lot minus the building — which for a building sitting
  // clear of its boundaries is an annulus. This pipeline does not carry holes,
  // so a boolean difference here would hand back the whole lot and plant shrubs
  // inside the house. Sample and reject instead: cheaper, and exactly right.
  const inner = offsetInward(lot.polygon, 0.6)[0];
  if (!inner || area(inner) < 2) return;

  const blocked: Polygon[] = [built.footprint.outline];
  if (built.envelope.carPad) blocked.push(built.envelope.carPad);
  if (lot.poleCorridor) blocked.push(lot.poleCorridor);
  // `clearance` keeps a prop off the walls themselves, not just out of the
  // footprint. A shrub needs half a metre; a 25 cm pot stands against the wall,
  // and with the front setback down to 0.8 m insisting otherwise left nowhere
  // for the pots to go at all.
  const isFree = (p: Vec2, clearance = 0.5): boolean => {
    for (const b of blocked) if (pointInPolygon(b, p)) return false;
    for (const e of polyEdges(built.footprint.outline)) {
      if (V.distToSegment(p, e.a, e.b) < clearance) return false;
    }
    return true;
  };

  const budget = spec.kind === 'house' ? 3 + rng.int(4) : 2 + rng.int(3);
  for (let placed = 0, attempts = 0; placed < budget && attempts < budget * 6; attempts++) {
    const p = randomPointIn(inner, rng);
    if (!p || !isFree(p)) continue;
    const hex = rng.pick(FOLIAGE);
    const r = rng.range(0.45, 1.15);
    props.add(
      'shrub',
      p,
      r * 0.85,
      { w: r * 2, h: r * 1.7, d: r * 2 },
      { x: 1, y: 0 },
      {
        r: (((hex >> 16) & 255) / 255) * rng.range(0.85, 1.12),
        g: (((hex >> 8) & 255) / 255) * rng.range(0.85, 1.12),
        b: ((hex & 255) / 255) * rng.range(0.85, 1.12),
      },
    );
    placed++;
  }

  // Pot cluster beside the entrance. The front setback is only 0.8 m now that
  // the parking space is a corner notch rather than a band, so a fixed offset
  // from the frontage would put the pots inside the house — walk along the
  // frontage until the strip in front of the wall is actually open.
  const f = lot.frontages[0];
  if (f && rng.chance(0.7)) {
    let base: Vec2 | null = null;
    for (let i = 0; i < 8 && !base; i++) {
      const p = V.addScaled(V.lerp(f.a, f.b, rng.range(0.15, 0.85)), V.neg(f.outward), rng.range(0.3, 1.1));
      if (isFree(p, 0.12)) base = p;
    }
    if (!base) return;
    const pots = 3 + rng.int(6);
    for (let i = 0; i < pots; i++) {
      const p = V.add(base, { x: rng.jitter(0.8), y: rng.jitter(0.8) });
      const h = rng.range(0.22, 0.45);
      props.add('pot', p, h / 2, { w: h * 0.9, h, d: h * 0.9 }, { x: 1, y: 0 }, {
        r: rng.range(0.5, 0.75),
        g: rng.range(0.38, 0.55),
        b: rng.range(0.32, 0.45),
      });
      const hex = rng.pick(FOLIAGE);
      props.add('shrub', p, h + 0.16, { w: 0.44, h: 0.36, d: 0.44 }, { x: 1, y: 0 }, {
        r: ((hex >> 16) & 255) / 255,
        g: ((hex >> 8) & 255) / 255,
        b: (hex & 255) / 255,
      });
    }
  }
}

/** Rejection-sample a point inside a polygon; gives up rather than looping. */
function randomPointIn(poly: Polygon, rng: Rng): Vec2 | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  for (let i = 0; i < 12; i++) {
    const p = { x: rng.range(minX, maxX), y: rng.range(minY, maxY) };
    if (pointInPolygon(poly, p)) return p;
  }
  return null;
}

function pointInPolygon(poly: Polygon, p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
