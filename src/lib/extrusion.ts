import type { AnnotationEdge, AnnotationSet } from '../types';
import type { Point2, Point3 } from './geometry';
import { faceYAtLocalXZ, interpolatePoint, segmentIntersectionParameter } from './geometry';
import { triangulateFaceIndices } from './mesh';
import {
  VERTEX_WELD_DISTANCE_M,
  closedPathEdges,
  compactLoop,
  dedupeEdges,
  edgeKey,
  normalizeAnnotations
} from './topology';

const PARAMETER_EPS = 1e-6;
const BOUNDARY_EPS_M = 1e-5;

export interface ExtrudeComponentDownOptions {
  annotations: AnnotationSet;
  selectedFaceIndex: number;
  /** Local scene Y used when no annotated surface lies below the selected face. */
  groundY?: number;
}

export type ExtrudeComponentDownResult =
  | { ok: false; error: string }
  | {
      ok: true;
      annotations: AnnotationSet;
      stats: {
        target: 'surface' | 'ground';
        componentFaces: number;
        boundaryLoops: number;
        supportFaces: number;
        groundSegments: number;
        boundarySplits: number;
        newVertices: number;
        newEdges: number;
        newFaces: number;
        sideFaces: number;
        floorFaces: number;
        closureFaces: number;
        replacedFaces: number;
      };
    };

interface SupportTriangle {
  key: string;
  faceIndex: number;
  points: [Point3, Point3, Point3];
  projected: [Point2, Point2, Point2];
}

interface TopStation {
  incomingId: string;
  incomingPoint: Point3;
  outgoingId: string;
  outgoingPoint: Point3;
}

interface BoundaryEdgeSplit {
  edge: AnnotationEdge;
  path: string[];
}

interface PartitionedBoundaryLoop {
  stations: TopStation[];
  segmentTargets: SupportTarget[];
}

interface BottomBoundarySegment {
  startTopId: string;
  endTopId: string;
  startBottomId: string;
  endBottomId: string;
}

interface PreparedBoundaryLoop {
  stations: TopStation[];
}

interface PreparedBoundaries {
  loops: PreparedBoundaryLoop[];
  closureFaces: string[][];
}

type SupportTarget = SupportTriangle | null;

/**
 * Extrude the complete open surface component containing the selected face.
 * Only component boundary loops grow side panels; shared edges between roof
 * faces remain internal roof edges and never create walls.
 *
 * Boundary edges are split where the lower surface changes. Boundary stations
 * retain both real lower heights across a discontinuity, while equal contacts
 * share one vertex. Side panels follow those vertical chains. An ordinary
 * component gets one bottom polygon from its exterior boundary, so interior
 * roof vertices are never projected down. Rendering and export triangulate
 * that polygon without adding wireframe diagonals.
 */
