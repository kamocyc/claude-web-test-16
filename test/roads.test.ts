import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  applyRoadLayout,
  cloneParams,
  type CityParams,
  type RoadLayout,
} from '../src/core/params.js';
import { generateRoads } from '../src/city/Roads.js';
import { generateCity } from '../src/city/City.js';
import { clearanceViolations, describeViolation } from '../src/city/RoadClearance.js';
import * as V from '../src/geom/vec2.js';
import { findSpurs } from '../src/geom/planarGraph.js';

/**
 * Road network invariants.
 *
 * The three assertions that matter — ribbons that do not overlap, junctions
 * that are not slivers, and streets that stay square to their district — are
 * the machine-checkable form of "the roads look wrong". They are written
 * against the network, not against the generator, so they survive the next
 * rewrite of how roads are laid out.
 */

const LAYOUTS: RoadLayout[] = ['district', 'grid'];
const SEEDS = ['rd-1', 'rd-2', 'rd-3'];

function roadParams(seed: string, layout: RoadLayout): CityParams {
  const params = cloneParams(DEFAULT_PARAMS);
  params.seed = seed;
  applyRoadLayout(params.roads, layout);
  params.roads.extent = 190; // smaller town keeps the test fast
  return params;
}

describe('road clearance', () => {
  for (const layout of LAYOUTS) {
    for (const seed of SEEDS) {
      it(`ribbons never overlap (${layout}, ${seed})`, () => {
        const params = roadParams(seed, layout);
        const net = generateRoads(params.seed, params.roads);
        const bad = clearanceViolations(net, { clearance: params.roads.roadClearance });
        expect(
          bad.slice(0, 5).map((v) => describeViolation(net, v)),
          `${bad.length} overlapping road pairs`,
        ).toEqual([]);
      });
    }
  }

  it('private lanes clear the roads they meet', () => {
    const params = roadParams('lanes-1', 'district');
    const city = generateCity(params);
    const bad = clearanceViolations(city.roads, {
      clearance: params.roads.roadClearance,
      includeLanes: true,
    }).filter((v) => v.a < 0 || v.b < 0);
    expect(
      bad.slice(0, 5).map((v) => describeViolation(city.roads, v)),
      `${bad.length} lanes overlapping a road`,
    ).toEqual([]);
  });
});

describe('junction angles', () => {
  for (const layout of LAYOUTS) {
    it(`no acute junctions (${layout})`, () => {
      const params = roadParams('junc-1', layout);
      const net = generateRoads(params.seed, params.roads);
      const limit = params.roads.minJunctionAngle * (Math.PI / 180);

      const incident: Vec2Dir[][] = net.graph.nodes.map(() => []);
      for (const e of net.edges) {
        const a = net.graph.node(e.a).p;
        const b = net.graph.node(e.b).p;
        incident[e.a]!.push({ angle: V.angleOf(V.sub(b, a)), id: e.id });
        incident[e.b]!.push({ angle: V.angleOf(V.sub(a, b)), id: e.id });
      }

      const bad: string[] = [];
      net.graph.nodes.forEach((node, i) => {
        const arms = incident[i]!;
        if (arms.length < 2) return;
        const sorted = arms.slice().sort((x, y) => x.angle - y.angle);
        for (let k = 0; k < sorted.length; k++) {
          const cur = sorted[k]!;
          const next = sorted[(k + 1) % sorted.length]!;
          if (sorted.length === 2 && k === 1) break;
          let gap = next.angle - cur.angle;
          if (gap < 0) gap += Math.PI * 2;
          if (gap < limit - 1e-6) {
            bad.push(
              `node ${i} (${node.p.x.toFixed(1)},${node.p.y.toFixed(1)}): ` +
                `edges ${cur.id}/${next.id} meet at ${((gap * 180) / Math.PI).toFixed(1)}°`,
            );
          }
        }
      });
      expect(bad.slice(0, 5), `${bad.length} acute junctions`).toEqual([]);
    });
  }
});

describe('buildings follow the roads', () => {
  for (const layout of LAYOUTS) {
    it(`houses on one street face the same way (${layout})`, () => {
      const params = roadParams('face-1', layout);
      const city = generateCity(params);

      // Lots sharing a road edge are on the same stretch of the same street, so
      // they front the same line and must face the same way. Any spread here is
      // the fan-out that makes a row of houses look scattered.
      const groups = new Map<number, number[]>();
      for (const lot of city.lots) {
        const id = lot.frontages[0]?.roadEdgeId;
        if (id === undefined || id === null) continue;
        const list = groups.get(id) ?? [];
        list.push(V.angleOf(lot.faceDir));
        groups.set(id, list);
      }

      const bad: string[] = [];
      let checked = 0;
      for (const [id, angles] of groups) {
        if (angles.length < 3) continue;
        checked++;
        // Compared mod 180°: the two sides of a street face each other, which
        // is correct and not a spread. What is being asserted is that every
        // house on the street is square to it.
        let spread = 0;
        for (const a of angles) {
          for (const b of angles) {
            const d = Math.abs(a - b) % Math.PI;
            spread = Math.max(spread, Math.min(d, Math.PI - d));
          }
        }
        if (spread > 0.5 * (Math.PI / 180)) {
          bad.push(`road ${id}: ${angles.length} lots spread ${((spread * 180) / Math.PI).toFixed(2)}°`);
        }
      }
      expect(checked, 'no street had three lots on it').toBeGreaterThan(10);
      expect(bad.slice(0, 5), `${bad.length} streets with misaligned frontages`).toEqual([]);
    });
  }
});

describe('tier-1 skeleton', () => {
  for (const layout of LAYOUTS) {
    it(`arterials and collectors span the town (${layout})`, () => {
      const params = roadParams('spur-1', layout);
      const net = generateRoads(params.seed, params.roads);
      const spurs = findSpurs(net.graph).edgeIds;
      // A Tier-1 road that stops short becomes a dead-end chain, is pruned from
      // the face walk, and its district silently merges with its neighbour —
      // one district's axis then governs twice the town it should.
      const stranded = net.edges
        .filter((e) => e.cls !== 'local' && spurs.has(e.id))
        .map((e) => {
          const a = net.graph.node(e.a).p;
          const b = net.graph.node(e.b).p;
          return `${e.cls} #${e.id} (${a.x.toFixed(1)},${a.y.toFixed(1)})–(${b.x.toFixed(1)},${b.y.toFixed(1)})`;
        });
      expect(stranded.slice(0, 5), `${stranded.length} stranded Tier-1 edges`).toEqual([]);
    });
  }
});

interface Vec2Dir {
  angle: number;
  id: number;
}
