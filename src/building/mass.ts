import type { Polygon } from '../core/types.js';
import * as V from '../geom/vec2.js';
import { area } from '../geom/polygon.js';
import { clipHalfPlane } from '../geom/halfplane.js';
import { differencePoly, largest } from '../geom/boolean.js';
import type { BuildEnvelope, BuildingMass, BuildingSpec, Floor, Footprint } from './types.js';

/**
 * Floor stacking with 斜線 clipping.
 *
 * Applying the slant planes floor by floor is what produces the chamfered,
 * stepped-back tops of Japanese mid-rise buildings. Where one floor is smaller
 * than the one below, the difference is a roof terrace — a free detail that
 * reads as very マンション.
 */
export function buildMass(
  footprint: Footprint,
  envelope: BuildEnvelope,
  spec: BuildingSpec,
  lotArea: number,
): BuildingMass {
  const base = footprint.outline;
  const baseArea = footprint.area;

  const farFloors = Math.floor((envelope.maxFAR * lotArea) / Math.max(1, baseArea));
  const heightFloors = Math.floor(envelope.absoluteHeightLimit / spec.floorHeight);
  const floorCount = Math.max(1, Math.min(spec.floors, farFloors, heightFloors));

  const floors: Floor[] = [];
  let y = 0;
  let previous: Polygon = base;

  for (let f = 0; f < floorCount; f++) {
    const top = y + spec.floorHeight;
    let parts: Polygon[] = [base];

    for (const plane of envelope.slantPlanes) {
      // Distance from the plane's origin at which the envelope reaches `top`.
      const allowed = (top - plane.baseHeight) / plane.slope;
      // Below the plane's 立ち上がり the rule imposes no restriction at all.
      // Treating that as "nothing is allowed" collapsed every building to a
      // single storey, because the 北側斜線 base height is 5 m and the first
      // floor top is only 2.9 m.
      if (allowed <= 0) continue;
      const hp = {
        origin: V.addScaled(plane.origin, plane.inwardNormal, allowed),
        normal: plane.inwardNormal,
      };
      const next: Polygon[] = [];
      for (const p of parts) next.push(...clipHalfPlane(p, hp));
      parts = next;
      if (parts.length === 0) break;
    }

    const clipped = parts.length > 0 ? largest(parts) : null;
    if (!clipped) break;

    const clippedArea = area(clipped);
    // The top floor has effectively vanished.
    if (clippedArea < baseArea * 0.35) break;

    // Ignore trivial clips, which would otherwise leave 20 cm ledges all the way
    // up the building.
    const polygon = clippedArea > baseArea * 0.97 ? base : clipped;

    const terrace = f > 0 ? differencePoly([previous], [polygon]).filter((p) => area(p) > 1.2) : [];
    floors.push({ polygon, y0: y, y1: top, index: f, terrace });
    previous = polygon;
    y = top;
  }

  if (floors.length === 0) {
    floors.push({ polygon: base, y0: 0, y1: spec.floorHeight, index: 0, terrace: [] });
    y = spec.floorHeight;
  }

  return { floors, height: y };
}