export function extrudeComponentDown(options: ExtrudeComponentDownOptions): ExtrudeComponentDownResult {
  const normalized = normalizeAnnotations(options.annotations);
  const selectedFace = normalized.faces[options.selectedFaceIndex];
  if (!selectedFace || selectedFace.length < 3) return failure('Select a valid face before extruding.');
  const groundY = options.groundY !== undefined && Number.isFinite(options.groundY) ? options.groundY : undefined;
  const recomputed = removePreviousExtrusion(normalized, options.selectedFaceIndex);
  const source = recomputed.annotations;
  const selectedFaceIndex = recomputed.selectedFaceIndex;

  const positionsById = new Map(source.vertices.map((vertex) => [vertex.id, vertex.position]));
  const componentFaceIndices = connectedFaceComponent(source.faces, selectedFaceIndex);
  const componentFaces = [...componentFaceIndices].sort((left, right) => left - right);
  for (const faceIndex of componentFaces) {
    const face = source.faces[faceIndex];
    if (face.some((id) => !positionsById.has(id))) {
      return failure(`Component face ${faceIndex + 1} references a missing vertex.`);
    }
    if (Math.abs(projectedLoopArea(face, positionsById)) <= 1e-9) {
      return failure(`Component face ${faceIndex + 1} is vertical or degenerate in plan.`);
    }
  }

  const boundaries = componentBoundaryLoops(source.faces, componentFaceIndices);
  if (!boundaries.ok) return failure(boundaries.error);
  const prepared = prepareBoundaryLoops(boundaries.loops, positionsById);
  if (!prepared.ok) return failure(prepared.error);
  for (const loop of prepared.boundaries.loops) {
    for (let index = 0; index < loop.stations.length; index += 1) {
      const station = loop.stations[index];
      const next = loop.stations[(index + 1) % loop.stations.length];
      const start = station.outgoingPoint;
      const end = next.incomingPoint;
      if (Math.hypot(end[0] - start[0], end[2] - start[2]) <= BOUNDARY_EPS_M) {
        return failure(`Component boundary ${station.outgoingId} -> ${next.incomingId} is vertical or degenerate in plan.`);
      }
    }
  }

  const supports = supportTriangles(source, componentFaceIndices, positionsById);
  const generatedTopVertices: AnnotationSet['vertices'] = [];
  const topVertexAt = (position: Point3): { id: string; position: Point3 } => {
    const existing = [...source.vertices, ...generatedTopVertices].find(
      (vertex) => pointDistance(vertex.position, position) <= VERTEX_WELD_DISTANCE_M
    );
    if (existing) return { id: existing.id, position: existing.position };
    const id = newVertexId();
    generatedTopVertices.push({ id, position });
    return { id, position };
  };
  const edgeSplits: BoundaryEdgeSplit[] = [];
  const partitionedLoops: PartitionedBoundaryLoop[] = [];
  for (let loopIndex = 0; loopIndex < prepared.boundaries.loops.length; loopIndex += 1) {
    const loop = prepared.boundaries.loops[loopIndex];
    const stations: TopStation[] = [];
    const segmentTargets: SupportTarget[] = [];
    for (let edgeIndex = 0; edgeIndex < loop.stations.length; edgeIndex += 1) {
      const station = loop.stations[edgeIndex];
      const next = loop.stations[(edgeIndex + 1) % loop.stations.length];
      const startId = station.outgoingId;
      const endId = next.incomingId;
      const start = station.outgoingPoint;
      const end = next.incomingPoint;
      const partition = partitionBoundaryEdge(start, end, supports, groundY);
      if (!partition.ok) return failure(`Component boundary ${loopIndex + 1}, edge ${edgeIndex + 1}: ${partition.error}`);

      const path = [startId];
      for (let interval = 0; interval < partition.targets.length; interval += 1) {
        const t = partition.parameters[interval];
        let split = { id: startId, position: start };
        if (t > PARAMETER_EPS) {
          split = topVertexAt(interpolatePoint(start, end, t));
          if (path.at(-1) !== split.id) path.push(split.id);
          stations.push(normalStation(split.id, split.position));
        } else {
          stations.push(station);
        }
        segmentTargets.push(partition.targets[interval]);
      }
      if (path.at(-1) !== endId) path.push(endId);
      edgeSplits.push({ edge: [startId, endId], path });
    }
    partitionedLoops.push({ stations, segmentTargets });
  }

  const allTargets = partitionedLoops.flatMap((loop) => loop.segmentTargets);
  const splitSourceFaces = splitFacesAlongBoundary(source.faces, edgeSplits);
  const componentTopFaces = componentFaces.map((faceIndex) => splitSourceFaces[faceIndex]);
  const positionsWithSplits = new Map([
    ...source.vertices.map((vertex) => [vertex.id, vertex.position] as const),
    ...generatedTopVertices.map((vertex) => [vertex.id, vertex.position] as const)
  ]);
  const bottomVertices: AnnotationSet['vertices'] = [];
  const bottomIdByTopId = new Map<string, string>();
  const bottomBoundaryByTopEdge = new Map<string, BottomBoundarySegment>();
  // A face loop cannot encode holes or a collapsed folded boundary. Ordinary
  // components need only their exterior bottom loop; those exceptional cases
  // retain the top partition without inventing bridge vertices.
  const mirrorComponentBottom = partitionedLoops.length > 1 || prepared.boundaries.closureFaces.length > 0;
  const supportFaceIndices = new Set(allTargets.flatMap((target) => target ? [target.faceIndex] : []));
  const vertexAt = (position: Point3): string => {
    for (const [id, existing] of positionsWithSplits) {
      if (pointDistance(existing, position) <= VERTEX_WELD_DISTANCE_M) return id;
    }
    const id = newVertexId();
    bottomVertices.push({ id, position });
    positionsWithSplits.set(id, position);
    return id;
  };
  if (mirrorComponentBottom) {
    for (const topId of new Set(componentTopFaces.flat())) {
      const top = positionsWithSplits.get(topId)!;
      const support = highestSupportAt(top, supports);
      let y: number;
      if (support) {
        const supportHeight = supportY(support, top);
        if (supportHeight === null) return failure(`A lower surface is vertical or degenerate below vertex ${topId}.`);
        y = supportHeight;
        supportFaceIndices.add(support.faceIndex);
      } else {
        if (groundY === undefined || groundY > top[1] + VERTEX_WELD_DISTANCE_M) {
          return failure(`No mesh surface or scene ground lies below vertex ${topId}.`);
        }
        y = groundY;
      }
      const bottom: Point3 = [top[0], y, top[2]];
      bottomIdByTopId.set(topId, pointDistance(top, bottom) <= VERTEX_WELD_DISTANCE_M ? topId : vertexAt(bottom));
    }
  }

  const sideFaces: string[][] = [];
  const boundaryFloorFaces: string[][] = [];
  for (const loop of partitionedLoops) {
    const bottomSegments: BottomBoundarySegment[] = [];
    for (let index = 0; index < loop.stations.length; index += 1) {
      const next = (index + 1) % loop.stations.length;
      const startTopId = loop.stations[index].outgoingId;
      const endTopId = loop.stations[next].incomingId;
      const start = positionsWithSplits.get(startTopId)!;
      const end = positionsWithSplits.get(endTopId)!;
      const target = loop.segmentTargets[index];
      const startY = targetBottomY(target, start, groundY);
      const endY = targetBottomY(target, end, groundY);
      if (startY === null || endY === null) {
        return failure('A support surface is vertical or degenerate at the extrusion boundary.');
      }
      const segment = {
        startTopId,
        endTopId,
        startBottomId: pointDistance(start, [start[0], startY, start[2]]) <= VERTEX_WELD_DISTANCE_M
          ? startTopId
          : vertexAt([start[0], startY, start[2]]),
        endBottomId: pointDistance(end, [end[0], endY, end[2]]) <= VERTEX_WELD_DISTANCE_M
          ? endTopId
          : vertexAt([end[0], endY, end[2]])
      };
      bottomSegments.push(segment);
      if (mirrorComponentBottom) bottomBoundaryByTopEdge.set(edgeKey([startTopId, endTopId]), segment);
    }
    const verticalChains = loop.stations.map((station, index) => {
      const incoming = bottomSegments[(index - 1 + bottomSegments.length) % bottomSegments.length];
      const outgoing = bottomSegments[index];
      return verticalChain(
        [station.incomingId, station.outgoingId, incoming.endBottomId, outgoing.startBottomId],
        positionsWithSplits
      );
    });
    for (let index = 0; index < loop.stations.length; index += 1) {
      const next = (index + 1) % loop.stations.length;
      const segment = bottomSegments[index];
      const endDown = verticalSubpath(verticalChains[next], segment.endTopId, segment.endBottomId);
      const startDown = verticalSubpath(verticalChains[index], segment.startTopId, segment.startBottomId);
      const face = usableGeneratedFace(
        [segment.startTopId, ...endDown, ...[...startDown].reverse().slice(0, -1)],
        positionsWithSplits
      );
      if (face) sideFaces.push(face);
    }
    const bottomLoop: string[] = [];
    for (let index = 0; index < bottomSegments.length; index += 1) {
      const current = bottomSegments[index];
      const next = bottomSegments[(index + 1) % bottomSegments.length];
      bottomLoop.push(current.startBottomId);
      if (current.endBottomId !== next.startBottomId) bottomLoop.push(current.endBottomId);
    }
    if (!mirrorComponentBottom) {
      const floor = usableGeneratedFace(bottomLoop.reverse(), positionsWithSplits);
      if (floor) boundaryFloorFaces.push(floor);
    }
  }

  const floorFaces: string[][] = [];
  if (!mirrorComponentBottom) {
    floorFaces.push(...boundaryFloorFaces);
  } else {
    for (let faceIndex = 0; faceIndex < componentTopFaces.length; faceIndex += 1) {
      const topFace = componentTopFaces[faceIndex];
      const bottomEdges = topFace.map((startTopId, index) => {
        const endTopId = topFace[(index + 1) % topFace.length];
        const boundary = bottomBoundaryByTopEdge.get(edgeKey([startTopId, endTopId]));
        if (!boundary) return [bottomIdByTopId.get(startTopId)!, bottomIdByTopId.get(endTopId)!] as const;
        return boundary.startTopId === startTopId
          ? [boundary.startBottomId, boundary.endBottomId] as const
          : [boundary.endBottomId, boundary.startBottomId] as const;
      });
      const bottomLoop: string[] = [];
      for (let index = 0; index < bottomEdges.length; index += 1) {
        const current = bottomEdges[index];
        const next = bottomEdges[(index + 1) % bottomEdges.length];
        bottomLoop.push(current[0]);
        if (current[1] !== next[0]) bottomLoop.push(current[1]);
      }
      const floor = usableGeneratedFace(bottomLoop.reverse(), positionsWithSplits);
      if (floor) floorFaces.push(floor);
    }
  }

  const replacedTopEdgeKeys = new Set(boundaries.loops.flatMap(closedPathEdges).map(edgeKey));
  const retainedEdges = source.edges.filter((edge) => !replacedTopEdgeKeys.has(edgeKey(edge)));
  const faces = [...splitSourceFaces, ...prepared.boundaries.closureFaces];
  const topEdges = edgeSplits.flatMap((split) => pathEdges(split.path));
  const allFaces = [...faces, ...sideFaces, ...floorFaces];

  const annotations = normalizeAnnotations({
    vertices: [...source.vertices, ...generatedTopVertices, ...bottomVertices],
    edges: dedupeEdges([
      ...retainedEdges,
      ...topEdges,
      ...prepared.boundaries.closureFaces.flatMap(closedPathEdges),
      ...sideFaces.flatMap(closedPathEdges),
      ...floorFaces.flatMap(closedPathEdges)
    ]),
    faces: allFaces
  });
  const target = supportFaceIndices.size ? 'surface' : 'ground';
  return {
    ok: true,
    annotations,
    stats: {
      target,
      componentFaces: componentFaces.length,
      boundaryLoops: prepared.boundaries.loops.length,
      supportFaces: supportFaceIndices.size,
      groundSegments: allTargets.filter((target) => target === null).length,
      boundarySplits: generatedTopVertices.length,
      newVertices: annotations.vertices.length - source.vertices.length,
      newEdges: annotations.edges.length - source.edges.length,
      newFaces: sideFaces.length + floorFaces.length + prepared.boundaries.closureFaces.length,
      sideFaces: sideFaces.length,
      floorFaces: floorFaces.length,
      closureFaces: prepared.boundaries.closureFaces.length,
      replacedFaces: recomputed.replacedFaces
    }
  };
}

