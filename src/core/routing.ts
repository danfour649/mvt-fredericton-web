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
import { dist, type Vec2 } from './geo';
import {
  collideWorld,
  nearestRoadPoint,
  pointAlongRoad,
  pointInWater,
  type Road,
  type WorldModel,
} from './world';

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

// --- pathfinding (FOLLOW iteration 5) --------------------------------------
// The junction graph above was built for traffic circulation; the
// follow scheme's map pick needs point-to-point routes over it:
// tap a far bank and the car should drive the ROADS there, not
// pure-pursue a straight line through the buildings in between.
//
// findRoute returns pursuit waypoints: along the start road to a
// graph node, across the node graph by Dijkstra (road lengths as
// costs), down the target road, ending EXACTLY at `to`. Two
// robustness additions over the raw graph, kept local to routing
// so traffic's circulation behaviour is untouched:
//  - the partial first/last legs run along the nearest roads
//    themselves (a car mid-block starts by driving its own street,
//    not by cutting toward a distant endpoint), and
//  - nodes whose positions sit within LINK_M of each other are
//    treated as connected ("link" edges): GeoNB joins can land a
//    few metres apart in different snap cells, and a route that
//    dies at a 3 m data gap helps nobody.

/** Node-proximity link distance for routing, m. */
export const ROUTE_LINK_M = 12;

/** distAlong of the point on a road closest to `p` (m). */
function closestAlong(road: Road, p: Vec2): number {
  let best = Infinity;
  let bestAlong = 0;
  let acc = 0;
  for (let i = 0; i < road.segLens.length; i++) {
    const a = road.path[i];
    const b = road.path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
    if (d < best) {
      best = d;
      bestAlong = acc + road.segLens[i] * t;
    }
    acc += road.segLens[i];
  }
  return bestAlong;
}

/** Points along a road between two distAlong values (either
 *  direction), including the road's own vertices in between and
 *  subdividing so no leg exceeds ~20 m. */
function subPath(road: Road, a0: number, a1: number): Vec2[] {
  const dir = a1 >= a0 ? 1 : -1;
  const alongs = new Set<number>();
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 20));
  for (let i = 0; i <= n; i++) alongs.add(a0 + ((a1 - a0) * i) / n);
  let acc = 0;
  const vertexAlongs = [0];
  for (const l of road.segLens) {
    acc += l;
    vertexAlongs.push(acc);
  }
  for (const va of vertexAlongs) {
    if ((va - a0) * dir > 0.5 && (a1 - va) * dir > 0.5) alongs.add(va);
  }
  return [...alongs]
    .sort((x, y) => (x - y) * dir)
    .map((a) => pointAlongRoad(road, a).pos);
}

