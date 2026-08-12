import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import { intersectPoly } from '../geom/boolean.js';
import { offsetOutward } from '../geom/offset.js';
import { expandRect, polyToWorld, toLocal, toWorld, type Frame, type LocalRect } from '../geom/obb.js';
import type { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { BuildingSpec } from './types.js';

/**
 * What a roof needs to know about the thing it sits on. `Stack` satisfies this
 * structurally, so the builder needs no adapter.
 */
export interface RoofTarget {
  polygon: Polygon;
  /** Rectangles driving a pitched roof, expressed in `frame`. */
  parts: LocalRect[];
  frame: Frame;
  /** `polygon` is materially smaller than the union of `parts`. */
  cut: boolean;
}

/**
 * Roof generation — and the reason a straight skeleton is never needed.
 *
 * Footprints are authored as unions of oriented rectangles, so gable and hip
 * roofs are built **per rectangle** and allowed to interpenetrate. That is not a
 * shortcut: a real L-shaped Japanese house genuinely has two intersecting gable
 * roofs meeting in a valley, and interpenetrating opaque solids render
 * identically to a booleaned union. It removes the single largest source of
 * implementation risk in the project — split events on reflex vertices and the
 * epsilon-driven infinite loops that come with them.
 *
 * Where a footprint has been heavily clipped by the lot, roof faces are clipped
 * in plan against the eaves envelope and re-lifted. That is valid because
 * height is an affine function of (x, z) on every roof face.
 */

export interface RoofResult {
  /** Height of the roof's highest point above the eave line. */
  peak: number;
  /**
   * Height above the eave line of the surface things *stand on*.
   *
   * Distinct from `peak`, and the distinction is not academic: on a flat roof
   * the peak is the top of the parapet, so anything placed at `peak` floats a
   * whole parapet above the slab. That is precisely what the rooftop plant did
   * — a 塔屋 and five condensers hovering a metre over every マンション in the
   * town, hidden behind the upstand from street level and plainly wrong from the
   * air. A pitched roof has no deck, and reports its eave line.
   */
  deck: number;
  /** Plan polygon of the eaves, for props that need to avoid the overhang. */
  envelope: Polygon;
}

const FASCIA = 0.22;

/**
 * Ceiling on how far a 片流れ may climb from eave to ridge.
 *
 * The rise of a mono-pitch is span × pitch, and the span is whatever the plan
 * measures in the fall direction — so on a long plan the roof becomes a sail
 * rather than a roof. A real one is sized by the storey it covers.
 */
const MAX_SHED_RISE = 2.8;

export function buildRoof(
  buf: GeometryBuffer,
  target: RoofTarget,
  eaveY: number,
  spec: BuildingSpec,
  roofType: BuildingSpec['roofType'] = spec.roofType,
): RoofResult {
  // A pitched roof is assembled per constituent rectangle, so with no rectangles
  // it would emit nothing at all and leave the building open to the sky. An
  // outline that follows a lot boundary has none by construction; 片流れ is exact
  // on any polygon, so that is the safe answer rather than a missing roof.
  if (target.parts.length === 0 && (roofType === 'gable' || roofType === 'hip')) {
    return buildShedRoof(buf, target, eaveY, spec);
  }

  switch (roofType) {
    case 'flat':
      return buildFlatRoof(buf, target.polygon, eaveY, spec);
    case 'shed':
      return buildShedRoof(buf, target, eaveY, spec);
    case 'gable':
    case 'hip':
      return buildPitchedRoof(buf, target, eaveY, spec, roofType);
  }
}

/** 陸屋根: a slab plus a parapet upstand around the edge. */
function buildFlatRoof(
  buf: GeometryBuffer,
  poly: Polygon,
  eaveY: number,
  spec: BuildingSpec,
): RoofResult {
  buf.pushCap(poly, eaveY + 0.05, true);
  const ring = offsetOutward(poly, 0.07)[0] ?? poly;
  // Prism gives the outer face, the inner face is hidden, and the cap is the
  // coping — 笠木 — that every Japanese parapet has.
  buf.pushPrism(ring, eaveY, eaveY + spec.parapetHeight, true, false);
  return { peak: spec.parapetHeight, deck: 0.05, envelope: ring };
}

/** 片流れ: a single plane. Exact on any polygon — height is affine in (x, z). */
function buildShedRoof(
  buf: GeometryBuffer,
  target: RoofTarget,
  eaveY: number,
  spec: BuildingSpec,
): RoofResult {
  const poly = target.polygon;
  const envelope = offsetOutward(poly, spec.eaves)[0] ?? poly;

  const extentAlong = (d: Vec2): { min: number; max: number } => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of envelope) {
      const t = V.dot(p, d);
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return { min, max };
  };

  // ridgeAlongStreet is a stylistic preference (平入り vs 妻入り), but a
  // mono-pitch has to run down the *short* way: a slope taken along the 25 m
  // side of a wedge is a sail, not a roof. Honour the preference while the two
  // are comparable, and override it when they are not.
  const preferred = V.normalize(
    spec.ridgeAlongStreet ? V.perp(target.frame.xAxis) : target.frame.xAxis,
  );
  const alternate = V.perp(preferred);
  const ep = extentAlong(preferred);
  const ea = extentAlong(alternate);
  const dir = ep.max - ep.min <= (ea.max - ea.min) * 1.6 ? preferred : alternate;

  const { min: minT, max: maxT } = extentAlong(dir);
  const span = Math.max(0.5, maxT - minT);
  // Backstop for the plans that are long in every direction.
  const pitch = Math.min(spec.roofPitch, MAX_SHED_RISE / span);
  const heightAt = (p: Vec2) => eaveY + (V.dot(p, dir) - minT) * pitch;

  const inv = 1 / Math.hypot(pitch, 1);
  buf.pushLiftedCap(envelope, heightAt, {
    x: -dir.x * pitch * inv,
    y: inv,
    z: -dir.y * pitch * inv,
  });
  // Underside of the slab, then the band that closes the two together and fills
  // the triangular gaps above the walls on the sides and at the high end.
  buf.pushLiftedCap(
    envelope,
    (p) => heightAt(p) - FASCIA,
    { x: dir.x * pitch * inv, y: -inv, z: dir.y * pitch * inv },
    false,
  );
  buf.pushSkirt(envelope, eaveY - FASCIA, heightAt, 0.02);
  return { peak: span * pitch, deck: 0, envelope };
}

