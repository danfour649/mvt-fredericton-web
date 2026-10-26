/**
 * Junction graph over the world's roads (v0.21, addition B).
 *
 * v0.20 traffic ping-ponged: drive to the end of a road, flip, drive
 * back. Here we cluster road ENDPOINTS that coincide (or nearly —
 * GeoNB segments are split at junctions but the joins can be a few
 * metres off) into nodes; each node knows the road-ends that meet
 * there. When traffic reaches a node it picks a connecting road —
 * preferring the one that continues its direction of travel, randomly
 * otherwise, U-turning only at a dead end — and circulates downtown.
 *
 * Pure data: built once from the WorldModel, no DOM, deterministic for
 * a given world.
 */
import type { Vec2 } from './geo';
import type { Road, WorldModel } from './world';

export interface JunctionEdge {
  road: Road;
  /** True when the node sits at the road's path start (distAlong 0). */
  atStart: boolean;
}

export interface JunctionNode {
  pos: Vec2;
  edges: JunctionEdge[];
}

export interface RoadGraph {
  nodes: JunctionNode[];
  /** For each road: node index at its start / end (-1 = none within snap). */
  startNode: number[];
  endNode: number[];
  roadIndex: Map<Road, number>;
}

/** Endpoint clustering cell, metres. */
const SNAP = 5;

export function buildRoadGraph(world: WorldModel): RoadGraph {
  const roadIndex = new Map<Road, number>();
  world.roads.forEach((r, i) => roadIndex.set(r, i));

  const cells = new Map<string, { pos: Vec2; n: number; edges: JunctionEdge[] }>();
  const cellOf = (p: Vec2) => `${Math.round(p.x / SNAP)},${Math.round(p.z / SNAP)}`;
  const addEnd = (road: Road, atStart: boolean) => {
    const p = atStart ? road.path[0] : road.path[road.path.length - 1];
    const key = cellOf(p);
    let cell = cells.get(key);
    if (!cell) {
      cell = { pos: { x: 0, z: 0 }, n: 0, edges: [] };
      cells.set(key, cell);
    }
    cell.pos = { x: (cell.pos.x * cell.n + p.x) / (cell.n + 1), z: (cell.pos.z * cell.n + p.z) / (cell.n + 1) };
    cell.n++;
    cell.edges.push({ road, atStart });
  };
  for (const road of world.roads) {
    addEnd(road, true);
    addEnd(road, false);
  }

  const nodes: JunctionNode[] = [];
  const nodeOfCell = new Map<string, number>();
  for (const [key, cell] of cells) {
    nodeOfCell.set(key, nodes.length);
    nodes.push({ pos: cell.pos, edges: cell.edges });
  }
  const startNode = world.roads.map((r) => nodeOfCell.get(cellOf(r.path[0])) ?? -1);
  const endNode = world.roads.map((r) => nodeOfCell.get(cellOf(r.path[r.path.length - 1])) ?? -1);
  return { nodes, startNode, endNode, roadIndex };
}

/** Heading of travel when LEAVING a node along an edge's road. */
export function edgeExitHeading(edge: JunctionEdge): number {
  const p = edge.road.path;
  if (edge.atStart) {
    return Math.atan2(p[1].z - p[0].z, p[1].x - p[0].x);
  }
  const n = p.length;
  return Math.atan2(p[n - 2].z - p[n - 1].z, p[n - 2].x - p[n - 1].x);
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Choose the next road at a junction. `arriveHeading` is the direction
 * of travel on arrival. Prefers the edge whose exit heading continues
 * that direction (best alignment wins with probability 0.7 when there
 * is a clear winner, else a random other edge); never picks the road
 * it arrived on unless that is the only option (dead end → U-turn,
 * returns null and the caller flips direction on the same road).
 */
export function pickNextEdge(
  graph: RoadGraph,
  nodeIdx: number,
  arriveRoad: Road,
  arriveHeading: number,
  rng: () => number,
): JunctionEdge | null {
  const node = graph.nodes[nodeIdx];
  if (!node) return null;
  const options = node.edges.filter((e) => e.road !== arriveRoad);
  if (options.length === 0) return null;
  if (options.length === 1) return options[0];
  // Score by alignment with the arrival heading.
  let best = options[0];
  let bestScore = -Infinity;
  for (const e of options) {
    const score = Math.cos(wrapAngle(edgeExitHeading(e) - arriveHeading));
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (bestScore > 0.35 && rng() < 0.7) return best;
  return options[Math.floor(rng() * options.length)];
}
