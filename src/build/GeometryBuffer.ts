import * as THREE from 'three';
import type { Polygon, Vec2 } from '../core/types.js';
import { ensureCCW } from '../geom/polygon.js';

/**
 * A typed-array accumulator that every geometry builder writes into.
 *
 * Allocating a `BufferGeometry` per wall panel would mean thousands of GC events
 * for a 1,700-building city; instead each building fills one of these and the
 * chunk merger concatenates them. Normals are written analytically by the
 * builders — `computeVertexNormals()` is never called on city-scale geometry.
 */
export class GeometryBuffer {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  /** Colour applied to subsequently pushed vertices. */
  private cr = 1;
  private cg = 1;
  private cb = 1;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  setColor(c: THREE.Color | { r: number; g: number; b: number }): this {
    this.cr = c.r;
    this.cg = c.g;
    this.cb = c.b;
    return this;
  }

  /** Multiply the current colour — used for the vertex-colour weathering pass. */
  withShade(shade: number, fn: () => void): void {
    const r = this.cr;
    const g = this.cg;
    const b = this.cb;
    this.cr = r * shade;
    this.cg = g * shade;
    this.cb = b * shade;
    fn();
    this.cr = r;
    this.cg = g;
    this.cb = b;
  }

  private vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.cr, this.cg, this.cb);
    return i;
  }

  /**
   * A quad in counter-clockwise order when viewed from the front face.
   * UVs default to metre-scaled coordinates derived from the edge lengths, so a
   * texture with `repeat` set in metres tiles correctly on any face size.
   */
  pushQuad(
    a: THREE.Vector3Like,
    b: THREE.Vector3Like,
    c: THREE.Vector3Like,
    d: THREE.Vector3Like,
    normal?: THREE.Vector3Like,
    uvs?: [number, number][],
  ): void {
    let n = normal;
    if (!n) {
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const uz = b.z - a.z;
      const vx = d.x - a.x;
      const vy = d.y - a.y;
      const vz = d.z - a.z;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      n = { x: nx / l, y: ny / l, z: nz / l };
    }
    const w = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const h = Math.hypot(d.x - a.x, d.y - a.y, d.z - a.z);
    const t = uvs ?? ([[0, 0], [w, 0], [w, h], [0, h]] as [number, number][]);

    const i0 = this.vertex(a.x, a.y, a.z, n.x, n.y, n.z, t[0]![0], t[0]![1]);
    const i1 = this.vertex(b.x, b.y, b.z, n.x, n.y, n.z, t[1]![0], t[1]![1]);
    const i2 = this.vertex(c.x, c.y, c.z, n.x, n.y, n.z, t[2]![0], t[2]![1]);
    const i3 = this.vertex(d.x, d.y, d.z, n.x, n.y, n.z, t[3]![0], t[3]![1]);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  pushTriangle(
    a: THREE.Vector3Like,
    b: THREE.Vector3Like,
    c: THREE.Vector3Like,
    normal?: THREE.Vector3Like,
    uvs?: [number, number][],
  ): void {
    let n = normal;
    if (!n) {
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const uz = b.z - a.z;
      const vx = c.x - a.x;
      const vy = c.y - a.y;
      const vz = c.z - a.z;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      n = { x: nx / l, y: ny / l, z: nz / l };
    }
    const t = uvs ?? ([[0, 0], [1, 0], [0, 1]] as [number, number][]);
    const i0 = this.vertex(a.x, a.y, a.z, n.x, n.y, n.z, t[0]![0], t[0]![1]);
    const i1 = this.vertex(b.x, b.y, b.z, n.x, n.y, n.z, t[1]![0], t[1]![1]);
    const i2 = this.vertex(c.x, c.y, c.z, n.x, n.y, n.z, t[2]![0], t[2]![1]);
    this.idx.push(i0, i1, i2);
  }

  /** Axis-aligned box given centre and size. */
  pushBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const p = (x: number, y: number, z: number) => ({ x, y, z });
    this.pushQuad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), { x: 0, y: 0, z: 1 });
    this.pushQuad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), { x: 0, y: 0, z: -1 });
    this.pushQuad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), { x: 1, y: 0, z: 0 });
    this.pushQuad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), { x: -1, y: 0, z: 0 });
    this.pushQuad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0), { x: 0, y: 1, z: 0 });
    this.pushQuad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), { x: 0, y: -1, z: 0 });
  }

  /**
   * A box oriented in plan: centred at (cx, cz) with in-plane axis `dir`,
   * width `w` across `dir`, depth `d` along `dir`, from `y0` to `y1`.
   */
  pushOrientedBox(
    cx: number,
    cz: number,
    dir: Vec2,
    w: number,
    d: number,
    y0: number,
    y1: number,
  ): void {
    const ux = dir.x;
    const uz = dir.y;
    const vx = -uz;
    const vz = ux;
    const hw = w / 2;
    const hd = d / 2;
    const corner = (sw: number, sd: number) => ({
      x: cx + vx * sw * hw + ux * sd * hd,
      z: cz + vz * sw * hw + uz * sd * hd,
    });
    const c00 = corner(-1, -1);
    const c10 = corner(1, -1);
    const c11 = corner(1, 1);
    const c01 = corner(-1, 1);
    this.pushPrism([
      { x: c00.x, y: c00.z },
      { x: c10.x, y: c10.z },
      { x: c11.x, y: c11.z },
      { x: c01.x, y: c01.z },
    ], y0, y1, true, true);
  }

  /**
   * Extrude a CCW plan polygon between two heights. Walls get wall-local UVs
   * (u = distance along the wall, v = height) so textures do not stretch.
   */
  pushPrism(input: Polygon, y0: number, y1: number, cap = true, floor = false): void {
    // Winding is load-bearing here: outward-facing walls depend on a CCW ring,
    // and callers build rings from all sorts of places.
    const poly = ensureCCW(input);
    const n = poly.length;
    if (n < 3) return;

    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      // Plan coordinates map to world as (x, height, y). Viewed from above that
      // flips handedness, so a CCW plan ring's outward normal is (dz, 0, -dx)
      // and the quad must run bottom-a, top-a, top-b, bottom-b to wind CCW
      // when seen from outside.
      const nx = dz / l;
      const nz = -dx / l;
      this.pushQuad(
        { x: a.x, y: y0, z: a.y },
        { x: a.x, y: y1, z: a.y },
        { x: b.x, y: y1, z: b.y },
        { x: b.x, y: y0, z: b.y },
        { x: nx, y: 0, z: nz },
        [
          [0, y0],
          [0, y1],
          [l, y1],
          [l, y0],
        ],
      );
    }

    if (cap) this.pushCap(poly, y1, true);
    if (floor) this.pushCap(poly, y0, false);
  }

  /**
   * A single outward-facing wall quad between two plan points. Used by the
   * façade builder, which needs per-wall control rather than a whole prism.
   */
  pushWallQuad(a: Vec2, b: Vec2, y0: number, y1: number, uOffset = 0): void {
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6 || y1 <= y0) return;
    this.pushQuad(
      { x: a.x, y: y0, z: a.y },
      { x: a.x, y: y1, z: a.y },
      { x: b.x, y: y1, z: b.y },
      { x: b.x, y: y0, z: b.y },
      { x: dz / l, y: 0, z: -dx / l },
      [
        [uOffset, y0],
        [uOffset, y1],
        [uOffset + l, y1],
        [uOffset + l, y0],
      ],
    );
  }

  /**
   * Walls from a flat base up to a varying top, given by a height function.
   * Closes the gap between a wall top and a sloping roof plane — the gable ends
   * and shed-roof sides come out of this for free.
   */
  pushSkirt(input: Polygon, y0: number, topAt: (p: Vec2) => number, minGap = 0.01): void {
    const poly = ensureCCW(input);
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const ya = topAt(a);
      const yb = topAt(b);
      if (ya - y0 < minGap && yb - y0 < minGap) continue;
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) continue;
      const nrm = { x: dz / l, y: 0, z: -dx / l };
      this.pushQuad(
        { x: a.x, y: y0, z: a.y },
        { x: a.x, y: Math.max(y0, ya), z: a.y },
        { x: b.x, y: Math.max(y0, yb), z: b.y },
        { x: b.x, y: y0, z: b.y },
        nrm,
        [
          [0, y0],
          [0, Math.max(y0, ya)],
          [l, Math.max(y0, yb)],
          [l, y0],
        ],
      );
    }
  }

  /** A single triangle given in world space, both faces implied by the winding. */
  pushWorldTriangle(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like): void {
    this.pushTriangle(a, b, c);
    this.pushTriangle(c, b, a);
  }

  /** Triangulate a plan polygon at a fixed height. `up` picks the facing. */
  pushCap(poly: Polygon, y: number, up = true): void {
    const tris = triangulate(poly);
    const n = up ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 };
    for (const [a, b, c] of tris) {
      const pa = { x: a.x, y, z: a.y };
      const pb = { x: b.x, y, z: b.y };
      const pc = { x: c.x, y, z: c.y };
      // A CCW ring in XZ is clockwise when seen from above, so flip for up-facing.
      if (up) this.pushTriangle(pc, pb, pa, n, [[c.x, c.y], [b.x, b.y], [a.x, a.y]]);
      else this.pushTriangle(pa, pb, pc, n, [[a.x, a.y], [b.x, b.y], [c.x, c.y]]);
    }
  }

  /**
   * A plan polygon whose vertices are lifted by an arbitrary height function.
   * Valid for any planar height function — which is exactly what shed and
   * gable roof faces are.
   */
  pushLiftedCap(
    poly: Polygon,
    heightAt: (p: Vec2) => number,
    normal: THREE.Vector3Like,
    up = true,
  ): void {
    const tris = triangulate(poly);
    for (const [a, b, c] of tris) {
      const pa = { x: a.x, y: heightAt(a), z: a.y };
      const pb = { x: b.x, y: heightAt(b), z: b.y };
      const pc = { x: c.x, y: heightAt(c), z: c.y };
      // A CCW plan ring is clockwise seen from above, so up-facing needs the
      // reversed order.
      if (up) this.pushTriangle(pc, pb, pa, normal, [[c.x, c.y], [b.x, b.y], [a.x, a.y]]);
      else this.pushTriangle(pa, pb, pc, normal, [[a.x, a.y], [b.x, b.y], [c.x, c.y]]);
    }
  }

  /** Append another buffer's contents, optionally offset in world space. */
  append(other: GeometryBuffer, dx = 0, dy = 0, dz = 0): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < other.pos.length; i += 3) {
      this.pos.push(other.pos[i]! + dx, other.pos[i + 1]! + dy, other.pos[i + 2]! + dz);
    }
    this.nrm.push(...other.nrm);
    this.uv.push(...other.uv);
    this.col.push(...other.col);
    for (const i of other.idx) this.idx.push(i + base);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Ear-clipping via three's bundled Earcut. Returns triangles as vertex triples
 * in plan coordinates.
 */
export function triangulate(poly: Polygon): [Vec2, Vec2, Vec2][] {
  if (poly.length < 3) return [];
  if (poly.length === 3) return [[poly[0]!, poly[1]!, poly[2]!]];
  const contour = poly.map((p) => new THREE.Vector2(p.x, p.y));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return [];
  }
  const out: [Vec2, Vec2, Vec2][] = [];
  for (const f of faces) {
    const a = poly[f[0]!];
    const b = poly[f[1]!];
    const c = poly[f[2]!];
    if (a && b && c) out.push([a, b, c]);
  }
  return out;
}