/** 切妻 / 寄棟, built per constituent rectangle. */
function buildPitchedRoof(
  buf: GeometryBuffer,
  target: RoofTarget,
  eaveY: number,
  spec: BuildingSpec,
  roofType: 'gable' | 'hip',
): RoofResult {
  const frame = target.frame;
  const poly = target.polygon;
  const envelope = offsetOutward(poly, spec.eaves)[0] ?? poly;
  // `cut` now means what its name says. The old test — the *lot* clip fraction —
  // could never see a slant cut, so a roof built over a shrunken top floor was
  // never clipped back and floated several metres past the walls on every side.
  const heavyClip = target.cut;
  let peak = 0;

  for (const part of target.parts) {
    const r = expandRect(part, spec.eaves);
    // Ridge runs along the longer side by default; ridgeAlongStreet flips it to
    // run parallel to the street (平入り) instead of into it (妻入り).
    const ridgeAlongX = spec.ridgeAlongStreet ? r.w >= r.d * 0.6 : r.w >= r.d;
    const halfSpan = (ridgeAlongX ? r.d : r.w) / 2;
    const rise = halfSpan * spec.roofPitch;
    peak = Math.max(peak, rise);

    const faces =
      roofType === 'gable' ? gableFaces(r, ridgeAlongX, rise) : hipFaces(r, ridgeAlongX, rise);

    for (const face of faces) {
      const world = polyToWorld(face.poly, frame);
      const heightAt = (p: Vec2) => eaveY + face.heightAt(toLocal(p, frame));
      const n = worldNormal(face.grad, frame);
      const down = { x: -n.x, y: -n.y, z: -n.z };

      const targets = heavyClip ? intersectPoly([world], [envelope]) : [world];
      for (const t of targets) {
        buf.pushLiftedCap(t, heightAt, n);
        buf.pushLiftedCap(t, (p) => heightAt(p) - FASCIA, down, false);
        buf.pushSkirt(t, eaveY - FASCIA, heightAt, 0.02);
      }
    }

    // Gable ends: vertical triangles closing the volume between the two slopes.
    if (roofType === 'gable') {
      for (const tri of gableEndTriangles(r, ridgeAlongX, rise)) {
        const a = toWorld(tri[0], frame);
        const b = toWorld(tri[1], frame);
        const c = toWorld(tri[2], frame);
        buf.pushWorldTriangle(
          { x: a.x, y: eaveY, z: a.y },
          { x: b.x, y: eaveY, z: b.y },
          { x: c.x, y: eaveY + rise, z: c.y },
        );
      }
    }
  }

  return { peak, deck: 0, envelope };
}