function supportTriangles(
  annotations: AnnotationSet,
  excludedFaceIndices: Set<number>,
  positionsById: Map<string, Point3>
): SupportTriangle[] {
  const supports: SupportTriangle[] = [];
  annotations.faces.forEach((face, faceIndex) => {
    if (excludedFaceIndices.has(faceIndex)) return;
    const points = face.map((id) => positionsById.get(id));
    if (points.some((point) => !point)) return;
    let triangles: [number, number, number][];
    try {
      triangles = triangulateFaceIndices(points as Point3[]);
    } catch {
      return;
    }
    triangles.forEach(([a, b, c], triangleIndex) => {
      const triangle = [points[a], points[b], points[c]] as [Point3, Point3, Point3];
      const projected = triangle.map((point) => [point[0], point[2]] as Point2) as [Point2, Point2, Point2];
      if (Math.abs(twiceTriangleArea(projected)) <= 1e-9) return;
      if (faceYAtLocalXZ(triangle, projected[0][0], projected[0][1]) === null) return;
      supports.push({ key: `${faceIndex}:${triangleIndex}`, faceIndex, points: triangle, projected });
    });
  });
  return supports;
}

function partitionBoundaryEdge(
  start: Point3,
  end: Point3,
  supports: SupportTriangle[],
  groundY: number | undefined
): { ok: true; parameters: number[]; targets: SupportTarget[] } | { ok: false; error: string } {
  const start2: Point2 = [start[0], start[2]];
  const end2: Point2 = [end[0], end[2]];
  const parameters = [0, 1, ...supportHeightSwitchParameters(start, end, supports)];
  for (const support of supports) {
    for (let index = 0; index < 3; index += 1) {
      const t = segmentIntersectionParameter(start2, end2, support.projected[index], support.projected[(index + 1) % 3]);
      if (t !== null) parameters.push(t);
      const vertexT = pointParameterOnSegment(start2, end2, support.projected[index]);
      if (vertexT !== null) parameters.push(vertexT);
    }
  }
  const raw = uniqueSorted(parameters, start, end);
  const rawTargets: SupportTarget[] = [];
  for (let index = 0; index < raw.length - 1; index += 1) {
    const midpoint = interpolatePoint(start, end, (raw[index] + raw[index + 1]) / 2);
    const support = highestSupportAt(midpoint, supports);
    if (!support && groundY === undefined) {
      return { ok: false, error: 'no mesh surface or scene ground lies below the complete boundary.' };
    }
    rawTargets.push(support);
  }

  const keptParameters = [raw[0]];
  const keptTargets = [rawTargets[0]];
  for (let index = 1; index < rawTargets.length; index += 1) {
    if (sameSupportTarget(rawTargets[index], keptTargets.at(-1)!)) continue;
    keptParameters.push(raw[index]);
    keptTargets.push(rawTargets[index]);
  }
  keptParameters.push(raw.at(-1)!);
  return { ok: true, parameters: keptParameters, targets: keptTargets };
}

