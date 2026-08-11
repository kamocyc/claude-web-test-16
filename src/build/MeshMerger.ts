import * as THREE from 'three';
import type { Vec2 } from '../core/types.js';
import { GeometryBuffer } from './GeometryBuffer.js';
import type { MaterialFamily, MaterialLibrary } from '../material/materials.js';

/**
 * Spatial chunking and merging.
 *
 * Buildings are individually unique, so instancing them would defeat the point;
 * instead each building's per-material buffers are concatenated into 64 m
 * chunks. With about five material families in play and most chunks using three
 * of them, the whole city comes out in a few hundred draw calls instead of one
 * per building.
 */

export const CHUNK_SIZE = 64;

type ChunkKey = string;

export class ChunkedMeshBuilder {
  private chunks = new Map<ChunkKey, Partial<Record<MaterialFamily, GeometryBuffer>>>();

  private keyOf(p: Vec2): ChunkKey {
    return `${Math.floor(p.x / CHUNK_SIZE)},${Math.floor(p.y / CHUNK_SIZE)}`;
  }

  /** Add one object's buffers, binned by a representative position. */
  add(at: Vec2, buffers: Partial<Record<MaterialFamily, GeometryBuffer>>): void {
    const key = this.keyOf(at);
    let chunk = this.chunks.get(key);
    if (!chunk) this.chunks.set(key, (chunk = {}));
    for (const [family, buf] of Object.entries(buffers) as [MaterialFamily, GeometryBuffer][]) {
      if (!buf || buf.isEmpty) continue;
      let target = chunk[family];
      if (!target) chunk[family] = target = new GeometryBuffer();
      target.append(buf);
    }
  }

  /** Build the merged meshes into a group. */
  build(materials: MaterialLibrary, castShadow = true, receiveShadow = true): THREE.Group {
    const group = new THREE.Group();
    group.name = 'city-chunks';

    for (const [key, chunk] of this.chunks) {
      for (const [family, buf] of Object.entries(chunk) as [MaterialFamily, GeometryBuffer][]) {
        if (!buf || buf.isEmpty) continue;
        const mesh = new THREE.Mesh(buf.toGeometry(), materials.materials[family]);
        mesh.name = `${key}/${family}`;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        group.add(mesh);
      }
    }
    return group;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get meshCount(): number {
    let n = 0;
    for (const chunk of this.chunks.values()) {
      for (const buf of Object.values(chunk)) if (buf && !buf.isEmpty) n++;
    }
    return n;
  }

  get triangleCount(): number {
    let n = 0;
    for (const chunk of this.chunks.values()) {
      for (const buf of Object.values(chunk)) if (buf) n += buf.triangleCount;
    }
    return n;
  }
}