interface RoofFace {
  /** Local-frame plan polygon. */
  poly: Polygon;
  /** Height above the eave line at a local-frame point. */
  heightAt(p: Vec2): number;
  /** Local-frame gradient (du, dv) of the height function. */
  grad: Vec2;
}

function gableFaces(r: LocalRect, ridgeAlongX: boolean, rise: number): RoofFace[] {
  const hw = r.w / 2;
  const hd = r.d / 2;

  if (ridgeAlongX) {
    const pitch = rise / hd;
    return [
      {
        poly: [
          { x: r.cx - hw, y: r.cy - hd },
          { x: r.cx + hw, y: r.cy - hd },
          { x: r.cx + hw, y: r.cy },
          { x: r.cx - hw, y: r.cy },
        ],
        heightAt: (p) => (p.y - (r.cy - hd)) * pitch,
        grad: { x: 0, y: pitch },
      },
      {
        poly: [
          { x: r.cx - hw, y: r.cy },
          { x: r.cx + hw, y: r.cy },
          { x: r.cx + hw, y: r.cy + hd },
          { x: r.cx - hw, y: r.cy + hd },
        ],
        heightAt: (p) => (r.cy + hd - p.y) * pitch,
        grad: { x: 0, y: -pitch },
      },
    ];
  }

  const pitch = rise / hw;
  return [
    {
      poly: [
        { x: r.cx - hw, y: r.cy - hd },
        { x: r.cx, y: r.cy - hd },
        { x: r.cx, y: r.cy + hd },
        { x: r.cx - hw, y: r.cy + hd },
      ],
      heightAt: (p) => (p.x - (r.cx - hw)) * pitch,
      grad: { x: pitch, y: 0 },
    },
    {
      poly: [
        { x: r.cx, y: r.cy - hd },
        { x: r.cx + hw, y: r.cy - hd },
        { x: r.cx + hw, y: r.cy + hd },
        { x: r.cx, y: r.cy + hd },
      ],
      heightAt: (p) => (r.cx + hw - p.x) * pitch,
      grad: { x: -pitch, y: 0 },
    },
  ];
}