function supportHeightSwitchParameters(start: Point3, end: Point3, supports: SupportTriangle[]): number[] {
  const parameters: number[] = [];
  for (let leftIndex = 0; leftIndex < supports.length; leftIndex += 1) {
    const left = supports[leftIndex];
    const leftStartY = supportY(left, start);
    const leftEndY = supportY(left, end);
    if (leftStartY === null || leftEndY === null) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < supports.length; rightIndex += 1) {
      const right = supports[rightIndex];
      if (sameSupportPlane(left, right)) continue;
      const rightStartY = supportY(right, start);
      const rightEndY = supportY(right, end);
      if (rightStartY === null || rightEndY === null) continue;
      const startDelta = leftStartY - rightStartY;
      const endDelta = leftEndY - rightEndY;
      const deltaChange = endDelta - startDelta;
      if (Math.abs(deltaChange) <= 1e-10) continue;
      const t = -startDelta / deltaChange;
      if (t <= PARAMETER_EPS || t >= 1 - PARAMETER_EPS) continue;
      const point = interpolatePoint(start, end, t);
      const projected: Point2 = [point[0], point[2]];
      if (!pointInTriangle(projected, left.projected) || !pointInTriangle(projected, right.projected)) continue;
      const leftY = supportY(left, point);
      const rightY = supportY(right, point);
      if (leftY === null || rightY === null) continue;
      if (leftY > point[1] + VERTEX_WELD_DISTANCE_M || rightY > point[1] + VERTEX_WELD_DISTANCE_M) continue;
      parameters.push(t);
    }
  }
  return parameters;
}

