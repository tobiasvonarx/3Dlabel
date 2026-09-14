import type { AnnotationEdge, AnnotationSet } from '../types';

/** Geometry below three centimetres is annotation noise, not another corner. */
export const VERTEX_WELD_DISTANCE_M = 0.03;

export interface MergeResult {
  annotations: AnnotationSet;
  idById: Map<string, string>;
  mergedCount: number;
}

export function normalizeAnnotations(source: AnnotationSet): AnnotationSet {
  const merged = remapCoincidentVertices(source);
  const faces = dedupeFaces(
    merged.annotations.faces
      .map(compactLoop)
      .filter((face) => face.length >= 3)
  );
  const edges = dedupeEdges(merged.annotations.edges);
  const normalized = { vertices: merged.annotations.vertices, edges, faces };
  return sameAnnotations(source, normalized) ? source : normalized;
}

/** Prefer a chosen ID when an explicit drag completes at an existing vertex. */
export function mergeCoincidentVertices(
  source: AnnotationSet,
  preferVertex: (id: string) => boolean = () => false
): MergeResult {
  const merged = remapCoincidentVertices(source, preferVertex);
  if (!merged.mergedCount) return merged;
  return { ...merged, annotations: normalizeAnnotations(merged.annotations) };
}

export function findCoincidentVertexId(
  source: AnnotationSet,
  position: [number, number, number]
): string | null {
  return source.vertices.find((vertex) => pointDistance(vertex.position, position) <= VERTEX_WELD_DISTANCE_M)?.id ?? null;
}

function remapCoincidentVertices(
  source: AnnotationSet,
  preferVertex: (id: string) => boolean = () => false
): MergeResult {
  const groups: AnnotationSet['vertices'][] = [];
  for (const vertex of source.vertices) {
    // Require the whole cluster to fit inside the weld tolerance. This avoids
    // a chain of individually close points collapsing a meaningful longer edge.
    const group = groups.find((candidate) =>
      candidate.every((existing) => pointDistance(existing.position, vertex.position) <= VERTEX_WELD_DISTANCE_M)
    );
    if (group) group.push(vertex);
    else groups.push([vertex]);
  }

  const idById = new Map<string, string>();
  const retained = new Set<string>();
  let mergedCount = 0;
  for (const group of groups) {
    const canonical = group.find((vertex) => preferVertex(vertex.id)) ?? group[0];
    retained.add(canonical.id);
    for (const vertex of group) {
      idById.set(vertex.id, canonical.id);
      if (vertex.id !== canonical.id) mergedCount += 1;
    }
  }
  if (!mergedCount) return { annotations: source, idById, mergedCount };

  const remap = (id: string) => idById.get(id) ?? id;
  return {
    annotations: {
      vertices: source.vertices.filter((vertex) => retained.has(vertex.id)),
      edges: source.edges.map(([a, b]) => [remap(a), remap(b)]),
      faces: source.faces.map((face) => face.map(remap))
    },
    idById,
    mergedCount
  };
}

function pointDistance(left: [number, number, number], right: [number, number, number]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

export function splitEdgeAtVertex(
  source: AnnotationSet,
  splitEdge: AnnotationEdge,
  vertexId: string
): AnnotationSet {
  const [a, b] = splitEdge;
  const split = (edge: AnnotationEdge): AnnotationEdge[] =>
    sameUndirectedEdge(edge, splitEdge) ? [[edge[0], vertexId], [vertexId, edge[1]]] : [edge];
  const faces = source.faces.map((face) => {
    if (face.includes(vertexId)) return face;
    const next: string[] = [];
    for (let index = 0; index < face.length; index += 1) {
      const current = face[index];
      const following = face[(index + 1) % face.length];
      next.push(current);
      if ((current === a && following === b) || (current === b && following === a)) next.push(vertexId);
    }
    return next;
  });
  return normalizeAnnotations({
    ...source,
    edges: source.edges.flatMap(split),
    faces
  });
}

export function compactLoop(ids: string[]): string[] {
  const loop = ids.filter((id, index) => id !== ids[index - 1]);
  if (loop.length > 1 && loop[0] === loop.at(-1)) loop.pop();
  return loop;
}

export function closedPathEdges(path: string[]): AnnotationEdge[] {
  if (path.length < 2) return [];
  return path.map((id, index) => [id, path[(index + 1) % path.length]]);
}

export function dedupeEdges(edges: AnnotationEdge[]): AnnotationEdge[] {
  const seen = new Set<string>();
  return edges.filter(([a, b]) => {
    const key = edgeKey([a, b]);
    if (a === b || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasEdge(annotations: AnnotationSet, edge: AnnotationEdge): boolean {
  return annotations.edges.some((candidate) => sameUndirectedEdge(candidate, edge));
}

export function facesUsingEdge(faces: string[][], edge: AnnotationEdge): Set<number> {
  const indices = new Set<number>();
  faces.forEach((face, index) => {
    if (closedPathEdges(face).some((candidate) => sameUndirectedEdge(candidate, edge))) indices.add(index);
  });
  return indices;
}

export function sameUndirectedEdge(left: AnnotationEdge, right: AnnotationEdge): boolean {
  return edgeKey(left) === edgeKey(right);
}

export function edgeKey([a, b]: AnnotationEdge): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function dedupeFaces(faces: string[][]): string[][] {
  const seen = new Set<string>();
  return faces.filter((face) => {
    const key = canonicalLoopKey(face);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalLoopKey(face: string[]): string {
  const rotations = (values: string[]) => values.map((_, index) => [...values.slice(index), ...values.slice(0, index)].join('|'));
  return [...rotations(face), ...rotations([...face].reverse())].sort()[0] ?? '';
}

function sameAnnotations(left: AnnotationSet, right: AnnotationSet): boolean {
  return (
    left.vertices.length === right.vertices.length &&
    left.vertices.every((vertex, index) =>
      vertex.id === right.vertices[index].id &&
      vertex.position.every((value, axis) => value === right.vertices[index].position[axis])
    ) &&
    sameEdges(left.edges, right.edges) &&
    left.faces.length === right.faces.length &&
    left.faces.every((face, index) => face.length === right.faces[index].length && face.every((id, item) => id === right.faces[index][item]))
  );
}

function sameEdges(left: AnnotationEdge[], right: AnnotationEdge[]): boolean {
  return left.length === right.length && left.every((edge, index) => edge[0] === right[index][0] && edge[1] === right[index][1]);
}
