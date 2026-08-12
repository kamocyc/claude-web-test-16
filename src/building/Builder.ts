import type { BuildingParams } from '../core/params.js';
import { makeRng, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import { contains } from '../geom/polygon.js';
import type { Lot } from '../city/Lots.js';
import { GeometryBuffer } from '../build/GeometryBuffer.js';
import type { MaterialFamily } from '../material/materials.js';
import { groundGrime } from '../material/palettes.js';
import { KIND_RULES } from './kinds.js';
import { computeEnvelope, fitFootprint, type FitDiagnostics } from './footprint.js';
import { buildMass } from './mass.js';
import { buildRoof } from './roof.js';
import { buildFacades, type FacadeBuffers } from './facade.js';
import { buildCorridorAndStairs } from './details/corridor.js';
import { buildRooftopPlant } from './details/penthouse.js';
import { buildLaundry } from './details/laundry.js';
import type {
  BuildingSpec,
  Footprint,
  BuildingMass,
  BuildEnvelope,
  VacancyReason,
} from './types.js';

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
 * Progressively looser terms on which a building may be attempted.
 *
 * The first rung is the ordinary one and almost every lot is built on it. The
 * rest exist because the alternative to a slightly cramped house is a bald
 * patch of ground in the middle of a block, and a real owner faced with an
 * awkward parcel builds a smaller house on it rather than leaving it empty —
 * which is exactly what the setback and floor-area minimums are standing in the
 * way of. Nothing here lets a building leave its lot: the buildable area is
 * still the lot inset by whatever setback the rung allows.
 */
const CONCESSIONS: { setback: number; floorArea: number; carPad: boolean }[] = [
  { setback: 1, floorArea: 1, carPad: true },
  { setback: 0.6, floorArea: 1, carPad: true },
  { setback: 0.35, floorArea: 0.8, carPad: false },
  { setback: 0.15, floorArea: 0.55, carPad: false },
];

export type BuildAttempt =
  | { ok: true; building: BuiltBuilding }
  | { ok: false; reason: VacancyReason };

/**
 * envelope -> footprint -> mass -> roof -> façade -> details, written into
 * per-material geometry buffers ready for chunk merging.
 *
 * Returns why it failed rather than a bare null: an empty lot with no
 * explanation is indistinguishable from a bug, and used to be one.
 */
export function buildBuilding(
  lot: Lot,
  spec: BuildingSpec,
  params: BuildingParams,
): BuildAttempt {
  let envelope: BuildEnvelope | null = null;
  let footprint: Footprint | null = null;
  // Whichever rung succeeded. Everything downstream — the mass, the eaves, the
  // façade module — has to be built on the same terms the footprint was fitted
  // on; mixing two parameter sets inside one building produces a mass that does
  // not partition its own plan.
  let built: BuildingParams = params;
  const diag: FitDiagnostics = { reason: null };

  // The use's own setbacks, before the concession ladder relaxes them further.
  // A 長屋's side setback is 0, and 0 survives every rung of the ladder — which
  // is exactly right: a party wall does not become less of a party wall because
  // the parcel turned out to be awkward.
  const scale = KIND_RULES[spec.kind].setbackScale;
  const useParams: BuildingParams =
    scale.front === 1 && scale.side === 1 && scale.rear === 1
      ? params
      : {
          ...params,
          frontSetback: params.frontSetback * scale.front,
          sideSetback: params.sideSetback * scale.side,
          rearSetback: params.rearSetback * scale.rear,
        };

  for (const c of CONCESSIONS) {
    const relaxed: BuildingParams =
      c.setback === 1 && c.floorArea === 1
        ? useParams
        : {
            ...useParams,
            frontSetback: useParams.frontSetback * c.setback,
            sideSetback: useParams.sideSetback * c.setback,
            rearSetback: useParams.rearSetback * c.setback,
            minFloorArea: useParams.minFloorArea * c.floorArea,
          };
    const trySpec = c.carPad ? spec : { ...spec, wantsCarPad: false };

    const env = computeEnvelope(lot, trySpec, relaxed);
    if (!env.buildable) {
      diag.reason = env.reason ?? 'no-buildable-area';
      continue;
    }
    const fp = fitFootprint(lot, env, trySpec, relaxed, diag);
    if (fp) {
      envelope = env;
      footprint = fp;
      built = relaxed;
      break;
    }
  }

  // `too-narrow` is the one refusal worth keeping: a parcel that holds nothing
  // wider than a corridor is better left as ground than built on.
  if (!envelope || !footprint) return { ok: false, reason: diag.reason ?? 'no-footprint-fits' };

  // Mirroring doubles apparent variety at zero cost. Applied by flipping the
  // façade seed rather than the geometry, which keeps the building facing the
  // street while genuinely rearranging its openings.
  const facadeSeed = spec.mirrored ? subSeed(lot.seed, 'mirror') : lot.seed;

  const rule = KIND_RULES[spec.kind];
  const mass = buildMass(footprint, envelope, spec, lot, built);
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
    shutter: bufferFor(buffers, 'shutter'),
  };

  buildFacades(facadeBufs, mass.floors, spec, built, facadeSeed);

  // One roof per stack. The tallest keeps the archetype's roof; a part stepped
  // down by 斜線制限 gets a flat roof and becomes a roof terrace.
  roofBuf.setColor({
    r: spec.roofColor.r * spec.valueShift,
    g: spec.roofColor.g * spec.valueShift,
    b: spec.roofColor.b * spec.valueShift,
  });
  const tall = mass.stacks[0]!;
  let topPeak = 0;

  // The eaves overhang every wall, so on a 0.5 m side setback two neighbours'
  // roofs met in the middle. Clamp to the tightest wall on the building; a
  // shallow eave is normal on a modern narrow-lot house anyway.
  const eaveRoom = Math.min(...mass.floors[0]!.walls.map((w) => w.room), spec.eaves);
  const roofSpec: BuildingSpec = { ...spec, eaves: Math.max(0.12, Math.min(spec.eaves, eaveRoom)) };

  for (const stack of mass.stacks) {
    if (stack.stepped) {
      concreteBuf.setColor({ r: 0.8, g: 0.79, b: 0.76 });
      buildRoof(
        concreteBuf,
        stack,
        stack.y1,
        // A terrace needs a guarding upstand; a house parapet is only 45–70 cm.
        { ...roofSpec, parapetHeight: Math.max(spec.parapetHeight, 1.05) },
        'flat',
      );
    } else {
      topPeak = buildRoof(roofBuf, stack, stack.y1, roofSpec).peak;
    }
  }

  // Ground-floor plinth: a low band of concrete under every Japanese house.
  concreteBuf.setColor({ r: 0.72 * groundGrime(0), g: 0.71 * groundGrime(0), b: 0.68 * groundGrime(0) });
  const base = mass.floors[0]!;
  concreteBuf.pushPrism(base.polygon, -0.15, 0.42, false, false);

  // --- Details -------------------------------------------------------------
  const rng = makeRng(subSeed(lot.seed, 'details'));

  if (spec.hasExteriorCorridor) {
    buildCorridorAndStairs(
      { wall: concreteBuf, metal: metalBuf, accent: metalBuf, glass: glassBuf },
      mass,
      spec,
      rng,
    );
  }

  if (spec.roofPlant === 'penthouse') {
    buildRooftopPlant(
      { wall: concreteBuf, metal: metalBuf },
      tall.polygon,
      tall.y1 + topPeak,
      spec,
      rng,
    );
  }

  if (rule.laundry) {
    buildLaundry(metalBuf, mass, spec, rng);
  }

  // Downspouts (竪樋) every 6–8 m around the building.
  buildDownspouts(metalBuf, mass, spec, rng);

  let triangles = 0;
  for (const b of Object.values(buffers)) if (b) triangles += b.triangleCount;

  return { ok: true, building: { lot, spec, envelope, footprint, mass, buffers, triangles } };
}

