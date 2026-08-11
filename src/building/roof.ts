import type { Polygon, Vec2 } from '../core/types.js';
import * as V from '../geom/vec2.js';
import { intersectPoly } from '../geom/boolean.js';
import { offsetOutward } from '../geom/offset.js';
import { expandRect, polyToWorld, toLocal, toWorld, type Frame, type LocalRect } from '../geom/obb.js';
import type { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { BuildingSpec, Footprint } from './types.js';

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
  /** Plan polygon of the eaves, for props that need to avoid the overhang. */
  envelope: Polygon;
}

const FASCIA = 0.22;

export function buildRoof(
  buf: GeometryBuffer,
  footprint: Footprint,
  topPolygon: Polygon,
  eaveY: number,
  spec: BuildingSpec,
): RoofResult {
  switch (spec.roofType) {
    case 'flat':
      return buildFlatRoof(buf, topPolygon, eaveY, spec);
    case 'shed':
      return buildShedRoof(buf, footprint, topPolygon, eaveY, spec);
    case 'gable':
    case 'hip':
      return buildPitchedRoof(buf, footprint, topPolygon, eaveY, spec);
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
  return { peak: spec.parapetHeight, envelope: ring };
}

/** 片流れ: a single plane. Exact on any polygon — height is affine in (x, z). */
function buildShedRoof(
  buf: GeometryBuffer,
  footprint: Footprint,
  poly: Polygon,
  eaveY: number,
  spec: BuildingSpec,
): RoofResult {
  const envelope = offsetOutward(poly, spec.eaves)[0] ?? poly;
  const axis = spec.ridgeAlongStreet ? V.perp(footprint.frame.xAxis) : footprint.frame.xAxis;
  const dir = V.normalize(axis);

  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of envelope) {
    const t = V.dot(p, dir);
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  const span = Math.max(0.5, maxT - minT);
  const heightAt = (p: Vec2) => eaveY + (V.dot(p, dir) - minT) * spec.roofPitch;

  const inv = 1 / Math.hypot(spec.roofPitch, 1);
  buf.pushLiftedCap(envelope, heightAt, {
    x: -dir.x * spec.roofPitch * inv,
    y: inv,
    z: -dir.y * spec.roofPitch * inv,
  });
  // Underside of the slab, then the band that closes the two together and fills
  // the triangular gaps above the walls on the sides and at the high end.
  buf.pushLiftedCap(
    envelope,
    (p) => heightAt(p) - FASCIA,
    { x: dir.x * spec.roofPitch * inv, y: -inv, z: dir.y * spec.roofPitch * inv },
    false,
  );
  buf.pushSkirt(envelope, eaveY - FASCIA, heightAt, 0.02);
  return { peak: span * spec.roofPitch, envelope };
}

/** 切妻 / 寄棟, built per constituent rectangle. */
function buildPitchedRoof(
  buf: GeometryBuffer,
  footprint: Footprint,
  poly: Polygon,
  eaveY: number,
  spec: BuildingSpec,
): RoofResult {
  const frame = footprint.frame;
  const envelope = offsetOutward(poly, spec.eaves)[0] ?? poly;
  const heavyClip = footprint.clippedFraction > 0.015;
  let peak = 0;

  for (const part of footprint.parts) {
    const r = expandRect(part, spec.eaves);
    // Ridge runs along the longer side by default; ridgeAlongStreet flips it to
    // run parallel to the street (平入り) instead of into it (妻入り).
    const ridgeAlongX = spec.ridgeAlongStreet ? r.w >= r.d * 0.6 : r.w >= r.d;
    const halfSpan = (ridgeAlongX ? r.d : r.w) / 2;
    const rise = halfSpan * spec.roofPitch;
    peak = Math.max(peak, rise);

    const faces = spec.roofType === 'gable'
      ? gableFaces(r, ridgeAlongX, rise)
      : hipFaces(r, ridgeAlongX, rise);

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
    if (spec.roofType === 'gable') {
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

  return { peak, envelope };
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