function sameSupportTarget(left: SupportTarget, right: SupportTarget): boolean {
  if (!left || !right) return left === right;
  return left.key === right.key || sameSupportPlane(left, right);
}

/** Include collinear support-boundary endpoints, which line intersection omits. */
function pointParameterOnSegment(start: Point2, end: Point2, point: Point2): number | null {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return null;
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared;
  if (t <= PARAMETER_EPS || t >= 1 - PARAMETER_EPS) return null;
  const projectedX = start[0] + dx * t;
  const projectedZ = start[1] + dz * t;
  return Math.hypot(projectedX - point[0], projectedZ - point[1]) <= BOUNDARY_EPS_M ? t : null;
}

function highestSupportAt(top: Point3, supports: SupportTriangle[]): SupportTriangle | null {
  const point: Point2 = [top[0], top[2]];
  let best: SupportTriangle | null = null;
  let bestY = Number.NEGATIVE_INFINITY;
  for (const support of supports) {
    if (!pointInTriangle(point, support.projected)) continue;
    const y = supportY(support, top);
    // A coincident support is a contact, not something to skip past. Accept a
    // small positive residual too: the construction weld will keep the real
    // top vertex instead of creating an upward or downward sliver.
    if (y === null || y > top[1] + VERTEX_WELD_DISTANCE_M) continue;
    if (y > bestY + 1e-8 || (Math.abs(y - bestY) <= 1e-8 && support.key < (best?.key ?? ''))) {
      best = support;
      bestY = y;
    }
  }
  return best;
}

function supportY(support: SupportTriangle, point: Point3): number | null {
  return faceYAtLocalXZ(support.points, point[0], point[2]);
}

function targetBottomY(target: SupportTarget, point: Point3, groundY: number | undefined): number | null {
  if (target) return supportY(target, point);
  return groundY !== undefined && groundY <= point[1] + VERTEX_WELD_DISTANCE_M ? groundY : null;
}

function verticalChain(ids: string[], positionsById: Map<string, Point3>): string[] {
  return [...new Set(ids)].sort((left, right) => {
    const yDifference = positionsById.get(right)![1] - positionsById.get(left)![1];
    return Math.abs(yDifference) > BOUNDARY_EPS_M ? yDifference : left.localeCompare(right);
  });
}

function verticalSubpath(chain: string[], fromId: string, toId: string): string[] {
  const from = chain.indexOf(fromId);
  const to = chain.indexOf(toId);
  if (from < 0 || to < 0) return [fromId, toId];
  return from <= to ? chain.slice(from, to + 1) : chain.slice(to, from + 1).reverse();
}

function sameSupportPlane(left: SupportTriangle, right: SupportTriangle): boolean {
  return [...left.points, ...right.points].every((point) => {
    const leftY = supportY(left, point);
    const rightY = supportY(right, point);
    return leftY !== null && rightY !== null && Math.abs(leftY - rightY) <= 1e-5;
  });
}

function pointInTriangle(point: Point2, triangle: [Point2, Point2, Point2]): boolean {
  const [a, b, c] = triangle;
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) <= 1e-12) return false;
  const u = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const v = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const w = 1 - u - v;
  return u >= -1e-7 && v >= -1e-7 && w >= -1e-7;
}

function twiceTriangleArea([a, b, c]: [Point2, Point2, Point2]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function uniqueSorted(values: number[], start: Point3, end: Point3): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  const unique = sorted.filter((value, index) => index === 0 || value - sorted[index - 1] > PARAMETER_EPS);
  const kept = [unique[0]];
  for (const value of unique.slice(1, -1)) {
    const point = interpolatePoint(start, end, value);
    const previous = interpolatePoint(start, end, kept.at(-1)!);
    if (pointDistance(point, previous) <= VERTEX_WELD_DISTANCE_M) continue;
    if (pointDistance(point, end) <= VERTEX_WELD_DISTANCE_M) continue;
    kept.push(value);
  }
  kept.push(unique.at(-1)!);
  return kept;
}

/**
 * A face can be added after its neighboring roof has already been extruded.
 * Recover the edge-connected top surface and discard only walls directly
 * hanging from it plus their enclosed bottom cap. Never flood through those
 * walls into another roof or object.
 */
