import type { Vec2 } from '../core/types.js';
import type { LandUseParams, LotParams, UseZone } from '../core/params.js';
import { makeFbm, subSeed } from '../core/rng.js';
import * as V from '../geom/vec2.js';
import type { District } from './RoadDistricts.js';
import { districtCentroid } from './RoadDistricts.js';

/**
 * 用途地域 — painted on districts, not on lots.
 *
 * The obvious alternative is to extend the urbanity field with an "industrial"
 * axis and decide per lot. It cannot work, and the reason is worth stating
 * because it is the whole argument for this file existing: a threshold on a
 * smooth scalar field produces salt and pepper. Every lot near the contour
 * flips independently, so a factory lands between two houses, and the resulting
 * shape has a ragged fringe and outlying islands. There is no 工業団地 anywhere
 * in it, and no amount of smoothing gives one — smooth the field enough to kill
 * the fringe and the region stops having a boundary at all.
 *
 * A 工業団地 is not a place where the industrial score happens to be high. It is
 * a **contiguous area that was designated**, and the designation came first.
 * So this paints it that way: pick a seed district, flood fill its neighbours
 * until the area target is met, and ring the result in 準工業. Contiguity is
 * then true by construction rather than by tuning, which is exactly what
 * `test/landuse.test.ts` asserts.
 *
 * The district faces are already the right unit — they are what a 都市計画図 is
 * drawn on, and each one is a 区画整理 development with its own grid.
 *
 * **But they are coarse and very uneven.** Measured at `extent: 320`: 13
 * districts, p50 19,194 m², max 104,676 m² — one district covering a quarter of
 * the town. So every decision below is *area-aware* rather than count-aware.
 * Designating "the best two districts" would be a coin flip between 8% of the
 * town and 40% of it.
 */

/** Undirected adjacency between districts, as index lists. */
export type Adjacency = number[][];

/**
 * Two districts are neighbours when they share a stretch of boundary.
 *
 * Matched by segment midpoint proximity plus direction agreement, which is the
 * same test `attributeBoundary` and `Blocks.attributeEdges` use, for the same
 * reason: the polygons have each been through cleaning independently, so the
 * shared edge is not the same pair of endpoints on both sides and cannot be
 * matched exactly. Both districts' midpoints are probed against the other's
 * segments, because a long boundary on one side may be several short ones on
 * the other and only the finer side's midpoints land near the coarser side.
 */
export function districtAdjacency(districts: District[], tol = 1.5): Adjacency {
  const adj: Adjacency = districts.map(() => []);

  const touches = (a: District, b: District): boolean => {
    for (const [p, q] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const e of p.boundary) {
        const mid = V.lerp(e.a, e.b, 0.5);
        for (const f of q.boundary) {
          if (Math.abs(V.dot(e.dir, f.dir)) < 0.9) continue;
          if (V.distToSegment(mid, f.a, f.b) <= tol) return true;
        }
      }
    }
    return false;
  };

  for (let i = 0; i < districts.length; i++) {
    for (let j = i + 1; j < districts.length; j++) {
      if (!touches(districts[i]!, districts[j]!)) continue;
      adj[i]!.push(j);
      adj[j]!.push(i);
    }
  }
  return adj;
}

/** Share of a district's boundary carried by an arterial or a collector. */
function tier1Share(d: District): number {
  let wide = 0;
  let total = 0;
  for (const e of d.boundary) {
    const len = V.dist(e.a, e.b);
    total += len;
    if (e.cls === 'arterial' || e.cls === 'collector') wide += len;
  }
  return total > 0 ? wide / total : 0;
}

/** Distance from the station to the nearest point of a district's boundary. */
function minStationDist(d: District, station: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < d.polygon.length; i++) {
    const a = d.polygon[i]!;
    const b = d.polygon[(i + 1) % d.polygon.length]!;
    best = Math.min(best, V.distToSegment(station, a, b));
  }
  return best;
}

/**
 * How far out of town the district's *centre of mass* sits, [0, 1].
 *
 * Measured on the centroid rather than on the furthest vertex, which was the
 * first attempt and is worthless: `perimeterRoad` closes the town square, so
 * every district but the few bounded entirely by diagonals touches the edge and
 * scores exactly 1.
 */
function peripherality(d: District, extent: number): number {
  const c = districtCentroid(d);
  return Math.min(1, Math.max(Math.abs(c.x), Math.abs(c.y)) / Math.max(1, extent));
}