/** Index of the graph node nearest to `p` (Euclidean), -1 if none. */
export function nearestGraphNode(graph: RoadGraph, p: Vec2): number {
  let best = -1;
  let bestD = Infinity;
  graph.nodes.forEach((n, i) => {
    const d = dist(n.pos, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

interface Adj {
  to: number;
  cost: number;
  /** The road traversed, or null for a proximity link. */
  road: Road | null;
  /** True when traversal runs the road start → end. */
  forward: boolean;
}

function buildAdjacency(graph: RoadGraph): Adj[][] {
  const adj: Adj[][] = graph.nodes.map(() => []);
  graph.nodes.forEach((node, ni) => {
    for (const e of node.edges) {
      const ri = graph.roadIndex.get(e.road);
      if (ri === undefined) continue;
      const other = e.atStart ? graph.endNode[ri] : graph.startNode[ri];
      if (other < 0 || other === ni) continue;
      adj[ni].push({ to: other, cost: e.road.lengthM, road: e.road, forward: e.atStart });
    }
  });
  // Proximity links between distinct nodes (see header).
  for (let i = 0; i < graph.nodes.length; i++) {
    for (let j = i + 1; j < graph.nodes.length; j++) {
      const d = dist(graph.nodes[i].pos, graph.nodes[j].pos);
      if (d > 0.01 && d <= ROUTE_LINK_M) {
        adj[i].push({ to: j, cost: d, road: null, forward: true });
        adj[j].push({ to: i, cost: d, road: null, forward: true });
      }
    }
  }
  return adj;
}

/** Final off-road legs up to this length (m) are trusted when clear. */
export const ROUTE_DEST_FREE_LEG_M = 30;

/** Is `p` standing on a road surface (the game's own bridge-deck
 *  test: over water but on a road is deck, not drowning)? */
function onRoadSurface(world: WorldModel, p: Vec2): boolean {
  const n = nearestRoadPoint(world, p);
  return !!n && dist(p, n.pos) <= n.road.widthM / 2 + 1.0;
}

/** Can a mover actually STAND at `p`? Not inside a building
 *  footprint, not in open water (a bridge deck over water is fine). */
function standable(world: WorldModel, p: Vec2): boolean {
  if (collideWorld(world, { ...p }, 0.55) !== null) return false;
  if (pointInWater(world, p) && !onRoadSurface(world, p)) return false;
  return true;
}

/** Is the straight leg a→b obstructed for a mover on the ground?
 *  Samples every few metres: a building in the way, or open water
 *  with no road surface under it (a riverbank final leg used to
 *  grind the FOLLOW walker against the Nashwaak for a quarter of
 *  an hour before the stuck ladder gave up). */
function legObstructed(world: WorldModel, a: Vec2, b: Vec2): boolean {
  const d = dist(a, b);
  const n = Math.max(1, Math.ceil(d / 5));
  for (let i = 1; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
    if (!standable(world, p)) return true;
  }
  return false;
}

/**
 * The destination a route can actually END at. A map tap lands
 * where the finger fell — inside a house footprint, in the river,
 * or 200+ m from the nearest road across open water — and a mover
 * sent to the raw point grinds against a wall or a riverbank
 * until the stuck ladder surrenders metres short. When the tap
 * itself is unstandable, or the off-road leg from its road snap
 * is long AND obstructed, the route ends at the snap instead:
 * the street in front of the place you tapped. Clear legs of any
 * length (a tap in an open field) keep the exact point.
 */
export function routableDestination(world: WorldModel, to: Vec2): Vec2 {
  const snap = nearestRoadPoint(world, to);
  if (!snap) return to;
  if (!standable(world, to)) return { ...snap.pos };
  if (dist(snap.pos, to) > ROUTE_DEST_FREE_LEG_M && legObstructed(world, snap.pos, to)) {
    return { ...snap.pos };
  }
  return to;
}

/**
 * Route from `from` to `to` over the road graph (see header).
 * Returns pursuit waypoints ending at the routable destination
 * for `to` (the point itself when a mover can stand there and
 * reach it, else its road snap), or null when no road route
 * exists (different components, a road with no graph nodes, an
 * empty world). Pure and deterministic.
 */
export function findRoute(graph: RoadGraph, world: WorldModel, from: Vec2, to: Vec2): Vec2[] | null {
  if (!graph.nodes.length || !world.roads.length) return null;
  const fromSnap = nearestRoadPoint(world, from);
  const toSnap = nearestRoadPoint(world, to);
  if (!fromSnap || !toSnap) return null;
  const dest = routableDestination(world, to);
  const fromRoad = fromSnap.road;
  const toRoad = toSnap.road;
  const fromAlong = closestAlong(fromRoad, from);
  const toAlong = closestAlong(toRoad, dest);

  const assemble = (pts: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of pts) {
      if (!out.length || dist(out[out.length - 1], p) > 1.5) out.push(p);
    }
    // The routable destination always closes the route.
    if (!out.length || dist(out[out.length - 1], dest) > 0.01) out.push({ ...dest });
    return out;
  };

  if (fromRoad === toRoad) {
    return assemble(subPath(fromRoad, fromAlong, toAlong));
  }

  const fromRi = graph.roadIndex.get(fromRoad);
  const toRi = graph.roadIndex.get(toRoad);
  if (fromRi === undefined || toRi === undefined) return null;
  // Start nodes: BOTH endpoints of the from-road are Dijkstra
  // sources, seeded with the along-road distance to reach them —
  // the nearest endpoint is not always the right way out (a ramp's
  // near end can lead back downtown while its far end is the
  // bridge). Target node: whichever to-road endpoint minimises
  // (graph distance + along-road remainder), decided after the
  // Dijkstra pass below.
  const startAlongEnd = new Map<number, number>();
  if (graph.startNode[fromRi] >= 0) startAlongEnd.set(graph.startNode[fromRi], 0);
  if (graph.endNode[fromRi] >= 0) startAlongEnd.set(graph.endNode[fromRi], fromRoad.lengthM);
  if (!startAlongEnd.size) return null;
  const endCandidates: Array<{ node: number; alongEnd: number }> = [];
  if (graph.startNode[toRi] >= 0) endCandidates.push({ node: graph.startNode[toRi], alongEnd: 0 });
  if (graph.endNode[toRi] >= 0) endCandidates.push({ node: graph.endNode[toRi], alongEnd: toRoad.lengthM });
  if (!endCandidates.length) return null;

  // Dijkstra from the start nodes over roads + proximity links.
  const adj = buildAdjacency(graph);
  const N = graph.nodes.length;
  const distTo = new Array<number>(N).fill(Infinity);
  const prev = new Array<{ from: number; adj: Adj } | null>(N).fill(null);
  const done = new Array<boolean>(N).fill(false);
  for (const [node, alongEnd] of startAlongEnd) {
    distTo[node] = Math.abs(alongEnd - fromAlong);
  }
  for (let iter = 0; iter < N; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      if (!done[i] && distTo[i] < best) {
        best = distTo[i];
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = true;
    for (const a of adj[u]) {
      const nd = distTo[u] + a.cost;
      if (nd < distTo[a.to]) {
        distTo[a.to] = nd;
        prev[a.to] = { from: u, adj: a };
      }
    }
  }

  let endNode = -1;
  let endAlongEnd = 0;
  let bestTotal = Infinity;
  for (const c of endCandidates) {
    const total = distTo[c.node] + Math.abs(c.alongEnd - toAlong);
    if (total < bestTotal) {
      bestTotal = total;
      endNode = c.node;
      endAlongEnd = c.alongEnd;
    }
  }
  if (endNode < 0 || !Number.isFinite(bestTotal)) return null;

  // Reconstruct the node path start → end. The walk ends at a
  // source node (prev === null) — whichever from-road endpoint
  // the winning path actually left by.
  const chain: Adj[] = [];
  let cur = endNode;
  while (prev[cur]) {
    chain.push(prev[cur]!.adj);
    cur = prev[cur]!.from;
  }
  if (!startAlongEnd.has(cur)) return null; // unreachable after all
  chain.reverse();

  const pts: Vec2[] = [];
  pts.push(...subPath(fromRoad, fromAlong, startAlongEnd.get(cur)!));
  for (const a of chain) {
    if (a.road) {
      pts.push(
        ...subPath(a.road, a.forward ? 0 : a.road.lengthM, a.forward ? a.road.lengthM : 0),
      );
    } else {
      pts.push({ ...graph.nodes[a.to].pos });
    }
  }
  pts.push(...subPath(toRoad, endAlongEnd, toAlong));
  return assemble(pts);
}