function removePreviousExtrusion(
  source: AnnotationSet,
  selectedFaceIndex: number
): { annotations: AnnotationSet; selectedFaceIndex: number; replacedFaces: number } {
  const positionsById = new Map(source.vertices.map((vertex) => [vertex.id, vertex.position]));
  const surfaceFaces = connectedSurfaceComponent(source.faces, selectedFaceIndex, positionsById);
  const surfaceEdgeKeys = new Set([...surfaceFaces].flatMap((faceIndex) => closedPathEdges(source.faces[faceIndex])).map(edgeKey));
  const wallFaces = new Set<number>();
  source.faces.forEach((face, faceIndex) => {
    if (surfaceFaces.has(faceIndex)) return;
    if (Math.abs(projectedLoopArea(face, positionsById)) > 1e-9) return;
    if (closedPathEdges(face).some((edge) => surfaceEdgeKeys.has(edgeKey(edge)))) wallFaces.add(faceIndex);
  });
  if (!wallFaces.size) return { annotations: source, selectedFaceIndex, replacedFaces: 0 };

  const capFaces = attachedBottomCaps(source.faces, surfaceFaces, wallFaces, positionsById);
  const shellFaces = new Set([...wallFaces, ...capFaces]);

  const retainedFaces: string[][] = [];
  let nextSelectedFaceIndex = -1;
  source.faces.forEach((face, faceIndex) => {
    if (shellFaces.has(faceIndex)) return;
    if (faceIndex === selectedFaceIndex) nextSelectedFaceIndex = retainedFaces.length;
    retainedFaces.push(face);
  });
  if (nextSelectedFaceIndex < 0) return { annotations: source, selectedFaceIndex, replacedFaces: 0 };

  const removedEdgeKeys = new Set([...shellFaces].flatMap((faceIndex) => closedPathEdges(source.faces[faceIndex])).map(edgeKey));
  const retainedEdgeKeys = new Set(retainedFaces.flatMap(closedPathEdges).map(edgeKey));
  const edges = source.edges.filter((edge) => !removedEdgeKeys.has(edgeKey(edge)) || retainedEdgeKeys.has(edgeKey(edge)));
  const removedVertexIds = new Set([...shellFaces].flatMap((faceIndex) => source.faces[faceIndex]));
  const retainedVertexIds = new Set([...retainedFaces.flat(), ...edges.flat()]);
  const vertices = source.vertices.filter((vertex) => !removedVertexIds.has(vertex.id) || retainedVertexIds.has(vertex.id));

  return {
    annotations: { vertices, edges, faces: retainedFaces },
    selectedFaceIndex: nextSelectedFaceIndex,
    replacedFaces: shellFaces.size
  };
}