/**
 * Assign a 用途地域 to every district, in place.
 *
 * Called from `generateRoads` between the Tier-1 partition and the Tier-2 grids,
 * because `industrialLocalSpacing` is an input to the latter. Everything here
 * draws from `subSeed(seed, 'landuse')`, a namespace nothing else uses, so no
 * existing random stream moves.
 */
export function assignLandUse(
  districts: District[],
  station: Vec2,
  extent: number,
  seed: string,
  p: LandUseParams,
): void {
  if (districts.length === 0) return;

  const noise = makeFbm(subSeed(seed, 'landuse', 'noise'), 2);
  const townArea = Math.pow(2 * extent, 2);
  const target = p.industrialShare * townArea;

  const feat = districts.map((d) => {
    const c = districtCentroid(d);
    return {
      d,
      centroidDist: V.dist(c, station),
      edgeDist: minStationDist(d, station),
      tier1: tier1Share(d),
      periphery: peripherality(d, extent),
      noise: (noise(c.x / p.noiseScale, c.y / p.noiseScale) + 1) / 2,
    };
  });

  for (const d of districts) d.zone = 'lowRise';
  const adj = districtAdjacency(districts);

  // --- 1. The commercial core ----------------------------------------------
  // One district, not a threshold: a suburban 駅前商業地域 is the couple of
  // blocks around the station, and every other district that scored well would
  // be a second downtown somewhere else in the same small town.
  //
  // Candidates are the districts the station is in or beside, ranked by how
  // close they are *and how small*. The size term is not tuning: districts here
  // run to a quarter of the town, and designating one of those 商業地域 would
  // put a 繁華街 across a third of a suburb. A real one is small precisely
  // because it is bounded by the streets immediately around the station.
  let core = -1;
  let coreCost = Infinity;
  for (let i = 0; i < feat.length; i++) {
    const f = feat[i]!;
    if (f.edgeDist > p.commercialCoreRadius) continue;
    const cost =
      f.edgeDist / p.commercialCoreRadius +
      0.8 * (f.d.area / (0.09 * townArea)) -
      p.arterialFrontageWeight * f.tier1;
    if (cost < coreCost) {
      coreCost = cost;
      core = i;
    }
  }
  if (core >= 0) districts[core]!.zone = 'commercial';

  // --- 2. The industrial belt, as a flood fill ------------------------------
  // Eligibility is expressed as *graph* distance from the shops plus a centroid
  // distance floor, and the first of those is the load-bearing one.
  //
  // The obvious rule — "no part of an industrial district comes within
  // `industrialMinStationDist` of the station" — is unsatisfiable on this
  // partition, which is worth recording because it looks so reasonable. The
  // districts are hundreds of metres across, so one that is far away on average
  // still reaches back toward the middle of town; measured at extent 320 the
  // *furthest* any district's boundary gets from the station is 217 m in the
  // grid layout. That rule designates nothing, in every seed. Not being next
  // door to the shops is the guarantee this granularity can actually make, and
  // it is the one a zoning map cares about anyway.
  const blocked = new Set<number>();
  if (core >= 0) {
    blocked.add(core);
    for (const j of adj[core]!) blocked.add(j);
  }

  const eligible = (i: number): boolean =>
    !blocked.has(i) && feat[i]!.centroidDist >= p.industrialMinStationDist;

  const industrialScore = (i: number): number => {
    const f = feat[i]!;
    return (
      // Spread over 0…1.5×extent so the term does not saturate: with a 320 m
      // half-extent, centroid distances run to 480 m and dividing by the extent
      // alone would clamp half the town to 1.
      0.5 * Math.min(1, f.centroidDist / (1.5 * extent)) +
      0.3 * f.periphery +
      p.noiseWeight * f.noise +
      // A 工業団地 wants an arterial to truck out of.
      0.15 * f.tier1
    );
  };

  // A district much larger than the entire target is penalised as a seed, not
  // banned: if the only eligible land is one huge district, an oversized estate
  // still beats no estate at all.
  const seedScore = (i: number): number =>
    industrialScore(i) - 0.45 * Math.min(1, Math.max(0, districts[i]!.area / Math.max(1, target) - 1));

  // Choose the *component* before choosing the seed.
  //
  // A fill can only ever reach the districts connected to its seed through
  // eligible land, so how much land a seed can reach is a property of its
  // component, not of the seed. Scoring seeds individually ignores that, and the
  // partition punishes it immediately: it contains near-degenerate slivers — the
  // face left between two diagonals and a collector — which score beautifully
  // because they sit right out at the edge of town, and one of them seeded a
  // component of exactly itself, every neighbour blocked. That town's designated
  // industrial zone came out at 0.0%.
  //
  // Flooring the seed's own area instead is worse than it looks: a small
  // district on the rim of a large component is a perfectly good place to start,
  // and banning it cost another seed two thirds of its estate.
  const component = new Int32Array(districts.length).fill(-1);
  const componentArea: number[] = [];
  for (let i = 0; i < districts.length; i++) {
    if (!eligible(i) || component[i] !== -1) continue;
    const id = componentArea.length;
    let acc = 0;
    const stack = [i];
    component[i] = id;
    while (stack.length > 0) {
      const k = stack.pop()!;
      acc += districts[k]!.area;
      for (const j of adj[k]!) {
        if (!eligible(j) || component[j] !== -1) continue;
        component[j] = id;
        stack.push(j);
      }
    }
    componentArea.push(acc);
  }

  let bestComponent = -1;
  let bestComponentScore = -Infinity;
  for (let id = 0; id < componentArea.length; id++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < districts.length; i++) {
      if (component[i] !== id) continue;
      sum += industrialScore(i);
      n++;
    }
    // Capacity dominates: a component that cannot hold the estate loses to one
    // that can, however well placed it is.
    const s = 1.5 * Math.min(1, componentArea[id]! / Math.max(1, target)) + (n > 0 ? sum / n : 0);
    if (s > bestComponentScore) {
      bestComponentScore = s;
      bestComponent = id;
    }
  }

  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < districts.length; i++) {
    if (component[i] !== bestComponent) continue;
    const s = seedScore(i);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }

  if (best >= 0) {
    const taken = new Set<number>([best]);
    let acc = districts[best]!.area;
    // Growth is capped as well as targeted. Without the cap the fill happily
    // annexes a 105,000 m² neighbour to close a 10,000 m² shortfall and the
    // industrial share overshoots to 38%; the districts are uneven enough that
    // the last one added dominates the total.
    const ceiling = target * 1.25;

    for (;;) {
      if (acc >= target) break;
      let next = -1;
      let nextScore = -Infinity;
      // Once the fill has stalled badly short of target, the ceiling is the
      // thing standing in its way rather than protecting anything: a seed whose
      // every eligible neighbour is too big to fit under it stays a single
      // district. On a grown partition that happened often enough to designate
      // 3.8% of a town as industrial against a target of 18%. So the ceiling is
      // dropped for one annexation when the estate is less than two-thirds
      // built — one overshoot beats an estate that is a single block.
      const stalledShort = acc < target * 0.65;
      const limit = stalledShort ? target * 1.5 : ceiling;
      for (const i of taken) {
        for (const j of adj[i]!) {
          if (taken.has(j) || !eligible(j)) continue;
          const after = acc + districts[j]!.area;
          if (after > limit) continue;
          // While stalled, the question is no longer "which district is the most
          // industrial?" but "which one gets the estate closest to the size it
          // was asked for?". Scoring by fit rather than by merit is what keeps
          // the one permitted overshoot from annexing a quarter of the town —
          // taking the best-scoring neighbour instead put 44% of a suburb under
          // factories.
          const s = stalledShort ? -Math.abs(after - target) : industrialScore(j);
          if (s > nextScore) {
            nextScore = s;
            next = j;
          }
        }
      }
      if (next < 0) break;
      taken.add(next);
      acc += districts[next]!.area;
    }

    for (const i of taken) districts[i]!.zone = 'industrial';

    // --- 3. The 準工業 buffer ----------------------------------------------
    // Not decoration: this is what 準工業地域 is for — a belt where a machine
    // shop and a house legally coexist — and it is what structurally stops a
    // factory from ever fronting a 第一種低層住専 street.
    if (p.quasiIndustrialRing) {
      for (const i of taken) {
        for (const j of adj[i]!) {
          if (districts[j]!.zone === 'lowRise') districts[j]!.zone = 'quasiIndust';
        }
      }
    }
  }

  // --- 4. 近隣商業, then everything else ------------------------------------
  // Assigned *after* the industrial belt, and never beside it. Doing it the
  // other way round is what the first attempt did, and it took eight of thirteen
  // districts — every district has Tier-1 boundary, because districts *are* the
  // faces of the Tier-1 graph — leaving one 2,900 m² scrap for industry.
  // 近隣商業 spreads from the shops it is named after, so it grows off the core.
  // Bounded by area as well as by reach, and for the same reason the industrial
  // fill is: the districts do not shrink when the town does, so a pure radius
  // test hands most of a small map to the shops. Nearest first, until the shops
  // have had their share.
  const candidates: number[] = [];
  for (let i = 0; i < feat.length; i++) {
    if (districts[i]!.zone !== 'lowRise') continue;
    if (core < 0 || !adj[i]!.includes(core)) continue;
    if (feat[i]!.edgeDist > p.neighbourhoodRadius) continue;
    if (adj[i]!.some((j) => districts[j]!.zone === 'industrial')) continue;
    candidates.push(i);
  }
  candidates.sort((a, b) => feat[a]!.edgeDist - feat[b]!.edgeDist);

  let shopArea = core >= 0 ? districts[core]!.area : 0;
  const shopCeiling = p.commercialShare * townArea;
  for (const i of candidates) {
    if (shopArea + districts[i]!.area > shopCeiling) continue;
    districts[i]!.zone = 'neighbourCom';
    shopArea += districts[i]!.area;
  }

  for (let i = 0; i < feat.length; i++) {
    const f = feat[i]!;
    if (f.d.zone !== 'lowRise') continue;
    if (f.centroidDist < p.neighbourhoodRadius) f.d.zone = 'midRise';
  }
}

