import * as THREE from 'three';
import type { Vec2 } from '../core/types.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import { ChunkedMeshBuilder } from '../build/MeshMerger.js';
import type { MaterialLibrary } from '../material/materials.js';
import type { Terrain } from './Terrain.js';

/**
 * The land, as triangles.
 *
 * Replaces the single 1,240 m `PlaneGeometry` the town used to stand on. Three
 * things it has to get right, none of them obvious until they are wrong:
 *
 * **Chunked.** One mesh of a hundred thousand triangles would be the only piece
 * of geometry in the project outside the 64 m chunk scheme, and it would defeat
 * frustum culling for the whole scene — you would pay for the far side of the
 * valley while standing in a garden. It goes through `ChunkedMeshBuilder` like
 * everything else.
 *
 * **Smooth-shaded.** Per-vertex normals from the field's own gradient. Faceted
 * shading is right for a building and catastrophic for a hillside.
 *
 * **Coloured by what it is.** An untinted heightfield reads as a bedsheet. Flat
 * low ground keeps the old olive-grey; anything steep goes browner and drier,
 * because that is what a cut face or a scarp looks like and it is what tells the
 * eye that the 擁壁 further down is holding something back.
 */

/** Chunk pitch for the ground, in grid cells. Matches MeshMerger's 64 m. */
const CHUNK_CELLS = 16;

const GRASS = { r: 0.46, g: 0.48, b: 0.38 };
const DRY = { r: 0.44, g: 0.39, b: 0.31 };
const ROCK = { r: 0.4, g: 0.37, b: 0.34 };
const SILT = { r: 0.35, g: 0.35, b: 0.3 };