/**
 * Thin vertical pipes at the corners and along long walls, per stack.
 *
 * These used to run the full building height along the *base* footprint, so on a
 * stepped building the upper half hung in mid-air, offset from the wall it was
 * supposed to be fixed to. A pipe on a step-back wall now starts at the terrace
 * below it rather than at grade.
 */
function buildDownspouts(
  buf: GeometryBuffer,
  mass: BuildingMass,
  spec: BuildingSpec,
  rng: ReturnType<typeof makeRng>,
): void {
  buf.setColor({ r: 0.62, g: 0.61, b: 0.58 });
  const spacing = KIND_RULES[spec.kind].downspoutSpacing;

  for (const stack of mass.stacks) {
    for (const wall of stack.walls) {
      if (wall.len < 2) continue;
      const probe = V.addScaled(V.lerp(wall.a, wall.b, 0.5), wall.normal, 0.2);
      let y0 = 0;
      for (const other of mass.stacks) {
        if (other !== stack && contains(other.polygon, probe)) y0 = Math.max(y0, other.y1);
      }
      const n = Math.max(1, Math.round(wall.len / spacing));
      for (let i = 0; i <= n; i++) {
        if (i > 0 && i < n && rng.chance(0.5)) continue;
        const t = i === 0 ? 0.25 : i === n ? wall.len - 0.25 : (wall.len * i) / n;
        const p = V.addScaled(V.addScaled(wall.a, wall.dir, t), wall.normal, 0.07);
        buf.pushOrientedBox(p.x, p.y, wall.dir, 0.1, 0.1, y0, stack.y1);
      }
    }
  }
}