/**
 * Lot subdivision parameters for a zone.
 *
 * A factory needs a 3,000 m² parcel and a shophouse a 5 m frontage; neither is
 * reachable from one set of numbers tuned for detached houses. This is the whole
 * of the zone's influence on subdivision — `subdivideBlock` reads `params.lots`
 * exactly once, so overlaying it there is the entire seam.
 *
 * Note what is *not* here: no rule places a building. `neighbourCom` widening
 * its major-road parcels is what makes a コンビニ site possible; whether one
 * appears is still decided downstream by area, frontage and shallowness. That is
 * the same discipline `maxLotAreaMajor` already follows — it is why a マンション
 * can only exist on a consolidated arterial parcel without the zoning rules ever
 * naming one.
 */
const ZONE_LOTS: Partial<Record<UseZone, Partial<LotParams>>> = {
  industrial: {
    maxLotArea: 4200,
    maxLotAreaMajor: 4200,
    widthMean: 42,
    widthMeanMajor: 55,
    widthMin: 22,
    widthMax: 80,
    depthMean: 45,
    depthMeanMajor: 55,
    depthMax: 70,
    cutAngleJitter: 1,
    // An industrial estate is a grid of large parcels fronting the street, not a
    // warren: no 私道 into the middle of a block, and no 旗竿地 behind anything.
    flagLotChance: 0,
    minCoreArea: Infinity,
  },
  quasiIndust: {
    maxLotArea: 900,
    widthMean: 18,
    depthMean: 26,
    widthMax: 40,
  },
  neighbourCom: {
    // Narrow and deep — the 間口 of a shophouse row. `widthMin` is the number to
    // watch: `MIN_PLAN_WIDTH_MODULES` puts the floor for a building at 2.46 m and
    // a lot much under 5 m wide starts coming back as `too-narrow`.
    widthMean: 6.0,
    widthSigma: 1.2,
    widthMin: 4.6,
    widthMax: 14,
    depthMean: 12.5,
    maxLotArea: 260,
    // The one lever that makes a コンビニ site possible. It does not place one —
    // whether a shop appears is still decided downstream from area, frontage and
    // shallowness — it only coarsens the parcel grain on the wide roads so that
    // such a site can occur at all. Exactly what `maxLotAreaMajor` already does
    // for マンション, and the honest thing to adjust if too few appear.
    widthMeanMajor: 19,
  },
  commercial: {
    // A downtown block is a mix, and it has to be: the narrow parcels become
    // 店舗併用住宅 and the wide ones 雑居ビル, so a single 7 m grain gave a
    // 商業地域 with no 雑居ビル in it at all — nothing cleared the 8 m frontage
    // the tenant floors need.
    widthMean: 9,
    widthSigma: 3,
    widthMin: 5,
    widthMax: 22,
    depthMean: 18,
    maxLotArea: 700,
  },
};

export function zoneLotParams(base: LotParams, zone: UseZone): LotParams {
  const overlay = ZONE_LOTS[zone];
  return overlay ? { ...base, ...overlay } : base;
}