function mix(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  const k = Math.min(1, Math.max(0, t));
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

export function buildTerrainMesh(terrain: Terrain, materials: MaterialLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  const field = terrain.field;
  if (!field) return group;

  const chunks = new ChunkedMeshBuilder();

  // Normals and colours are precomputed once per grid *node*, not per quad
  // corner. Each node is shared by four quads, and the colour needs a distance
  // to the river — an O(spans) query. Computing them inline cost four gradients
  // and four river scans per quad, which turned a two-second build into twenty.
  const count = field.nx * field.ny;
  const nrm = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let iy = 0; iy < field.ny; iy++) {
    for (let ix = 0; ix < field.nx; ix++) {
      const i = iy * field.nx + ix;
      const p = field.posOf(ix, iy);
      const g = field.gradient(p.x, p.y);
      // Plan (x, y) maps to world (x, h, y), so the surface normal is
      // (-dh/dx, 1, -dh/dy) normalised.
      const l = Math.hypot(g.x, 1, g.y) || 1;
      nrm[i * 3] = -g.x / l;
      nrm[i * 3 + 1] = 1 / l;
      nrm[i * 3 + 2] = -g.y / l;

      const slope = Math.hypot(g.x, g.y);
      // Steep ground first: a scarp face or a cut is bare, whatever height it
      // is — and it is the cue that tells the eye a wall further down is
      // holding something back.
      let c = mix(GRASS, DRY, (slope - 0.16) / 0.34);
      c = mix(c, ROCK, (slope - 0.6) / 0.6);
      // Then the valley floor, which is silt rather than grass.
      const w = terrain.waterDistance(p);
      if (w < 40) c = mix(c, SILT, (40 - w) / 55);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
  }
  const normalOf = (ix: number, iy: number): THREE.Vector3Like => {
    const i = (iy * field.nx + ix) * 3;
    return { x: nrm[i]!, y: nrm[i + 1]!, z: nrm[i + 2]! };
  };
  const colourOf = (ix: number, iy: number) => {
    const i = (iy * field.nx + ix) * 3;
    return { r: col[i]!, g: col[i + 1]!, b: col[i + 2]! };
  };

  // Walk the grid in chunk-sized tiles so each chunk's triangles are contiguous
  // and the merger has nothing to sort.
  for (let cy = 0; cy + 1 < field.ny; cy += CHUNK_CELLS) {
    for (let cx = 0; cx + 1 < field.nx; cx += CHUNK_CELLS) {
      const buf = new GeometryBuffer();
      const x1 = Math.min(field.nx - 1, cx + CHUNK_CELLS);
      const y1 = Math.min(field.ny - 1, cy + CHUNK_CELLS);

      for (let iy = cy; iy < y1; iy++) {
        for (let ix = cx; ix < x1; ix++) {
          const p00 = field.posOf(ix, iy);
          const p10 = field.posOf(ix + 1, iy);
          const p11 = field.posOf(ix + 1, iy + 1);
          const p01 = field.posOf(ix, iy + 1);
          const h00 = field.raw(ix, iy);
          const h10 = field.raw(ix + 1, iy);
          const h11 = field.raw(ix + 1, iy + 1);
          const h01 = field.raw(ix, iy + 1);

          const v = (p: Vec2, h: number) => ({ x: p.x, y: h, z: p.y });
          const n00 = normalOf(ix, iy);
          const n10 = normalOf(ix + 1, iy);
          const n11 = normalOf(ix + 1, iy + 1);
          const n01 = normalOf(ix, iy + 1);
          const uv = (p: Vec2): [number, number] => [p.x, p.y];

          // Split the quad along the shorter diagonal. On a scarp the two
          // diagonals differ by metres, and taking the wrong one puts a visible
          // crease running diagonally across an otherwise straight cliff.
          const flip = Math.abs(h00 - h11) > Math.abs(h10 - h01);

          // Wound backwards on purpose. Plan (x, y) maps to world (x, h, y),
          // which flips handedness — a ring that reads anticlockwise on the grid
          // is clockwise seen from above, and so faces *down*. `pushCap` carries
          // the same reversal for the same reason; getting it wrong here means
          // the entire landscape is culled and the town appears to float over an
          // empty sky, which is exactly as confusing as it sounds.
          buf.setColor(colourOf(ix, iy));
          if (flip) {
            buf.pushTriangleN(v(p01, h01), v(p10, h10), v(p00, h00), n01, n10, n00, [
              uv(p01),
              uv(p10),
              uv(p00),
            ]);
            buf.pushTriangleN(v(p01, h01), v(p11, h11), v(p10, h10), n01, n11, n10, [
              uv(p01),
              uv(p11),
              uv(p10),
            ]);
          } else {
            buf.pushTriangleN(v(p11, h11), v(p10, h10), v(p00, h00), n11, n10, n00, [
              uv(p11),
              uv(p10),
              uv(p00),
            ]);
            buf.pushTriangleN(v(p01, h01), v(p11, h11), v(p00, h00), n01, n11, n00, [
              uv(p01),
              uv(p11),
              uv(p00),
            ]);
          }
        }
      }
      if (buf.isEmpty) continue;
      const centre = field.posOf(cx + CHUNK_CELLS / 2, cy + CHUNK_CELLS / 2);
      chunks.add(centre, { ground: buf });
    }
  }

  group.add(chunks.build(materials));

  // The skirt: the outermost ring dropped away, so the world does not end in a
  // visible edge with sky under it. This is the job the old `extent + 300`
  // ground plane was doing.
  const skirt = new GeometryBuffer();
  skirt.setColor(mix(GRASS, ROCK, 0.4));
  const edge: [number, number][] = [];
  for (let ix = 0; ix < field.nx; ix++) edge.push([ix, 0]);
  for (let iy = 0; iy < field.ny; iy++) edge.push([field.nx - 1, iy]);
  for (let ix = field.nx - 1; ix >= 0; ix--) edge.push([ix, field.ny - 1]);
  for (let iy = field.ny - 1; iy >= 0; iy--) edge.push([0, iy]);
  for (let i = 0; i + 1 < edge.length; i++) {
    const [ax, ay] = edge[i]!;
    const [bx, by] = edge[i + 1]!;
    if (ax === bx && ay === by) continue;
    const pa = field.posOf(ax, ay);
    const pb = field.posOf(bx, by);
    const ha = field.raw(ax, ay);
    const hb = field.raw(bx, by);
    skirt.pushQuad(
      { x: pa.x, y: ha, z: pa.y },
      { x: pb.x, y: hb, z: pb.y },
      { x: pb.x, y: hb - 40, z: pb.y },
      { x: pa.x, y: ha - 40, z: pa.y },
    );
  }
  if (!skirt.isEmpty) {
    const mesh = new THREE.Mesh(skirt.toGeometry(), materials.materials.ground);
    mesh.name = 'terrain:skirt';
    group.add(mesh);
  }

  // Water. A separate flat-ish surface following the monotone level profile —
  // the bed is already carved beneath it, so nothing else is needed to make the
  // river sit in something.
  const river = terrain.river;
  if (river) {
    const water = new GeometryBuffer();
    water.setColor({ r: 1, g: 1, b: 1 });
    const half = river.params.width / 2;
    for (let i = 0; i + 1 < river.centre.length; i++) {
      const a = river.centre[i]!;
      const b = river.centre[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      const ya = river.water[i]!;
      const yb = river.water[i + 1]!;
      const up = { x: 0, y: 1, z: 0 };
      water.pushQuad(
        { x: a.x - nx * half, y: ya, z: a.y - ny * half },
        { x: b.x - nx * half, y: yb, z: b.y - ny * half },
        { x: b.x + nx * half, y: yb, z: b.y + ny * half },
        { x: a.x + nx * half, y: ya, z: a.y + ny * half },
        up,
      );
    }
    const mesh = new THREE.Mesh(water.toGeometry(), materials.materials.water);
    mesh.name = 'terrain:water';
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}