function attachedBottomCaps(
  faces: string[][],
  surfaceFaces: Set<number>,
  wallFaces: Set<number>,
  positionsById: Map<string, Point3>
): Set<number> {
  const bottomFaces = new Set(
    faces
      .map((face, faceIndex) =>
        !surfaceFaces.has(faceIndex) && !wallFaces.has(faceIndex) && face.length >= 3 &&
        face.every((id) => positionsById.has(id))
          ? faceIndex
          : -1
      )
      .filter((faceIndex) => faceIndex >= 0)
  );
  const facesByEdge = new Map<string, number[]>();
  for (const faceIndex of bottomFaces) {
    for (const edge of closedPathEdges(faces[faceIndex])) {
      const key = edgeKey(edge);
      facesByEdge.set(key, [...(facesByEdge.get(key) ?? []), faceIndex]);
    }
  }
  const wallEdgeKeys = new Set([...wallFaces].flatMap((faceIndex) => closedPathEdges(faces[faceIndex])).map(edgeKey));
  const seeds = [...bottomFaces].filter((faceIndex) => closedPathEdges(faces[faceIndex]).some((edge) => wallEdgeKeys.has(edgeKey(edge))));
  const accepted = new Set<number>();
  const seen = new Set<number>();
  for (const seed of seeds) {
    if (seen.has(seed)) continue;
    const component = new Set([seed]);
    const pending = [seed];
    seen.add(seed);
    while (pending.length) {
      const faceIndex = pending.pop()!;
      for (const edge of closedPathEdges(faces[faceIndex])) {
        for (const neighbor of facesByEdge.get(edgeKey(edge)) ?? []) {
          if (seen.has(neighbor)) continue;
          seen.add(neighbor);
          component.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    if ([...component].every((faceIndex) => projectedFaceInsideSurface(faces[faceIndex], surfaceFaces, faces, positionsById))) {
      for (const faceIndex of component) accepted.add(faceIndex);
    }
  }
  return accepted;
}

function projectedFaceInsideSurface(
  face: string[],
  surfaceFaces: Set<number>,
  faces: string[][],
  positionsById: Map<string, Point3>
): boolean {
  const points = face.map((id) => positionsById.get(id)!).map((point) => [point[0], point[2]] as Point2);
  const center = points.reduce<Point2>((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
  const samples = [...points, [center[0] / points.length, center[1] / points.length] as Point2];
  return samples.every((sample) => [...surfaceFaces].some((faceIndex) => pointInProjectedFace(sample, faces[faceIndex], positionsById)));
}

function pointInProjectedFace(point: Point2, face: string[], positionsById: Map<string, Point3>): boolean {
  const ring = face.map((id) => positionsById.get(id)!).map((position) => [position[0], position[2]] as Point2);
  let inside = false;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const edgeLengthSquared = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    if (edgeLengthSquared > 0) {
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / edgeLengthSquared));
      if (Math.hypot(a[0] + t * (b[0] - a[0]) - point[0], a[1] + t * (b[1] - a[1]) - point[1]) <= BOUNDARY_EPS_M) return true;
    }
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function connectedSurfaceComponent(
  faces: string[][],
  selectedFaceIndex: number,
  positionsById: Map<string, Point3>
): Set<number> {
  const projectable = new Set(
    faces
      .map((face, faceIndex) => Math.abs(projectedLoopArea(face, positionsById)) > 1e-9 ? faceIndex : -1)
      .filter((faceIndex) => faceIndex >= 0)
  );
  if (!projectable.has(selectedFaceIndex)) return new Set([selectedFaceIndex]);

  const facesByEdge = new Map<string, number[]>();
  faces.forEach((face, faceIndex) => {
    if (!projectable.has(faceIndex)) return;
    for (const edge of closedPathEdges(face)) {
      const key = edgeKey(edge);
      facesByEdge.set(key, [...(facesByEdge.get(key) ?? []), faceIndex]);
    }
  });
  const component = new Set([selectedFaceIndex]);
  const pending = [selectedFaceIndex];
  while (pending.length) {
    const faceIndex = pending.pop()!;
    for (const edge of closedPathEdges(faces[faceIndex])) {
      for (const neighbor of facesByEdge.get(edgeKey(edge)) ?? []) {
        if (component.has(neighbor)) continue;
        component.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return component;
}

function connectedFaceComponent(faces: string[][], selectedFaceIndex: number): Set<number> {
  const facesByEdge = new Map<string, number[]>();
  faces.forEach((face, faceIndex) => {
    for (const edge of closedPathEdges(face)) {
      const key = edgeKey(edge);
      facesByEdge.set(key, [...(facesByEdge.get(key) ?? []), faceIndex]);
    }
  });

  const component = new Set([selectedFaceIndex]);
  const pending = [selectedFaceIndex];
  while (pending.length) {
    const faceIndex = pending.pop()!;
    for (const edge of closedPathEdges(faces[faceIndex])) {
      for (const neighbor of facesByEdge.get(edgeKey(edge)) ?? []) {
        if (component.has(neighbor)) continue;
        component.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return component;
}

function prepareBoundaryLoops(
  loops: string[][],
  positionsById: Map<string, Point3>
): { ok: true; boundaries: PreparedBoundaries } | { ok: false; error: string } {
  const preparedLoops: PreparedBoundaryLoop[] = [];
  const closureFaces: string[][] = [];

  for (const loop of loops) {
    const spikeStarts = loop
      .map((_, index) => index)
      .filter((index) => sameProjectedPoint(
        positionsById.get(loop[index])!,
        positionsById.get(loop[(index + 2) % loop.length])!
      ));
    if (!spikeStarts.length) {
      preparedLoops.push({ stations: loop.map((id) => normalStation(id, positionsById.get(id)!)) });
      continue;
    }

    const claimed = new Set<number>();
    for (const start of spikeStarts) {
      for (const index of [start, (start + 1) % loop.length, (start + 2) % loop.length]) {
        if (claimed.has(index)) {
          return { ok: false, error: 'The selected component has overlapping folded boundary spikes.' };
        }
        claimed.add(index);
      }
      const first = positionsById.get(loop[start])!;
      const last = positionsById.get(loop[(start + 2) % loop.length])!;
      if (Math.abs(first[1] - last[1]) <= BOUNDARY_EPS_M) {
        return { ok: false, error: 'The selected component boundary doubles back onto the same 3D edge.' };
      }
    }

    const rotation = spikeStarts[0];
    const ordered = [...loop.slice(rotation), ...loop.slice(0, rotation)];
    const stations: TopStation[] = [];
    let collapsed = 0;
    for (let index = 0; index < ordered.length;) {
      if (
        index + 2 < ordered.length &&
        sameProjectedPoint(positionsById.get(ordered[index])!, positionsById.get(ordered[index + 2])!)
      ) {
        const incomingId = ordered[index];
        const apexId = ordered[index + 1];
        const outgoingId = ordered[index + 2];
        stations.push({
          incomingId,
          incomingPoint: positionsById.get(incomingId)!,
          outgoingId,
          outgoingPoint: positionsById.get(outgoingId)!
        });
        closureFaces.push([incomingId, apexId, outgoingId]);
        collapsed += 1;
        index += 3;
        continue;
      }
      const id = ordered[index];
      stations.push(normalStation(id, positionsById.get(id)!));
      index += 1;
    }
    if (collapsed !== spikeStarts.length) {
      return { ok: false, error: 'The selected component has a folded boundary that cannot be ordered safely.' };
    }
    if (stations.length < 3) {
      return { ok: false, error: 'Collapsing the folded boundary leaves fewer than three exterior stations.' };
    }
    preparedLoops.push({ stations });
  }

  return { ok: true, boundaries: { loops: preparedLoops, closureFaces } };
}

function normalStation(id: string, point: Point3): TopStation {
  return { incomingId: id, incomingPoint: point, outgoingId: id, outgoingPoint: point };
}

function sameProjectedPoint(left: Point3, right: Point3): boolean {
  return Math.hypot(left[0] - right[0], left[2] - right[2]) <= BOUNDARY_EPS_M;
}

function componentBoundaryLoops(
  faces: string[][],
  componentFaceIndices: Set<number>
): { ok: true; loops: string[][] } | { ok: false; error: string } {
  const uses = new Map<string, { edge: AnnotationEdge; count: number }>();
  for (const faceIndex of [...componentFaceIndices].sort((left, right) => left - right)) {
    for (const edge of closedPathEdges(faces[faceIndex])) {
      const key = edgeKey(edge);
      const use = uses.get(key);
      if (use) use.count += 1;
      else uses.set(key, { edge, count: 1 });
    }
  }
  const nonManifold = [...uses.values()].find((use) => use.count > 2);
  if (nonManifold) {
    return { ok: false, error: `The selected component is non-manifold at edge ${nonManifold.edge[0]} -> ${nonManifold.edge[1]}.` };
  }

  const boundaryEdges = [...uses.values()].filter((use) => use.count === 1).map((use) => use.edge);
  if (!boundaryEdges.length) {
    return { ok: false, error: 'The selected component is closed and has no boundary to extrude.' };
  }

  const edgesByVertex = new Map<string, AnnotationEdge[]>();
  for (const edge of boundaryEdges) {
    edgesByVertex.set(edge[0], [...(edgesByVertex.get(edge[0]) ?? []), edge]);
    edgesByVertex.set(edge[1], [...(edgesByVertex.get(edge[1]) ?? []), edge]);
  }
  const branched = [...edgesByVertex].find(([, edges]) => edges.length !== 2);
  if (branched) {
    return {
      ok: false,
      error: `The selected component boundary branches or is open at vertex ${branched[0]} (${branched[1].length} incident boundary edges).`
    };
  }

  const remaining = new Map(boundaryEdges.map((edge) => [edgeKey(edge), edge]));
  const loops: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as AnnotationEdge;
    const start = first[0];
    let current = first[1];
    const loop = [start, current];
    remaining.delete(edgeKey(first));
    while (current !== start) {
      const nextEdges = (edgesByVertex.get(current) ?? []).filter((edge) => remaining.has(edgeKey(edge)));
      if (nextEdges.length !== 1) {
        return { ok: false, error: `Could not order the selected component boundary at vertex ${current}.` };
      }
      const edge = nextEdges[0];
      remaining.delete(edgeKey(edge));
      const next = edge[0] === current ? edge[1] : edge[0];
      if (next !== start) loop.push(next);
      current = next;
      if (loop.length > boundaryEdges.length) {
        return { ok: false, error: 'Could not order the selected component boundary into closed loops.' };
      }
    }
    if (loop.length < 3) return { ok: false, error: 'The selected component has a degenerate boundary loop.' };
    loops.push(loop);
  }
  return { ok: true, loops };
}

function splitFacesAlongBoundary(faces: string[][], splits: BoundaryEdgeSplit[]): string[][] {
  const splitByEdge = new Map(splits.map((split) => [edgeKey(split.edge), split.path]));
  return faces.map((face) => {
    const expanded: string[] = [];
    for (let index = 0; index < face.length; index += 1) {
      const start = face[index];
      const end = face[(index + 1) % face.length];
      expanded.push(start);
      const path = splitByEdge.get(edgeKey([start, end]));
      if (!path || path.length === 2) continue;
      const oriented = path[0] === start ? path : [...path].reverse();
      expanded.push(...oriented.slice(1, -1));
    }
    return expanded;
  });
}

function pathEdges(path: string[]): AnnotationEdge[] {
  return path.slice(0, -1).map((id, index) => [id, path[index + 1]]);
}

function projectedLoopArea(face: string[], positionsById: Map<string, Point3>): number {
  let area = 0;
  for (let index = 0; index < face.length; index += 1) {
    const start = positionsById.get(face[index]);
    const end = positionsById.get(face[(index + 1) % face.length]);
    if (!start || !end) return 0;
    area += start[0] * end[2] - end[0] * start[2];
  }
  return area / 2;
}

function usableGeneratedFace(ids: string[], positionsById: Map<string, Point3>): string[] | null {
  const face = compactLoop(ids);
  if (new Set(face).size < 3) return null;
  const points = face.map((id) => positionsById.get(id));
  if (points.some((point) => !point)) return null;
  for (let index = 0; index < points.length; index += 1) {
    if (pointDistance(points[index]!, points[(index + 1) % points.length]!) <= VERTEX_WELD_DISTANCE_M) return null;
  }
  try {
    triangulateFaceIndices(points as Point3[]);
    return face;
  } catch {
    return null;
  }
}

function pointDistance(left: Point3, right: Point3): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function newVertexId(): string {
  return `v${crypto.randomUUID().slice(0, 8)}`;
}

function failure(error: string): ExtrudeComponentDownResult {
  return { ok: false, error };
}