/** 寄棟: two trapezoids and two hip triangles, all sloping from the eave line. */
function hipFaces(r: LocalRect, ridgeAlongX: boolean, rise: number): RoofFace[] {
  const hw = r.w / 2;
  const hd = r.d / 2;
  const faces: RoofFace[] = [];

  if (ridgeAlongX) {
    const pitch = rise / hd;
    // Inset the ridge by the half span at each end so the hips run at 45°.
    const inset = Math.min(hw * 0.85, hd);
    const rA: Vec2 = { x: r.cx - hw + inset, y: r.cy };
    const rB: Vec2 = { x: r.cx + hw - inset, y: r.cy };
    faces.push({
      poly: [{ x: r.cx - hw, y: r.cy - hd }, { x: r.cx + hw, y: r.cy - hd }, rB, rA],
      heightAt: (p) => (p.y - (r.cy - hd)) * pitch,
      grad: { x: 0, y: pitch },
    });
    faces.push({
      poly: [rA, rB, { x: r.cx + hw, y: r.cy + hd }, { x: r.cx - hw, y: r.cy + hd }],
      heightAt: (p) => (r.cy + hd - p.y) * pitch,
      grad: { x: 0, y: -pitch },
    });
    const endPitch = rise / inset;
    faces.push({
      poly: [{ x: r.cx - hw, y: r.cy + hd }, { x: r.cx - hw, y: r.cy - hd }, rA],
      heightAt: (p) => (p.x - (r.cx - hw)) * endPitch,
      grad: { x: endPitch, y: 0 },
    });
    faces.push({
      poly: [{ x: r.cx + hw, y: r.cy - hd }, { x: r.cx + hw, y: r.cy + hd }, rB],
      heightAt: (p) => (r.cx + hw - p.x) * endPitch,
      grad: { x: -endPitch, y: 0 },
    });
    return faces;
  }

  const pitch = rise / hw;
  const inset = Math.min(hd * 0.85, hw);
  const rA: Vec2 = { x: r.cx, y: r.cy - hd + inset };
  const rB: Vec2 = { x: r.cx, y: r.cy + hd - inset };
  faces.push({
    poly: [{ x: r.cx - hw, y: r.cy - hd }, rA, rB, { x: r.cx - hw, y: r.cy + hd }],
    heightAt: (p) => (p.x - (r.cx - hw)) * pitch,
    grad: { x: pitch, y: 0 },
  });
  faces.push({
    poly: [rA, { x: r.cx + hw, y: r.cy - hd }, { x: r.cx + hw, y: r.cy + hd }, rB],
    heightAt: (p) => (r.cx + hw - p.x) * pitch,
    grad: { x: -pitch, y: 0 },
  });
  const endPitch = rise / inset;
  faces.push({
    poly: [{ x: r.cx - hw, y: r.cy - hd }, { x: r.cx + hw, y: r.cy - hd }, rA],
    heightAt: (p) => (p.y - (r.cy - hd)) * endPitch,
    grad: { x: 0, y: endPitch },
  });
  faces.push({
    poly: [{ x: r.cx + hw, y: r.cy + hd }, { x: r.cx - hw, y: r.cy + hd }, rB],
    heightAt: (p) => (r.cy + hd - p.y) * endPitch,
    grad: { x: 0, y: -endPitch },
  });
  return faces;
}

/** The two triangular walls closing each end of a gable, in local coordinates. */
function gableEndTriangles(r: LocalRect, ridgeAlongX: boolean, rise: number): [Vec2, Vec2, Vec2][] {
  const hw = r.w / 2;
  const hd = r.d / 2;
  void rise;
  if (ridgeAlongX) {
    // Ridge runs along local x; the ends are the two faces at x = cx ± hw.
    return [
      [
        { x: r.cx - hw, y: r.cy - hd },
        { x: r.cx - hw, y: r.cy + hd },
        { x: r.cx - hw, y: r.cy },
      ],
      [
        { x: r.cx + hw, y: r.cy + hd },
        { x: r.cx + hw, y: r.cy - hd },
        { x: r.cx + hw, y: r.cy },
      ],
    ];
  }
  return [
    [
      { x: r.cx - hw, y: r.cy - hd },
      { x: r.cx + hw, y: r.cy - hd },
      { x: r.cx, y: r.cy - hd },
    ],
    [
      { x: r.cx + hw, y: r.cy + hd },
      { x: r.cx - hw, y: r.cy + hd },
      { x: r.cx, y: r.cy + hd },
    ],
  ];
}

/** Convert a local-frame height gradient into a world-space unit normal. */
function worldNormal(grad: Vec2, frame: Frame): { x: number; y: number; z: number } {
  const ax = frame.xAxis;
  const ay = V.perp(ax);
  const gx = grad.x * ax.x + grad.y * ay.x;
  const gz = grad.x * ax.y + grad.y * ay.y;
  const l = Math.hypot(gx, gz, 1);
  return { x: -gx / l, y: 1 / l, z: -gz / l };
}
