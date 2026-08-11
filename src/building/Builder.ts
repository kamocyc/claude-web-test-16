import type { BuildingParams } from '../core/params.js';
import { makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { area } from '../geom/polygon.js';
import type { Lot } from '../city/Lots.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { MaterialFamily } from '../material/materials.js';
import { groundGrime } from '../material/palettes.js';
import { computeEnvelope, fitFootprint } from './footprint.js';
import { buildMass } from './mass.js';
import { buildRoof } from './roof.js';
import { buildFacades, type FacadeBuffers } from './facade.js';
import { buildCorridorAndStairs } from './details/corridor.js';
import { buildRooftopPlant } from './details/penthouse.js';
import { buildLaundry } from './details/laundry.js';
import type { BuildingSpec, Footprint, BuildingMass, BuildEnvelope } from './types.js';

/** Geometry accumulated per material family for one building. */
export type BufferSet = Partial<Record<MaterialFamily, GeometryBuffer>>;

export interface BuiltBuilding {
  lot: Lot;
  spec: BuildingSpec;
  envelope: BuildEnvelope;
  footprint: Footprint;
  mass: BuildingMass;
  buffers: BufferSet;
  triangles: number;
}

export function bufferFor(set: BufferSet, family: MaterialFamily): GeometryBuffer {
  let b = set[family];
  if (!b) set[family] = b = new GeometryBuffer();
  return b;
}

/**
 * envelope -> footprint -> mass -> roof -> façade -> details, written into
 * per-material geometry buffers ready for chunk merging.
 */
export function buildBuilding(
  lot: Lot,
  spec: BuildingSpec,
  params: BuildingParams,
): BuiltBuilding | null {
  const envelope = computeEnvelope(lot, spec, params);
  if (!envelope.buildable) return null;

  const footprint = fitFootprint(lot, envelope, spec, params);
  if (!footprint) return null;

  // Mirroring doubles apparent variety at zero cost. Applied by flipping the
  // façade seed rather than the geometry, which keeps the building facing the
  // street while genuinely rearranging its openings.
  const facadeSeed = spec.mirrored ? subSeed(lot.seed, 'mirror') : lot.seed;

  const mass = buildMass(footprint, envelope, spec, lot.area);
  const buffers: BufferSet = {};

  const wallBuf = bufferFor(buffers, spec.wallFamily);
  const roofBuf = bufferFor(buffers, spec.roofFamily);
  const glassBuf = bufferFor(buffers, 'glass');
  const metalBuf = bufferFor(buffers, 'metal');
  const concreteBuf = bufferFor(buffers, 'concrete');

  const facadeBufs: FacadeBuffers = {
    wall: wallBuf,
    glass: glassBuf,
    metal: metalBuf,
    accent: metalBuf,
  };

  buildFacades(facadeBufs, footprint, mass.floors, spec, params, facadeSeed);

  // Floor slabs showing at each terrace step, plus the terrace surfaces
  // themselves — where an upper floor is smaller than the one below.
  concreteBuf.setColor({ r: 0.8, g: 0.79, b: 0.76 });
  for (const floor of mass.floors) {
    for (const t of floor.terrace) {
      if (area(t) < 1.2) continue;
      concreteBuf.pushCap(t, floor.y0 + 0.04, true);
      concreteBuf.pushPrism(t, floor.y0, floor.y0 + 0.9, false, false);
    }
  }

  // Roof on the topmost floor's outline.
  const top = mass.floors[mass.floors.length - 1]!;
  roofBuf.setColor({
    r: spec.roofColor.r * spec.valueShift,
    g: spec.roofColor.g * spec.valueShift,
    b: spec.roofColor.b * spec.valueShift,
  });
  const roof = buildRoof(roofBuf, footprint, top.polygon, top.y1, spec);

  // Ground-floor plinth: a low band of concrete under every Japanese house.
  concreteBuf.setColor({ r: 0.72 * groundGrime(0), g: 0.71 * groundGrime(0), b: 0.68 * groundGrime(0) });
  const base = mass.floors[0]!;
  concreteBuf.pushPrism(base.polygon, -0.15, 0.42, false, false);

  // --- Details -------------------------------------------------------------
  const rng = makeRng(subSeed(lot.seed, 'details'));

  if (spec.hasExteriorCorridor) {
    buildCorridorAndStairs(
      { wall: concreteBuf, metal: metalBuf, accent: metalBuf, glass: glassBuf },
      footprint,
      mass,
      spec,
      rng,
    );
  }

  if (spec.hasPenthouse) {
    buildRooftopPlant(
      { wall: concreteBuf, metal: metalBuf },
      top.polygon,
      top.y1 + roof.peak,
      spec,
      rng,
    );
  }

  if (spec.kind !== 'house') {
    buildLaundry(metalBuf, footprint, mass, spec, rng);
  }

  // Downspouts (竪樋) every 6–8 m around the building.
  buildDownspouts(metalBuf, footprint, mass, spec, rng);

  let triangles = 0;
  for (const b of Object.values(buffers)) if (b) triangles += b.triangleCount;

  return { lot, spec, envelope, footprint, mass, buffers, triangles };
}

/** Thin vertical pipes at the building corners and along long walls. */
function buildDownspouts(
  buf: GeometryBuffer,
  footprint: Footprint,
  mass: BuildingMass,
  spec: BuildingSpec,
  rng: ReturnType<typeof makeRng>,
): void {
  buf.setColor({ r: 0.62, g: 0.61, b: 0.58 });
  const spacing = spec.kind === 'mansion' ? 7 : 5.5;
  for (const wall of footprint.walls) {
    if (wall.len < 2) continue;
    const n = Math.max(1, Math.round(wall.len / spacing));
    for (let i = 0; i <= n; i++) {
      if (i > 0 && i < n && rng.chance(0.5)) continue;
      const t = i === 0 ? 0.25 : i === n ? wall.len - 0.25 : (wall.len * i) / n;
      const p = V.addScaled(V.addScaled(wall.a, wall.dir, t), wall.normal, 0.07);
      buf.pushBox(p.x, mass.height / 2, p.y, 0.1, mass.height, 0.1);
    }
  }
}
